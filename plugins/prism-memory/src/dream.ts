/**
 * Dream consolidation: the periodic pass that reads the corpus back and decides
 * what has become more certain, what belongs together, and what disagrees.
 *
 * It is deliberately not `maintain`. Hygiene is a sweep an operator runs with
 * `apply`; this runs on a window, and what it produces is *knowledge about the
 * corpus* rather than deletions. Three things distinguish it:
 *
 * 1. **Corroboration.** A claim written from several independent conversations
 *    has survived several chances to be wrong. That is evidence the write path
 *    cannot record, because the write path only sees one session.
 * 2. **Topic digests.** Claims that keep returning under one tag become a single
 *    index record, so later recall has one entry point instead of N.
 * 3. **Contradictions.** Two live claims that cover the same subject without
 *    saying the same thing are surfaced for a person to settle. The pass never
 *    resolves them: choosing between two claims is a judgement, and a wrong
 *    automatic choice is worse than an unresolved question.
 *
 * Every function here is pure and deterministic for a fixed corpus and clock, so
 * a replayed store produces the same journal bytes.
 *
 * @module @prism/prism-memory/dream
 */

import type { MemoryRecord } from './domain.ts'
import { layerOf } from './layers.ts'
import { isExpired, isLive, jaccard, tokenize } from './memory.ts'

/** Tag every record this module writes carries, so a journal entry is findable. */
export const DREAM_TAG = 'dream-journal'

/** Tag marking the once-a-day account, as distinct from a consolidation journal. */
export const REFLECTION_TAG = 'dream-reflection'

/** Tag marking a topic digest this module generated. */
export const TOPIC_TAG = 'dream-topic'

/** One topic the corpus keeps returning to. */
export interface TopicDigest {
  /** The shared tag that groups these records. */
  readonly tag: string
  /** Member ids, newest first. */
  readonly memberIds: readonly string[]
  /** The digest's claim: the member summaries, bounded. */
  readonly text: string
}

/** One claim corroborated by more than one conversation. */
export interface Corroboration {
  /** The record that stands. */
  readonly id: string
  /** How many independent conversations have written it, including the first. */
  readonly corroborations: number
}

/** Two live claims that cover the same subject without agreeing. */
export interface Conflict {
  /** The older record. */
  readonly left: string
  /** The newer record. */
  readonly right: string
  /** How much their wording overlaps. */
  readonly similarity: number
}

/** What one consolidation pass proposes. */
export interface DreamPlan {
  /** Records considered as this pass's new material. */
  readonly scanned: number
  /** Claims an independent conversation has corroborated. */
  readonly corroborated: readonly Corroboration[]
  /** Topic digests to write. */
  readonly topics: readonly TopicDigest[]
  /** Unresolved contradictions, for a person to settle. */
  readonly conflicts: readonly Conflict[]
}

/** Inputs of {@link planDream}. */
export interface DreamOptions {
  /** Records this pass treats as new material; the window. */
  readonly candidates: readonly MemoryRecord[]
  /** The whole corpus the candidates are compared against. */
  readonly corpus: readonly MemoryRecord[]
  /** Current time in epoch milliseconds. */
  readonly now: number
  /** Corroborations at or above which a claim counts as corroborated. */
  readonly corroborationFloor: number
  /** Similarity floor for calling two live claims a contradiction. */
  readonly conflictFloor: number
  /** Similarity at or above which two claims are the same claim, not a conflict. */
  readonly duplicateFloor: number
  /** Members a tag needs before it becomes a digest. */
  readonly clusterFloor: number
  /** Maximum digests one pass writes. */
  readonly maxTopics: number
  /** Member claims one digest lists. */
  readonly maxMembers: number
  /** Characters one digest's text may take. */
  readonly maxDigestChars: number
}

/**
 * Order a pair of records so both directions of one comparison agree on which is
 * which. Writing the same pair twice with its members swapped would report one
 * contradiction as two, so the order has to be total: two records written in the
 * same millisecond differ only by id, and that has to break the tie.
 * @param left - one record of the pair.
 * @param right - the other record.
 * @returns the pair, older first, then lower id first.
 */
function olderFirst(left: MemoryRecord, right: MemoryRecord): [MemoryRecord, MemoryRecord] {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? [left, right] : [right, left]
  return left.id <= right.id ? [left, right] : [right, left]
}

/**
 * Decide what one consolidation pass would change.
 *
 * Confirmation is read from `corroborations`, which the write path raises when an
 * identical claim arrives from a different conversation. Contradiction needs two
 * independent signals, because text overlap alone confuses a contradiction with a
 * paraphrase: the records must share a recall tag — so they are about the same
 * subject — while their wording must be similar enough to be comparable and
 * different enough not to be the same claim.
 * @param options - the window, the corpus, the clock, and the thresholds.
 * @returns the proposed corroborations, digests, and conflicts.
 */
