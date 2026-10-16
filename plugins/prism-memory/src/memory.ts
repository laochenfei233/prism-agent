/**
 * Pure retrieval, ranking, hygiene, and rendering for the Prism memory store.
 *
 * Every function here is deterministic and side-effect free, so the injected
 * block is byte-identical for identical inputs. That is a cache requirement,
 * not a style preference: the block lands in the request tail, and an unstable
 * rendering turns every later request into a fresh prefix miss.
 *
 * @module @prism/prism-memory/memory
 */

import type { MemoryRecord } from './domain.ts'
import { layerOf, layerWeight } from './layers.ts'

/** Durable memory kinds, in the order the protocol text names them. */
export const MEMORY_KINDS = ['fact', 'decision', 'pitfall', 'preference', 'procedure'] as const

/** One durable memory kind. */
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/** Durable memory scopes. `conversation` resolves to the owning session id at write time. */
export const MEMORY_SCOPES = ['global', 'project', 'conversation'] as const

/** One durable memory scope. */
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/** Durable statuses. `superseded` and `archived` records stay readable by id and never inject. */
export const MEMORY_STATUSES = ['active', 'pending', 'superseded', 'archived'] as const

/** One durable memory status. */
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

/**
 * Who caused a write. An `operator` write came from the `/memory` command, not
 * the model; an `import` write was read out of another tool's memory files; a
 * `session` write was distilled from a turn's own text without being asked for.
 */
export const MEMORY_ORIGINS = ['model', 'operator', 'session', 'import'] as const

/** One write origin. */
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number]

/** Matches one rendered memory id inside an injected block or an export line. */
export const MEMORY_ID_RE = /\[(mem_[0-9a-f-]{36})\]/g

/** Statuses an automatic recall may inject. */
export const INJECTABLE_STATUS = 'active'

/** Kinds whose retrieval score carries a relevance premium. */
const KIND_WEIGHT: Readonly<Record<MemoryKind, number>> = {
  decision: 1.2,
  pitfall: 1.2,
  preference: 1.1,
  procedure: 1,
  fact: 1,
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

/**
 * Split text into its full token stream, repeats included.
 *
 * ASCII words and numbers become one token each; a CJK run contributes its
 * individual characters plus adjacent bigrams, so a two-character Chinese term
 * matches without a segmenter. Repeats are kept because ranking saturates on
 * term frequency, which a distinct-token view cannot express.
 * @param text - arbitrary record or query text.
 * @returns the tokens, lowercased, in first-appearance order.
 */
export function tokenizeAll(text: string): string[] {
  const tokens: string[] = []
  const lowered = String(text ?? '').toLowerCase()
  for (const match of lowered.matchAll(/[a-z0-9_]+/g)) {
    if (match[0].length > 1) tokens.push(match[0])
  }
  for (const run of lowered.match(/[^\x00-\x7f]+/g) ?? []) {
    const characters = [...run].filter(character => CJK_RE.test(character))
    for (const [index, character] of characters.entries()) {
      tokens.push(character)
      const next = characters[index + 1]
      if (next !== undefined) tokens.push(character + next)
    }
  }
  return tokens
}

/**
 * Split text into comparable tokens.
 *
 * This is the set view of {@link tokenizeAll}, used wherever presence rather
 * than repetition is the question: duplicate detection and tag derivation.
 * @param text - arbitrary record or query text.
 * @returns the distinct tokens, lowercased.
 */
export function tokenize(text: string): Set<string> {
  return new Set(tokenizeAll(text))
}

/**
 * Jaccard similarity of two token sets: shared tokens over the union.
 * @param left - one token set.
 * @param right - the other token set.
 * @returns a ratio in `[0, 1]`; two empty sets are `0`, not `1`.
 */
export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** The searchable text of a record: its claim, its tags, its kind, and its layer. */
function recordText(record: MemoryRecord): string {
  return `${record.text} ${record.tags.join(' ')} ${record.kind} ${layerOf(record)}`
}

/** A record's searchable token set: its text plus its tags, kind, and layer. */
export function recordTokens(record: MemoryRecord): Set<string> {
  return tokenize(recordText(record))
}

/**
 * Term frequencies of arbitrary text under the tokenization ranking uses.
 * @param text - arbitrary record or query text.
 * @returns each token mapped to how many times it occurs.
 */
export function termFrequencies(text: string): Map<string, number> {
  const terms = new Map<string, number>()
  for (const token of tokenizeAll(text)) terms.set(token, (terms.get(token) ?? 0) + 1)
  return terms
}

/** The term frequencies of one record's searchable text. */
export function recordTerms(record: MemoryRecord): Map<string, number> {
  return termFrequencies(recordText(record))
}

/**
 * Whether a record is past its time-to-live at a given instant. Expiry removes
 * a record from ranking and injection but never rewrites it, so the store keeps
 * its audit trail until `maintain` archives it.
 * @param record - the record to test.
 * @param now - current time in epoch milliseconds.
 * @returns true when a deadline exists and has passed.
 */
export function isExpired(record: MemoryRecord, now: number): boolean {
  const expiresAt = record.expiresAt ?? null
  return expiresAt !== null && expiresAt <= now
}

/**
 * Whether a record is live at a given instant: still active and not past its
 * time-to-live.
 * @param record - the record to test.
 * @param now - current time in epoch milliseconds.
 * @returns true when the record may be recalled.
 */
export function isLive(record: MemoryRecord, now: number): boolean {
  return record.status === INJECTABLE_STATUS && !isExpired(record, now)
}

/** Term-frequency saturation, the classic BM25 default. */
const DEFAULT_BM25_K1 = 1.2

/** Document-length normalization, the classic BM25 default. */
const DEFAULT_BM25_B = 0.75

/** Weight carried by a query term the corpus has never seen. */
const UNSEEN_TERM_WEIGHT = 1

/**
 * BM25 inverse document frequency for one term.
 * @param documentFrequency - corpus documents containing the term.
 * @param total - corpus documents.
 * @returns the term's weight; a term present in every document approaches zero.
 */
function bm25Idf(documentFrequency: number, total: number): number {
  return Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5))
}

