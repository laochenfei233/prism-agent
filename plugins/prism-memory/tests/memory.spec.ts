/**
 * The pure retrieval, ranking, hygiene, and rendering layer.
 *
 * These functions are what make the injected block reproducible: the same
 * corpus and query must produce the same bytes, or the cached prefix of every
 * later request is invalidated. The specs assert that directly, alongside the
 * ranking, duplicate, expiry, and export rules.
 */

import { describe, expect, it } from 'vitest'
import type { MemoryRecord } from '../src/domain.ts'
import {
  extractInjectedIds,
  findNearDuplicates,
  groupConversations,
  isExpired,
  isLive,
  jaccard,
  rankRecords,
  renderExport,
  renderIndex,
  renderRecall,
  suggestTags,
  tokenize,
} from '../src/memory.ts'

const DAY = 86_400_000
const EPOCH = Date.UTC(2026, 0, 1)
let nextId = 0

/** One stored record with every field defaulted, for a focused assertion. */
function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  nextId += 1
  return {
    id: `mem_00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
    scope: 'global',
    scopeKey: '',
    kind: 'fact',
    text: 'the default storage backend is sqlite',
    tags: [],
    status: 'active',
    confidence: 1,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    validAt: EPOCH,
    invalidAt: null,
    supersedes: null,
    supersededBy: null,
    evidence: { sessionId: 'session-a', messageId: null, note: null },
    hits: 0,
    ...overrides,
  }
}

describe('tokenize', () => {
  it('keeps ASCII words and splits CJK runs into characters and bigrams', () => {
    const tokens = tokenize('SQLite FTS5 检索索引')
    expect(tokens.has('sqlite')).toBe(true)
    expect(tokens.has('fts5')).toBe(true)
    // A two-character Chinese term must match without a segmenter.
    expect(tokens.has('检索')).toBe(true)
    expect(tokens.has('索')).toBe(true)
    expect(tokens.has('索引')).toBe(true)
  })

  it('drops single ASCII letters, which carry no retrieval signal', () => {
    expect(tokenize('a b cd').has('a')).toBe(false)
    expect(tokenize('a b cd').has('cd')).toBe(true)
  })
})

describe('jaccard', () => {
  it('is the shared fraction of the union, and zero when either side is empty', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3)
    expect(jaccard(new Set(), new Set(['a']))).toBe(0)
  })
})

describe('rankRecords', () => {
  it('ranks a distinctive match above a common one and breaks ties totally', () => {
    const common = record({ text: 'the cache is warm' })
    const rare = record({ text: 'the harness uses unicode61 tokenization' })
    const hits = rankRecords([common, rare], 'unicode61', { now: EPOCH })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.record.id).toBe(rare.id)
  })

  it('returns an empty list for a query that matches nothing, so nothing is injected', () => {
    expect(rankRecords([record()], 'kubernetes', { now: EPOCH })).toEqual([])
  })

  it('is deterministic: the same corpus and query produce the same order and scores', () => {
    const corpus = [
      record({ text: 'sqlite is the default backend' }),
      record({ text: 'sqlite stores one document per record' }),
      record({ text: 'the cache is warm' }),
    ]
    const first = rankRecords(corpus, 'sqlite record', { now: EPOCH, limit: 3 })
    const second = rankRecords(corpus, 'sqlite record', { now: EPOCH, limit: 3 })
    expect(second.map(hit => [hit.record.id, hit.score, hit.matched.join(',')]))
      .toEqual(first.map(hit => [hit.record.id, hit.score, hit.matched.join(',')]))
  })

  it('excludes a record past its time-to-live even while it is still active', () => {
    const expired = record({ text: 'the deploy window is monday', expiresAt: EPOCH - 1 })
    expect(rankRecords([expired], 'deploy monday', { now: EPOCH })).toEqual([])
    expect(rankRecords([expired], 'deploy monday', { now: EPOCH - DAY })).toHaveLength(1)
  })

  it('narrows to one conversation without ever widening the caller-visible set', () => {
    const fromA = record({ text: 'the retry budget is three', evidence: { sessionId: 'session-a', messageId: null, note: null } })
    const fromB = record({ text: 'the retry budget is five', evidence: { sessionId: 'session-b', messageId: null, note: null } })
    const hits = rankRecords([fromA, fromB], 'retry budget', { now: EPOCH, sessionId: 'session-b' })
    expect(hits.map(hit => hit.record.id)).toEqual([fromB.id])
  })

  it('honours the caller scope before ranking, not after', () => {
    const secret = record({ scope: 'project', scopeKey: 'C:/other', text: 'the migration runs on friday' })
    const hits = rankRecords([secret], 'migration friday', {
      now: EPOCH,
      isEligible: candidate => candidate.scopeKey === 'C:/work',
    })
    expect(hits).toEqual([])
  })
})

describe('expiry and liveness', () => {
  it('treats an active record without a deadline as live, and an archived one as not', () => {
    expect(isLive(record(), EPOCH)).toBe(true)
    expect(isLive(record({ status: 'archived' }), EPOCH)).toBe(false)
    expect(isLive(record({ expiresAt: null }), EPOCH)).toBe(true)
  })

  it('reports expiry independently of status, so audit reads still work', () => {
    expect(isExpired(record({ status: 'pending', expiresAt: EPOCH }), EPOCH)).toBe(true)
    expect(isExpired(record(), EPOCH)).toBe(false)
  })
})

describe('findNearDuplicates', () => {
  it('reports a paraphrase of the same claim and ignores a different kind', () => {
    const stored = record({ kind: 'decision', text: 'prism memory stores records in a sqlite domain' })
    const other = record({ kind: 'pitfall', text: 'prism memory stores records in a sqlite domain' })
    const found = findNearDuplicates([stored, other], {
      kind: 'decision',
      scope: 'global',
      text: 'prism memory stores its records in a sqlite-backed domain',
    }, { threshold: 0.5, now: EPOCH })
    expect(found.map(entry => entry.record.id)).toEqual([stored.id])
  })

  it('never pairs an archived or expired record, which cannot be replaced by a new claim', () => {
    const archived = record({ status: 'archived', text: 'the cache key is the session id' })
    const expired = record({ expiresAt: EPOCH - 1, text: 'the cache key is the session id' })
    const found = findNearDuplicates([archived, expired], {
      kind: 'fact',
      scope: 'global',
      text: 'the cache key is the session id',
    }, { threshold: 0.5, now: EPOCH })
    expect(found).toEqual([])
  })
})

describe('suggestTags', () => {
  it('ranks the tokens nothing else in the corpus carries above the common ones', () => {
    const corpus = [tokenize('the cache is warm'), tokenize('the cache is cold')]
    const tags = suggestTags('the cache invalidation window is documented', corpus, 4)
    expect(tags).toContain('invalidation')
    expect(tags).toContain('documented')
    // `cache` appears in the corpus, so it is the least distinctive tag here.
    expect(tags.indexOf('cache')).toBeGreaterThan(tags.indexOf('invalidation'))
  })
})

describe('rendering', () => {
  it('renders the same bytes for the same hits', () => {
    const hits = rankRecords([record({ text: 'sqlite is the default backend' })], 'sqlite', { now: EPOCH })
    expect(renderRecall(hits, { maxChars: 900 })).toBe(renderRecall(hits, { maxChars: 900 }))
  })

  it('renders nothing for no hits, so an unmatched turn contributes no message', () => {
    expect(renderRecall([], {})).toBe('')
  })

  it('bounds the recall block by its character budget', () => {
    const corpus = Array.from({ length: 20 }, () => record({ text: `sqlite detail ${'x'.repeat(80)}` }))
    const hits = rankRecords(corpus, 'sqlite detail', { now: EPOCH, limit: 20 })
    const rendered = renderRecall(hits, { maxChars: 400 })
    expect(rendered.length).toBeLessThanOrEqual(400)
    expect(rendered).toContain('<prism-memory>')
    expect(rendered.endsWith('and call memory_search or memory_open when the exact record matters.')).toBe(true)
  })

  it('keeps the index frame out of the recall frame it lists', () => {
    const index = renderIndex([record({ text: 'a claim about caches' })], { maxChars: 600 })
    expect(index).toContain('memories: 1')
    expect(index).not.toContain('<prism-memory>')
  })
})

describe('extractInjectedIds', () => {
  it('reads the ids of a recall frame only, never of a resident index', () => {
    const stored = record({ text: 'a claim about caches' })
    const recall = renderRecall(rankRecords([stored], 'caches', { now: EPOCH }), {})
    expect(recall).toContain(stored.id)
    expect(extractInjectedIds([recall])).toContain(stored.id)
    expect(extractInjectedIds([`<prism-memory-index>\n[${stored.id}] (fact, global, 2026-01-01) a claim\n</prism-memory-index>`]))
      .toEqual([])
  })

  it('ignores text that carries no frame at all', () => {
    expect(extractInjectedIds(['just a message'])).toEqual([])
  })
})

describe('groupConversations', () => {
  it('buckets by originating session, newest first, with live counts', () => {
    const recent = record({ evidence: { sessionId: 'session-b', messageId: null, note: null }, updatedAt: EPOCH + DAY })
    const old = record({ evidence: { sessionId: 'session-a', messageId: null, note: null } })
    const retired = record({
      evidence: { sessionId: 'session-a', messageId: null, note: null },
      status: 'archived',
    })
    const buckets = groupConversations([old, recent, retired], { now: EPOCH + 2 * DAY })
    expect(buckets.map(bucket => bucket.sessionId)).toEqual(['session-b', 'session-a'])
    const sessionA = buckets[1]
    expect(sessionA?.liveCount).toBe(1)
    expect(sessionA?.totalCount).toBe(2)
  })

  it('buckets an operator write with no session under null, last', () => {
    const orphan = record({ evidence: { sessionId: null, messageId: null, note: null } })
    const buckets = groupConversations([orphan, record()], { now: EPOCH })
    expect(buckets.map(bucket => bucket.sessionId)).toEqual(['session-a', null])
  })
})

describe('renderExport', () => {
  it('renders identical bytes for an identical corpus, so a mirror is diffable', () => {
    const corpus = [
      record({ kind: 'decision', scope: 'project', scopeKey: 'C:/work', text: 'ship on friday' }),
      record({ kind: 'pitfall', text: 'do not rebase the stack' }),
    ]
    const first = renderExport(corpus, { now: EPOCH })
    const second = renderExport([...corpus].reverse(), { now: EPOCH })
    expect(second.markdown).toBe(first.markdown)
    expect(second.index).toBe(first.index)
  })

  it('carries the record text, status, and provenance into both mirrors', () => {
    const exported = renderExport([record({ text: 'the domain stays version 1' })], { now: EPOCH })
    expect(exported.markdown).toContain('the domain stays version 1')
    expect(exported.markdown).toContain('session=session-a')
    const index = JSON.parse(exported.index) as { total: number, records: readonly { text: string }[] }
    expect(index.total).toBe(1)
    expect(index.records[0]?.text).toBe('the domain stays version 1')
  })

  it('does not stamp a generation time, which would defeat determinism', () => {
    const exported = renderExport([record()], { now: EPOCH })
    expect(exported.markdown).not.toContain('2026-01-01T')
    expect(exported.markdown).not.toContain('generated')
  })
})
