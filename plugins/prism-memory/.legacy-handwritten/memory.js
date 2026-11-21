/**
 * Pure retrieval, ranking, and rendering for the Prism memory store.
 *
 * Every function here is deterministic and side-effect free so the injected
 * block is byte-identical for identical inputs. That is a cache requirement,
 * not a style preference: the block lands in the request tail, and an unstable
 * rendering turns every later request into a fresh prefix miss.
 *
 * @module @prism/prism-memory/memory
 */

/** Durable memory kinds, in the order the protocol text names them. */
export const MEMORY_KINDS = ['fact', 'decision', 'pitfall', 'preference', 'procedure'];

/** Durable memory scopes. `conversation` is resolved to the owning session id at write time. */
export const MEMORY_SCOPES = ['global', 'project', 'conversation'];

/** Durable statuses. `superseded` and `archived` records stay readable by id and never inject. */
export const MEMORY_STATUSES = ['active', 'pending', 'superseded', 'archived'];

/** Matches one rendered memory id inside an injected block. */
export const MEMORY_ID_RE = /\[(mem_[0-9a-f-]{36})\]/g;

/** Kinds whose retrieval score carries a relevance premium. */
const KIND_WEIGHT = { decision: 1.2, pitfall: 1.2, preference: 1.1, procedure: 1, fact: 1 };

/** Statuses eligible for automatic injection. */
export const INJECTABLE_STATUS = 'active';

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/**
 * Split text into comparable tokens.
 *
 * ASCII words and numbers become one token each; a CJK run contributes its
 * individual characters plus adjacent bigrams, so a two-character Chinese term
 * matches without a segmenter.
 * @param text - arbitrary record or query text.
 * @returns the distinct tokens, lowercased.
 */
export function tokenize(text) {
  const tokens = new Set();
  const lowered = String(text ?? '').toLowerCase();
  for (const match of lowered.matchAll(/[a-z0-9_]+/g)) {
    if (match[0].length > 1) tokens.add(match[0]);
  }
  for (const run of lowered.match(/[^\x00-\x7f]+/g) ?? []) {
    const characters = [...run].filter(character => CJK_RE.test(character));
    for (let index = 0; index < characters.length; index += 1) {
      tokens.add(characters[index]);
      if (index + 1 < characters.length) tokens.add(characters[index] + characters[index + 1]);
    }
  }
  return tokens;
}

/**
 * Build the inverse-document-frequency table for one corpus.
 * @param records - every stored record considered for this query.
 * @param documentTokens - each record's tokens, aligned with `records`.
 * @returns term to `ln(1 + N / df)` weights.
 */
function buildIdf(records, documentTokens) {
  const documentFrequency = new Map();
  for (const tokens of documentTokens) {
    for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  const total = Math.max(1, records.length);
  const idf = new Map();
  for (const [token, frequency] of documentFrequency) {
    idf.set(token, Math.log(1 + total / frequency));
  }
  return idf;
}

/** A record's searchable token set: its text plus its tags and kind. */
function recordTokens(record) {
  return tokenize(`${record.text} ${(record.tags ?? []).join(' ')} ${record.kind}`);
}

/**
 * Decay a score toward `floor` as the record ages, so equally relevant newer
 * memories rank above stale ones without ever being excluded by age alone.
 * @param createdAt - record creation time in epoch milliseconds.
 * @param now - current time in epoch milliseconds.
 * @returns a multiplier in `[0.7, 1]`.
 */
function recencyWeight(createdAt, now) {
  const ageDays = Math.max(0, now - createdAt) / 86_400_000;
  return 0.7 + 0.3 * Math.exp(-ageDays / 90);
}

/**
 * Rank the corpus against one query.
 *
 * The base score is the inverse-document-frequency weight the record carries,
 * divided by the square root of the query's total weight, so a long user
 * message is not penalized for the words it shares with nothing while a record
 * matching only common terms stays low. `coverage` reports the undivided
 * fraction for introspection and is not what the threshold compares. Kind,
 * recency, reuse, and scope then adjust the base by bounded factors. Ties break
 * by `createdAt` descending and then by id, so the order is total and stable.
 * @param records - the corpus to rank.
 * @param query - the literal query text.
 * @param options - scope admission, status filter, result cap, and clock.
 * @returns ranked hits with `score`, `coverage`, `record`, and the matched tokens.
 */
export function rankRecords(records, query, options = {}) {
  const { isEligible = () => true, statuses = [INJECTABLE_STATUS], limit = 5, now = Date.now() } = options;
  const queryTokens = tokenize(query);
  const eligible = records.filter(record => statuses.includes(record.status) && isEligible(record));
  const documentTokens = eligible.map(recordTokens);
  const idf = buildIdf(eligible, documentTokens);
  const hits = [];
  let queryWeight = 0;
  for (const token of queryTokens) queryWeight += idf.get(token) ?? 1;
  const queryNorm = Math.sqrt(Math.max(1, queryWeight));
  for (let index = 0; index < eligible.length; index += 1) {
    const record = eligible[index];
    if (queryTokens.size === 0) {
      hits.push({ record, score: 0, coverage: 0, matched: [] });
      continue;
    }
    const tokens = documentTokens[index];
    let weight = 0;
    const matched = [];
    for (const token of queryTokens) {
      if (!tokens.has(token)) continue;
      weight += idf.get(token) ?? 1;
      matched.push(token);
    }
    if (weight === 0) continue;
    const coverage = weight / queryWeight;
    const base = weight / queryNorm;
    const kind = KIND_WEIGHT[record.kind] ?? 1;
    const reuse = Math.min(1.15, 1 + 0.05 * Math.log1p(record.hits ?? 0));
    const specificity = record.scope === 'global' ? 1 : 1.15;
    hits.push({
      record,
      coverage,
      score: base * kind * reuse * specificity * recencyWeight(record.createdAt, now),
      matched,
    });
  }
  hits.sort((left, right) => (
    right.score - left.score
    || right.record.createdAt - left.record.createdAt
    || (left.record.id < right.record.id ? -1 : 1)
  ));
  return hits.slice(0, limit);
}

/** Truncate to a character budget on a word boundary where one is nearby. */
function clip(text, maxChars) {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars));
  const head = text.slice(0, maxChars - 1);
  const boundary = head.lastIndexOf(' ');
  return `${boundary > maxChars * 0.6 ? head.slice(0, boundary) : head}…`;
}