/**
 * BM25 term contribution, rescaled so that one occurrence inside an
 * average-length document scores exactly `1`.
 *
 * The rescale is what keeps `minInjectScore` meaningful across corpora. Raw BM25
 * is unbounded and corpus-size dependent, so a fixed threshold on it would
 * select a different fraction of every corpus; anchoring "one occurrence, mean
 * length" at `1` makes the floor mean the same thing everywhere. Repetition
 * raises the contribution up to `1 + k1`, and a document longer than the mean
 * lowers it.
 * @param frequency - occurrences of the term in this document.
 * @param length - this document's token count.
 * @param average - the corpus's mean token count per document.
 * @param k1 - term-frequency saturation.
 * @param b - document-length normalization.
 * @returns the term's contribution, in `(0, 1 + k1]`.
 */
function bm25Contribution(
  frequency: number,
  length: number,
  average: number,
  k1: number,
  b: number,
): number {
  const normalization = average > 0 ? 1 - b + b * (length / average) : 1
  return (frequency / (frequency + k1 * normalization)) * (1 + k1)
}

/**
 * Decay a score toward `floor` as the record ages, so equally relevant newer
 * memories rank above stale ones without ever being excluded by age alone.
 * @param createdAt - record creation time in epoch milliseconds.
 * @param now - current time in epoch milliseconds.
 * @returns a multiplier in `[0.7, 1]`.
 */
function recencyWeight(createdAt: number, now: number): number {
  const ageDays = Math.max(0, now - createdAt) / 86_400_000
  return 0.7 + 0.3 * Math.exp(-ageDays / 90)
}