export function planDream(options: DreamOptions): DreamPlan {
  const {
    candidates,
    corpus,
    now,
    corroborationFloor,
    conflictFloor,
    duplicateFloor,
    clusterFloor,
    maxTopics,
    maxMembers,
    maxDigestChars,
  } = options
  const corpusTokens = new Map(corpus.map(record => [record.id, tokenize(record.text)]))
  const live = corpus.filter(record => isLive(record, now))
  const liveIds = new Set(live.map(record => record.id))

  const corroborated: Corroboration[] = []
  for (const record of candidates) {
    if (!liveIds.has(record.id)) continue
    const count = (record.corroborations ?? 0) + 1
    if (count < corroborationFloor) continue
    corroborated.push({ id: record.id, corroborations: count })
  }
  corroborated.sort((left, right) => right.corroborations - left.corroborations || (left.id < right.id ? -1 : 1))

  const conflicts: Conflict[] = []
  for (const record of candidates) {
    if (!liveIds.has(record.id)) continue
    const tokens = corpusTokens.get(record.id)
    if (tokens === undefined) continue
    for (const other of live) {
      if (other.id === record.id) continue
      if (layerOf(other) !== layerOf(record) || other.scope !== record.scope) continue
      if (!other.tags.some(tag => record.tags.includes(tag))) continue
      const otherTokens = corpusTokens.get(other.id)
      if (otherTokens === undefined) continue
      const similarity = jaccard(tokens, otherTokens)
      if (similarity < conflictFloor || similarity >= duplicateFloor) continue
      const [left, right] = olderFirst(record, other)
      conflicts.push({ left: left.id, right: right.id, similarity })
    }
  }
  conflicts.sort((left, right) => (
    right.similarity - left.similarity
    || (left.left < right.left ? -1 : 1)
    || (left.right < right.right ? -1 : 1)
  ))
  const seenConflict = new Set<string>()
  const uniqueConflicts = conflicts.filter(conflict => {
    const key = `${conflict.left}|${conflict.right}`
    if (seenConflict.has(key)) return false
    seenConflict.add(key)
    return true
  })

  const byTag = new Map<string, MemoryRecord[]>()
  for (const record of live) {
    for (const tag of record.tags) {
      if (tag === DREAM_TAG || tag === REFLECTION_TAG || tag === TOPIC_TAG) continue
      const members = byTag.get(tag)
      if (members === undefined) byTag.set(tag, [record])
      else members.push(record)
    }
  }
  const topics: TopicDigest[] = [...byTag.entries()]
    .filter(([, members]) => members.length >= clusterFloor)
    .sort((left, right) => right[1].length - left[1].length || (left[0] < right[0] ? -1 : 1))
    .slice(0, maxTopics)
    .map(([tag, members]) => {
      const ordered = [...members].sort((left, right) => (
        right.createdAt - left.createdAt || (left.id < right.id ? -1 : 1)
      ))
      const listed = ordered.slice(0, maxMembers)
      const body = listed.map(record => record.text).join(' | ')
      const text = `Recurring topic "${tag}" (${members.length} claims): ${body}`
      return {
        tag,
        memberIds: listed.map(record => record.id),
        text: text.length <= maxDigestChars ? text : `${text.slice(0, maxDigestChars - 1)}…`,
      }
    })

  return { scanned: candidates.length, corroborated, topics, conflicts: uniqueConflicts }
}

/**
 * Render the pass as one durable journal entry.
 *
 * The entry is deterministic for a fixed plan: no wall-clock stamp, no count of
 * how long the pass took. An unchanged corpus therefore produces unchanged
 * bytes, which is what lets the journal be read as a diff.
 * @param plan - the plan the pass executed.
 * @returns the journal body.
 */
export function renderDreamJournal(plan: DreamPlan): string {
  const lines = [`Dream pass over ${plan.scanned} record(s).`]
  if (plan.corroborated.length > 0) {
    lines.push(`Corroborated by more than one conversation: ${plan.corroborated.map(entry => `${entry.id} (x${entry.corroborations})`).join(', ')}`)
  }
  if (plan.topics.length > 0) {
    lines.push(`Topics indexed: ${plan.topics.map(topic => `${topic.tag} (${topic.memberIds.length})`).join(', ')}`)
  }
  if (plan.conflicts.length > 0) {
    lines.push(`Unresolved contradictions, for a person to settle: ${plan.conflicts.map(conflict => `${conflict.left} vs ${conflict.right} (${conflict.similarity.toFixed(2)})`).join(', ')}`)
  }
  if (lines.length === 1) lines.push('Nothing changed.')
  return lines.join('\n')
}

/**
 * Render a day's account: what the corpus gained, and from where.
 *
 * The window is a *completed* local day, not a running one. A reflection written
 * while the day is still happening would report a number that keeps changing,
 * which is not a log; reflecting on yesterday is what makes the entry final the
 * moment it is written.
 * @param records - the whole corpus.
 * @param options - the half-open window of the day being reported.
 * @returns the reflection body.
 */
export function renderReflection(
  records: readonly MemoryRecord[],
  options: { readonly since: number, readonly until: number },
): string {
  const { since, until } = options
  const written = records.filter(record => record.createdAt > since && record.createdAt <= until)
  const live = records.filter(record => isLive(record, until))
  const sessions = new Set<string>()
  for (const record of written) {
    if (record.evidence.sessionId !== null) sessions.add(record.evidence.sessionId)
  }
  const layers = new Map<string, number>()
  for (const record of written) {
    const layer = layerOf(record)
    layers.set(layer, (layers.get(layer) ?? 0) + 1)
  }
  const byLayer = [...layers.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .map(([layer, count]) => `${layer}=${count}`)
    .join(' ')
  const pending = records.filter(record => record.status === 'pending' && !isExpired(record, until)).length
  return [
    `Daily reflection: ${localDate(since)}.`,
    `Written that day: ${written.length} claim(s) from ${sessions.size} conversation(s)${byLayer === '' ? '' : ` (${byLayer})`}.`,
    `Corpus since: ${live.length} live, ${pending} awaiting review.`,
  ].join('\n')
}

/**
 * Format an instant as its local calendar date.
 *
 * The reflection names the day it reports, and that day is defined by the local
 * clock. Formatting the instant as UTC would name the wrong day on any machine
 * whose offset crosses midnight.
 * @param epoch - the instant to format.
 * @returns the local date as `YYYY-MM-DD`.
 */
function localDate(epoch: number): string {
  const date = new Date(epoch)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