/** One `(kind, date, text)` line per record, the shape both renderers share. */
function renderLine(record, maxChars) {
  const date = new Date(record.createdAt).toISOString().slice(0, 10);
  return `[${record.id}] (${record.kind}, ${record.scope}, ${date}) ${clip(record.text, maxChars)}`;
}

/**
 * Render the L0 index: how many memories exist per kind plus the most recently
 * written active entries. Stable ordering, hard character cap.
 * @param records - the corpus to summarize.
 * @param options - line budget and character budget.
 * @returns the index text, or an empty string when no active memory exists.
 */
export function renderIndex(records, options = {}) {
  const { maxEntries = 8, maxChars = 600 } = options;
  const active = records.filter(record => record.status === INJECTABLE_STATUS);
  if (active.length === 0) return '';
  const counts = new Map();
  for (const record of active) counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
  const buckets = MEMORY_KINDS
    .filter(kind => counts.has(kind))
    .map(kind => `${kind}=${counts.get(kind)}`)
    .join(' ');
  const recent = [...active]
    .sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : 1))
    .slice(0, maxEntries)
    .map(record => renderLine(record, 120));
  return clip([`memories: ${active.length} (${buckets})`, ...recent].join('\n'), maxChars);
}

/**
 * Render the injected recall block: one bounded line per hit inside a fixed
 * frame. The frame is constant, so the same hits always produce the same bytes.
 * @param hits - ranked hits from {@link rankRecords}.
 * @param options - rendered line budget and character budget.
 * @returns the block text, or an empty string when there is nothing to inject.
 */
export function renderRecall(hits, options = {}) {
  const { maxChars = 1200, lineChars = 220 } = options;
  if (hits.length === 0) return '';
  const lines = hits.map(hit => renderLine(hit.record, lineChars));
  const body = clip(lines.join('\n'), Math.max(0, maxChars - 200));
  return [
    '<prism-memory>',
    body,
    '</prism-memory>',
    'Recalled from long-term memory. Treat as background: verify before relying on it,',
    'and call memory_search or memory_open when the exact record matters.',
  ].join('\n');
}

/**
 * Read back the memory ids a previously injected recall block names, so one
 * session never re-receives the same record. Ids are parsed from the injected
 * text because the durable message source carries no private fields; only
 * `<prism-memory>` recall frames count, so a resident index does not consume
 * the records it merely lists.
 * @param content - the injected message's text blocks.
 * @returns the named ids in first-appearance order.
 */
export function extractInjectedIds(content) {
  const ids = [];
  for (const block of content ?? []) {
    if (block?.type !== 'text') continue;
    const text = String(block.text);
    const open = text.indexOf('<prism-memory>');
    if (open < 0) continue;
    const close = text.indexOf('</prism-memory>', open);
    const frame = text.slice(open, close < 0 ? undefined : close);
    for (const match of frame.matchAll(MEMORY_ID_RE)) ids.push(match[1]);
  }
  return ids;
}