/** One ranked record. */
export interface MemoryHit {
  /** The record this hit ranks. */
  readonly record: MemoryRecord
  /**
   * Threshold-comparable score: the record's saturated BM25 weight over the
   * square root of the query's own weight.
   *
   * The normalization is deliberately the square root rather than the sum. A
   * person's message is long and mostly incidental, so dividing by the query's
   * full weight would make a record that matches the one term that matters score
   * as badly as one that matches nothing — the fraction matched is not the
   * question, the weight matched is.
   */
  readonly score: number
  /** Fraction of the query's distinct terms this record matched at all. */
  readonly coverage: number
  /** The query tokens this record matched. */
  readonly matched: readonly string[]
}

/** Selection inputs for {@link rankRecords}. */
export interface RankOptions {
  /** Scope admission; a record failing this never enters the corpus. */
  readonly isEligible?: (record: MemoryRecord) => boolean
  /** Statuses admitted to ranking. */
  readonly statuses?: readonly MemoryStatus[]
  /** Hard result cap. */
  readonly limit?: number
  /** Current time in epoch milliseconds. */
  readonly now?: number
  /** Optional provenance narrowing: keep only records distilled from this session. */
  readonly sessionId?: string
  /** Term-frequency saturation; higher means repetition keeps paying off longer. */
  readonly k1?: number
  /** Document-length normalization; `0` ignores length, `1` normalizes fully. */
  readonly b?: number
}

/**
 * Rank the corpus against one query by BM25.
 *
 * Three properties make this the retrieval model rather than an approximation of
 * one. A term's weight falls as more records contain it, so a claim is found by
 * what distinguishes it. Repetition inside one record saturates instead of
 * scaling linearly, so a record is not ranked up for saying the same word three
 * times. And a long record is discounted, so a verbatim phrase in a 300-character
 * claim outranks the same phrase buried in a paragraph.
 *
 * The score is normalized by the square root of the query's total term weight,
 * which keeps it comparable against a fixed floor and independent of how long a
 * message the user typed. Kind, layer, recency, reuse, and scope specificity then
 * adjust it by bounded factors. Ties break by `createdAt` descending and then by
 * id, so the order is total and stable.
 * @param records - the corpus to rank.
 * @param query - the literal query text.
 * @param options - scope admission, status filter, provenance filter, result cap, BM25 parameters, and clock.
 * @returns ranked hits, best first, capped at `limit`.
 */
