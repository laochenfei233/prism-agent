/**
 * The layer axis and the pure retrieval and hygiene helpers over it.
 *
 * These specs pin the properties the design depends on rather than the numbers:
 * a record that declares no layer must keep behaving exactly as it did before the
 * axis existed, a repeated term must stop paying off, a longer record must be
 * discounted, and a query's own length must not decide whether a strong match is
 * recalled at all.
 */

import { describe, expect, it } from 'vitest'
import type { MemoryRecord } from '../src/domain.ts'
import {
  assertIdentityLayers,
  DEFAULT_LAYER,
  kindForLayer,
  LAYER_GLOSS,
  layerOf,
  layerWeight,
  MEMORY_LAYERS,
  SHIPPED_IDENTITY_LAYERS,
} from '../src/layers.ts'
import { rankRecords, termFrequencies, tokenize, tokenizeAll } from '../src/memory.ts'

const EPOCH = 1_700_000_000_000

/** One stored record carrying only what a ranking test needs. */
function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_00000000-0000-4000-8000-000000000001',
    scope: 'global',
    scopeKey: '',
    kind: 'fact',
    text: 'a claim about caches',
    tags: [],
    status: 'active',
    confidence: 0.9,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    validAt: EPOCH,
    invalidAt: null,
    supersedes: null,
    supersededBy: null,
    evidence: { sessionId: null, messageId: null, note: null },
    hits: 0,
    ...overrides,
  }
}

describe('the layer axis', () => {
  it('treats a record that declares no layer as the neutral relevance layer', () => {
    expect(layerOf({})).toBe(DEFAULT_LAYER)
    expect(layerOf(record())).toBe('fact')
    expect(layerOf(record({ layer: 'lesson' }))).toBe('lesson')
  })

  it('keeps every record written before the axis inside the relevance layers', () => {
    // The identity layers inject without a keyword match, so a legacy record that
    // defaulted into one would change what an upgraded corpus injects.
    expect(SHIPPED_IDENTITY_LAYERS).not.toContain(DEFAULT_LAYER)
    for (const layer of SHIPPED_IDENTITY_LAYERS) expect(layerOf({})).not.toBe(layer)
  })

  it('weights a constraint and a lesson above an encyclopedic fact', () => {
    expect(layerWeight('rule')).toBeGreaterThan(layerWeight('fact'))
    expect(layerWeight('lesson')).toBeGreaterThan(layerWeight('fact'))
    expect(layerWeight('user')).toBeGreaterThan(layerWeight('topic'))
  })

  it('names every layer in the taxonomy and glosses each one', () => {
    expect(MEMORY_LAYERS).toEqual(['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rule'])
    for (const layer of MEMORY_LAYERS) expect(LAYER_GLOSS[layer]).not.toBe('')
  })

  it('maps a layer alone onto a complete claim class', () => {
    expect(kindForLayer('user')).toBe('preference')
    expect(kindForLayer('rule')).toBe('decision')
    expect(kindForLayer('lesson')).toBe('pitfall')
    for (const layer of ['soul', 'project', 'fact', 'topic'] as const) {
      expect(kindForLayer(layer)).toBe('fact')
    }
  })

  it('rejects an identity list naming an unknown or repeated layer', () => {
    expect(assertIdentityLayers(['soul', 'user'])).toEqual(['soul', 'user'])
    expect(() => assertIdentityLayers(['nope'])).toThrow(/unknown layer: nope/)
    expect(() => assertIdentityLayers(['user', 'user'])).toThrow(/names user twice/)
  })
})

describe('tokenization', () => {
  it('keeps repeats in the stream and collapses them in the set view', () => {
    expect(tokenizeAll('sqlite sqlite domain')).toEqual(['sqlite', 'sqlite', 'domain'])
    expect([...tokenize('sqlite sqlite domain')]).toEqual(['sqlite', 'domain'])
  })

  it('counts term frequencies over the same tokens ranking uses', () => {
    expect(termFrequencies('sqlite sqlite domain')).toEqual(new Map([['sqlite', 2], ['domain', 1]]))
  })
})