export function rankRecords(
  records: readonly MemoryRecord[],
  query: string,
  options: RankOptions = {},
): MemoryHit[] {
  const {
    isEligible = () => true,
    statuses = [INJECTABLE_STATUS],
    limit = 5,
    now = Date.now(),
    sessionId,
    k1 = DEFAULT_BM25_K1,
    b = DEFAULT_BM25_B,
  } = options
  const queryTerms = termFrequencies(query)
  const eligible = records.filter(record => (
    statuses.includes(record.status)
    && !isExpired(record, now)
    && isEligible(record)
    && (sessionId === undefined || record.evidence.sessionId === sessionId)
  ))
  const documentTerms = eligible.map(recordTerms)
  let totalTokens = 0
  const documentFrequency = new Map<string, number>()
  for (const terms of documentTerms) {
    for (const [token, frequency] of terms) {
      totalTokens += frequency
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }
  const total = documentTerms.length
  const averageLength = total === 0 ? 0 : totalTokens / total
  const weightOf = (token: string): number => {
    const frequency = documentFrequency.get(token)
    return frequency === undefined ? UNSEEN_TERM_WEIGHT : bm25Idf(frequency, total)
  }
  let queryWeight = 0
  for (const token of queryTerms.keys()) queryWeight += weightOf(token)
  const queryNorm = Math.sqrt(Math.max(1, queryWeight))

  const hits: MemoryHit[] = []
  for (const [index, record] of eligible.entries()) {
    const terms = documentTerms[index]
    if (terms === undefined) continue
    if (queryTerms.size === 0) {
      hits.push({ record, score: 0, coverage: 0, matched: [] })
      continue
    }
    let length = 0
    for (const frequency of terms.values()) length += frequency
    let weight = 0
    const matched: string[] = []
    for (const token of queryTerms.keys()) {
      const frequency = terms.get(token)
      if (frequency === undefined) continue
      weight += weightOf(token) * bm25Contribution(frequency, length, averageLength, k1, b)
      matched.push(token)
    }
    if (weight === 0) continue
    const kind = KIND_WEIGHT[record.kind] ?? 1
    const layer = layerWeight(layerOf(record))
    const reuse = Math.min(1.15, 1 + 0.05 * Math.log1p(record.hits))
    const specificity = record.scope === 'global' ? 1 : 1.15
    hits.push({
      record,
      coverage: matched.length / queryTerms.size,
      score: (weight / queryNorm) * kind * layer * reuse * specificity * recencyWeight(record.createdAt, now),
      matched,
    })
  }
  hits.sort((left, right) => (
    right.score - left.score
    || right.record.createdAt - left.record.createdAt
    || (left.record.id < right.record.id ? -1 : 1)
  ))
  return hits.slice(0, limit)
}

/**
 * Near-duplicates of a candidate among the records it could replace: same kind,
 * same scope, eligible, and at or above the similarity floor.
 *
 * This is the write-time half of recall quality. A store that accumulates three
 * phrasings of one decision ranks all three and spends injection budget on
 * near-identical lines; surfacing them at write time lets the caller supersede
 * instead. Nothing is merged here — the caller decides.
 * @param records - the corpus to compare against.
 * @param candidate - the pending kind, scope, and text.
 * @param options - similarity floor, result cap, admission predicate, and clock.
 * @returns near-duplicates, most similar first.
 */
export function findNearDuplicates(
  records: readonly MemoryRecord[],
  candidate: { readonly kind: MemoryKind; readonly scope: MemoryScope; readonly text: string },
  options: {
    readonly threshold: number
    readonly limit?: number
    readonly isEligible?: (record: MemoryRecord) => boolean
    readonly now?: number
    /**
     * Statuses that count as already holding the claim. Omitted, only a live
     * record does — the write path's question. An importer passes every status,
     * because a claim it parked for review is still a claim it has read.
     */
    readonly statuses?: readonly MemoryStatus[]
  },
): { readonly record: MemoryRecord, readonly similarity: number }[] {
  const { threshold, limit = 5, isEligible = () => true, now = Date.now(), statuses } = options
  const candidateTokens = tokenize(candidate.text)
  if (candidateTokens.size === 0) return []
  const found: { record: MemoryRecord, similarity: number }[] = []
  for (const record of records) {
    if (record.kind !== candidate.kind || record.scope !== candidate.scope) continue
    if (!isEligible(record) || isExpired(record, now)) continue
    if (statuses === undefined ? !isLive(record, now) : !statuses.includes(record.status)) continue
    const similarity = jaccard(candidateTokens, tokenize(record.text))
    if (similarity >= threshold) found.push({ record, similarity })
  }
  found.sort((left, right) => (
    right.similarity - left.similarity
    || right.record.createdAt - left.record.createdAt
    || (left.record.id < right.record.id ? -1 : 1)
  ))
  return found.slice(0, limit)
}

/**
 * Derive recall tags for a claim: the tokens shared with nothing else in the
 * corpus rank highest, because they are what distinguishes this record from the
 * ones already stored. Deterministic for one corpus, so a re-run stores the
 * same tags.
 * @param text - the stored claim.
 * @param corpusTokens - token sets of the records already stored.
 * @param limit - maximum tags to derive.
 * @returns distinct lowercase tags, most distinctive first.
 */
export function suggestTags(
  text: string,
  corpusTokens: readonly ReadonlySet<string>[],
  limit: number,
): string[] {
  const tokens = [...tokenize(text)].filter(token => /^[a-z0-9_]+$/.test(token) && token.length >= 4)
  if (tokens.length === 0) return []
  const scored = tokens.map(token => {
    let occurrences = 0
    for (const document of corpusTokens) if (document.has(token)) occurrences += 1
    return { token, occurrences }
  })
  scored.sort((left, right) => (
    left.occurrences - right.occurrences || (left.token < right.token ? -1 : 1)
  ))
  return scored.slice(0, limit).map(entry => entry.token)
}

/** Truncate to a character budget on a word boundary where one is nearby. */
function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars))
  const head = text.slice(0, maxChars - 1)
  const boundary = head.lastIndexOf(' ')
  return `${boundary > maxChars * 0.6 ? head.slice(0, boundary) : head}…`
}

/** One `(layer, kind, scope, date)` line per record, the shape both renderers share. */
function renderLine(record: MemoryRecord, maxChars: number): string {
  const date = new Date(record.createdAt).toISOString().slice(0, 10)
  return `[${record.id}] (${layerOf(record)}, ${record.kind}, ${record.scope}, ${date}) ${clip(record.text, maxChars)}`
}

/**
 * Render the L0 index: how many memories exist per kind plus the most recently
 * written active entries. Stable ordering, hard character cap.
 * @param records - the corpus to summarize.
 * @param options - line budget and character budget.
 * @returns the index text, or an empty string when no active memory exists.
 */
export function renderIndex(
  records: readonly MemoryRecord[],
  options: { readonly maxEntries?: number, readonly maxChars?: number } = {},
): string {
  const { maxEntries = 8, maxChars = 600 } = options
  const now = Date.now()
  const active = records.filter(record => isLive(record, now))
  if (active.length === 0) return ''
  const counts = new Map<MemoryKind, number>()
  const layers = new Map<string, number>()
  for (const record of active) {
    counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1)
    const layer = layerOf(record)
    layers.set(layer, (layers.get(layer) ?? 0) + 1)
  }
  const buckets = MEMORY_KINDS
    .filter(kind => counts.has(kind))
    .map(kind => `${kind}=${counts.get(kind) ?? 0}`)
    .join(' ')
  const layerBuckets = [...layers.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .map(([layer, count]) => `${layer}=${count}`)
    .join(' ')
  const recent = [...active]
    .sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : 1))
    .slice(0, maxEntries)
    .map(record => renderLine(record, 120))
  return clip([`memories: ${active.length} (${buckets})`, `layers: ${layerBuckets}`, ...recent].join('\n'), maxChars)
}

/**
 * Render the injected recall block: one bounded line per hit inside a fixed
 * frame. The frame is constant, so the same hits always produce the same bytes.
 * @param hits - ranked hits from {@link rankRecords}.
 * @param options - rendered line budget and character budget.
 * @returns the block text, or an empty string when there is nothing to inject.
 */
export function renderRecall(
  hits: readonly MemoryHit[],
  options: { readonly maxChars?: number, readonly lineChars?: number } = {},
): string {
  const { maxChars = 1200, lineChars = 220 } = options
  if (hits.length === 0) return ''
  const lines = hits.map(hit => renderLine(hit.record, lineChars))
  const body = clip(lines.join('\n'), Math.max(0, maxChars - 200))
  return [
    '<prism-memory>',
    body,
    '</prism-memory>',
    'Recalled from long-term memory. Treat as background: verify before relying on it,',
    'and call memory_search or memory_open when the exact record matters.',
  ].join('\n')
}

/**
 * Read back the memory ids a previously injected recall block names, so one
 * session never re-receives the same record. Ids are parsed from the injected
 * text because the durable message source carries no private fields; only
 * `<prism-memory>` recall frames count, so a resident index does not consume
 * the records it merely lists.
 * @param texts - the injected message's text blocks.
 * @returns the named ids in first-appearance order.
 */
export function extractInjectedIds(texts: readonly string[]): string[] {
  const ids: string[] = []
  for (const text of texts) {
    const open = text.indexOf('<prism-memory>')
    if (open < 0) continue
    const close = text.indexOf('</prism-memory>', open)
    const frame = text.slice(open, close < 0 ? undefined : close)
    for (const match of frame.matchAll(MEMORY_ID_RE)) {
      const id = match[1]
      if (id !== undefined) ids.push(id)
    }
  }
  return ids
}