describe('BM25 ranking', () => {
  it('stops paying for a repeated term once it saturates', () => {
    const once = record({ id: 'mem_00000000-0000-4000-8000-00000000000a', text: 'sqlite domain' })
    const many = record({
      id: 'mem_00000000-0000-4000-8000-00000000000b',
      text: 'sqlite sqlite sqlite sqlite sqlite sqlite sqlite sqlite domain',
    })
    const hits = rankRecords([once, many], 'sqlite domain', { now: EPOCH })
    const scores = new Map(hits.map(hit => [hit.record.id, hit.score]))
    // Repetition helps, but by a bounded factor rather than eight times over.
    expect(scores.get(many.id) ?? 0).toBeGreaterThan(scores.get(once.id) ?? 0)
    expect(scores.get(many.id) ?? 0).toBeLessThan((scores.get(once.id) ?? 0) * 2)
  })

  it('discounts a long record that buries the same phrase', () => {
    const tight = record({ id: 'mem_00000000-0000-4000-8000-00000000000c', text: 'sqlite domain' })
    const padded = record({
      id: 'mem_00000000-0000-4000-8000-00000000000d',
      text: `sqlite domain ${Array.from({ length: 40 }, (_, index) => `filler${index}`).join(' ')}`,
    })
    const hits = rankRecords([tight, padded], 'sqlite domain', { now: EPOCH })
    expect(hits[0]?.record.id).toBe(tight.id)
  })

  it('ranks a claim by what distinguishes it from the rest of the corpus', () => {
    const common = record({ id: 'mem_00000000-0000-4000-8000-00000000000e', text: 'sqlite backend' })
    const distinctive = record({ id: 'mem_00000000-0000-4000-8000-00000000000f', text: 'sqlite zephyrium' })
    const other = record({ id: 'mem_00000000-0000-4000-8000-000000000010', text: 'sqlite backend' })
    const hits = rankRecords([common, other, distinctive], 'sqlite zephyrium', { now: EPOCH })
    expect(hits[0]?.record.id).toBe(distinctive.id)
  })

  it('ranks a matched rule above a matched fact of the same wording', () => {
    const fact = record({ id: 'mem_00000000-0000-4000-8000-000000000011', layer: 'fact', text: 'never deploy on friday' })
    const rule = record({ id: 'mem_00000000-0000-4000-8000-000000000012', layer: 'rule', text: 'never deploy on friday' })
    const hits = rankRecords([fact, rule], 'deploy friday', { now: EPOCH })
    expect(hits[0]?.record.id).toBe(rule.id)
  })

  it('reports the fraction of query terms a hit covered', () => {
    const only = record({ id: 'mem_00000000-0000-4000-8000-000000000013', text: 'sqlite backend' })
    const [hit] = rankRecords([only], 'sqlite backend unrelated words', { now: EPOCH })
    expect(hit?.matched).toEqual(['sqlite', 'backend'])
    expect(hit?.coverage).toBeCloseTo(2 / 4, 5)
  })

  it('lets a deployment turn term-frequency weighting off through k1', () => {
    const once = record({ id: 'mem_00000000-0000-4000-8000-000000000014', text: 'sqlite domain' })
    const many = record({ id: 'mem_00000000-0000-4000-8000-000000000015', text: 'sqlite sqlite sqlite sqlite sqlite domain' })
    const plain = rankRecords([once, many], 'sqlite domain', { now: EPOCH, k1: 0 })
    expect(plain[0]?.score).toBeCloseTo(plain[1]?.score ?? 0, 10)
  })

  it('lets a deployment turn length normalization off through b', () => {
    const tight = record({ id: 'mem_00000000-0000-4000-8000-000000000016', text: 'sqlite domain' })
    const padded = record({
      id: 'mem_00000000-0000-4000-8000-000000000017',
      text: `sqlite domain ${Array.from({ length: 40 }, (_, index) => `filler${index}`).join(' ')}`,
    })
    const flat = rankRecords([tight, padded], 'sqlite domain', { now: EPOCH, b: 0 })
    expect(flat[0]?.score).toBeCloseTo(flat[1]?.score ?? 0, 10)
  })
})