/** One conversation bucket: the records distilled from a single session. */
export interface ConversationBucket {
  /** Owning session id, or `null` for operator writes that name no session. */
  readonly sessionId: string | null
  /** Live records in this bucket. */
  readonly liveCount: number
  /** Every visible record in this bucket, including superseded and archived ones. */
  readonly totalCount: number
  /** Record count per kind, restricted to the named kinds present. */
  readonly kinds: readonly { readonly kind: MemoryKind, readonly count: number }[]
  /** Newest `updatedAt` in this bucket. */
  readonly latestAt: number
  /** Newest live records, newest first, for a one-line browse view. */
  readonly recent: readonly MemoryRecord[]
}

/**
 * Group the caller-visible corpus by originating conversation.
 *
 * This is the browse primitive a keyword or vector search cannot replace: "the
 * conclusion from that conversation we had about X" names a conversation, not a
 * phrase, so recall needs a way to enumerate and then narrow to one.
 * @param records - the caller-visible corpus.
 * @param options - current time, buckets to return, and recent records per bucket.
 * @returns buckets ordered by recency, newest first.
 */
export function groupConversations(
  records: readonly MemoryRecord[],
  options: { readonly now?: number, readonly limit?: number, readonly recentPerBucket?: number } = {},
): ConversationBucket[] {
  const { now = Date.now(), limit = 20, recentPerBucket = 3 } = options
  const grouped = new Map<string | null, MemoryRecord[]>()
  for (const record of records) {
    const key = record.evidence.sessionId;
    const bucket = grouped.get(key)
    if (bucket === undefined) grouped.set(key, [record])
    else bucket.push(record)
  }
  const buckets: ConversationBucket[] = []
  for (const [sessionId, members] of grouped) {
    const counts = new Map<MemoryKind, number>()
    let liveCount = 0
    let latestAt = 0
    for (const record of members) {
      if (isLive(record, now)) {
        liveCount += 1
        counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1)
      }
      if (record.updatedAt > latestAt) latestAt = record.updatedAt
    }
    const kinds = MEMORY_KINDS
      .filter(kind => counts.has(kind))
      .map(kind => ({ kind, count: counts.get(kind) ?? 0 }))
    const recent = [...members]
      .filter(record => isLive(record, now))
      .sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : 1))
      .slice(0, recentPerBucket)
    buckets.push({ sessionId, liveCount, totalCount: members.length, kinds, latestAt, recent })
  }
  buckets.sort((left, right) => (
    right.latestAt - left.latestAt || compareNullable(left.sessionId, right.sessionId)
  ))
  return buckets.slice(0, limit)
}

/** Total order over nullable session ids, so bucket ordering never depends on insertion. */
function compareNullable(left: string | null, right: string | null): number {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left < right ? -1 : 1
}

/**
 * Render conversation buckets for the model: one line per conversation with its
 * counts and newest claims, bounded by a character budget.
 * @param buckets - buckets from {@link groupConversations}.
 * @param options - character budget and per-bucket line budget.
 * @returns the rendered list, or an empty string when no bucket exists.
 */
export function renderConversations(
  buckets: readonly ConversationBucket[],
  options: { readonly maxChars?: number, readonly lineChars?: number } = {},
): string {
  const { maxChars = 2000, lineChars = 140 } = options
  if (buckets.length === 0) return ''
  const lines: string[] = []
  for (const bucket of buckets) {
    const label = bucket.sessionId ?? '(no session)'
    const kinds = bucket.kinds.map(entry => `${entry.kind}=${entry.count}`).join(' ')
    lines.push(`${label} — ${bucket.liveCount} live / ${bucket.totalCount} total${kinds === '' ? '' : ` (${kinds})`}`)
    for (const record of bucket.recent) {
      lines.push(`  [${record.id}] (${record.kind}) ${clip(record.text, lineChars)}`)
    }
  }
  return clip(lines.join('\n'), maxChars)
}

/**
 * Render the durable Markdown mirror of the store.
 *
 * The mirror is the audit and migration surface: readable without the Harness,
 * commit-able, and diff-able. It carries no generation timestamp, so an
 * unchanged corpus produces unchanged bytes and a `git diff` shows only real
 * memory changes.
 * @param records - every stored record.
 * @param options - current time in epoch milliseconds.
 * @returns the Markdown document and its machine-readable companion.
 */
export function renderExport(
  records: readonly MemoryRecord[],
  options: { readonly now?: number } = {},
): { readonly markdown: string, readonly index: string } {
  const now = options.now ?? Date.now()
  const ordered = [...records].sort((left, right) => (
    (left.scope < right.scope ? -1 : left.scope > right.scope ? 1 : 0)
    || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0)
    || right.createdAt - left.createdAt
    || (left.id < right.id ? -1 : 1)
  ))
  const counts = new Map<MemoryStatus, number>()
  for (const record of records) counts.set(record.status, (counts.get(record.status) ?? 0) + 1)
  const summary = MEMORY_STATUSES
    .filter(status => counts.has(status))
    .map(status => `${status} ${counts.get(status) ?? 0}`)
    .join(' · ')
  const lines: string[] = [
    '# Prism long-term memory',
    '',
    'Deterministic mirror of the `prism_memory` store. An unchanged corpus renders',
    'unchanged bytes, so this file is safe to commit and to diff.',
    '',
    `Total: ${records.length} record(s)${summary === '' ? '' : ` — ${summary}`}.`,
  ]
  let scope: MemoryScope | undefined
  let kind: MemoryKind | undefined
  for (const record of ordered) {
    if (record.scope !== scope) {
      scope = record.scope
      kind = undefined
      lines.push('', `## Scope: ${scope}`, '', `Scope key: \`${record.scopeKey}\``)
    }
    if (record.kind !== kind) {
      kind = record.kind
      lines.push('', `### ${kind}`)
    }
    lines.push('', `- \`${record.id}\` **${record.status}** — layer ${layerOf(record)}, confidence ${record.confidence}, hits ${record.hits}`)
    lines.push(`  - created ${iso(record.createdAt)} · updated ${iso(record.updatedAt)} · valid ${iso(record.validAt)} · invalid ${iso(record.invalidAt)} · expires ${iso(record.expiresAt ?? null)} · due ${iso(record.dueAt ?? null)}`)
    lines.push(`  - tags: ${record.tags.length === 0 ? '(none)' : record.tags.map(tag => `\`${tag}\``).join(', ')}`)
    lines.push(`  - evidence: session=${record.evidence.sessionId ?? 'none'} message=${record.evidence.messageId ?? 'none'} note=${record.evidence.note ?? 'none'}`)
    if (record.supersedes !== null) lines.push(`  - supersedes: \`${record.supersedes}\``)
    if (record.supersededBy !== null) lines.push(`  - superseded by: \`${record.supersededBy}\``)
    if ((record.mergedInto ?? null) !== null) lines.push(`  - merged into: \`${record.mergedInto ?? ''}\``)
    lines.push(`  - live: ${isLive(record, now) ? 'yes' : 'no'}`)
    lines.push('', `  ${record.text}`)
  }
  const index = JSON.stringify({
    version: 1,
    total: records.length,
    countsByStatus: Object.fromEntries(MEMORY_STATUSES.map(status => [status, counts.get(status) ?? 0])),
    records: ordered.map(record => ({
      id: record.id,
      scope: record.scope,
      scopeKey: record.scopeKey,
      kind: record.kind,
      layer: layerOf(record),
      status: record.status,
      confidence: record.confidence,
      tags: record.tags,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      validAt: record.validAt,
      invalidAt: record.invalidAt,
      expiresAt: record.expiresAt ?? null,
      dueAt: record.dueAt ?? null,
      supersedes: record.supersedes,
      supersededBy: record.supersededBy,
      mergedInto: record.mergedInto ?? null,
      origin: record.origin ?? null,
      hits: record.hits,
      evidence: record.evidence,
      text: record.text,
    })),
  }, null, 2)
  return { markdown: `${lines.join('\n')}\n`, index: `${index}\n` }
}

/** ISO-8601 date, or `none` for an absent stamp. */
function iso(value: number | null): string {
  return value === null ? 'none' : new Date(value).toISOString().slice(0, 10)
}
