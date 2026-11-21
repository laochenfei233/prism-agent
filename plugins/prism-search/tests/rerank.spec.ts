/**
 * Model ordering: the prompt names the candidates, the parser accepts the
 * answer formats models actually produce, and every failure keeps the fused
 * order instead of failing the search.
 */
import { describe, expect, it } from 'vitest'
import type { RankedHit } from '../src/fusion.ts'
import { buildRerankPrompt, parseOrderAnswer, rerankOrder } from '../src/rerank.ts'

/** Two ranked candidates. */
const HITS: readonly RankedHit[] = [
  { url: 'https://a.test/1', title: 'Alpha', snippet: 'first excerpt', score: 0.03, engines: ['a'] },
  { url: 'https://b.test/2', title: 'Beta', score: 0.02, engines: ['b'] },
]

/** A stream that emits one text delta per entry. */
function streamOf(...deltas: readonly string[]): (request: unknown) => AsyncIterable<unknown> {
  return () => (async function* generate() {
    for (const text of deltas) yield { type: 'text-delta', text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

describe('buildRerankPrompt', () => {
  it('numbers the candidates and asks for a JSON permutation', () => {
    const prompt = buildRerankPrompt('test query', HITS)
    expect(prompt).toContain('Query: test query')
    expect(prompt).toContain('1. Alpha — https://a.test/1')
    expect(prompt).toContain('first excerpt')
    expect(prompt).toContain('2. Beta — https://b.test/2')
    expect(prompt).toContain('{"order": [...]}')
  })
})

describe('parseOrderAnswer', () => {
  it('reads a one-based object order', () => {
    expect(parseOrderAnswer('{"order":[2,1]}', 2)).toEqual([1, 0])
  })

  it('detects a zero-based order', () => {
    expect(parseOrderAnswer('[1,0]', 2)).toEqual([1, 0])
    expect(parseOrderAnswer('[0,2]', 3)).toEqual([0, 2, 1])
  })

  it('tolerates prose around the JSON and drops duplicates and out-of-range values', () => {
    expect(parseOrderAnswer('Sure. {"order": [2, 2, 9]} done', 3)).toEqual([1, 0, 2])
  })

  it('reads a bare array without prose', () => {
    expect(parseOrderAnswer('[2,1]', 2)).toEqual([1, 0])
  })

  it('returns undefined for answers without an order', () => {
    expect(parseOrderAnswer('I cannot rank these.', 2)).toBeUndefined()
    expect(parseOrderAnswer('{"order": []}', 2)).toBeUndefined()
    expect(parseOrderAnswer('{"other": 1}', 2)).toBeUndefined()
  })
})

describe('rerankOrder', () => {
  it('assembles deltas and returns the permutation', async () => {
    const order = await rerankOrder({ query: 'q', hits: HITS, provider: 'p', model: 'm', timeoutMs: 1000 }, { stream: streamOf('{"order":[', '2,1]}') })
    expect(order).toEqual([1, 0])
  })

  it('returns undefined when the call throws', async () => {
    const order = await rerankOrder({ query: 'q', hits: HITS, provider: 'p', model: 'm', timeoutMs: 1000 }, {
      stream: () => (async function* generate() {
        throw new Error('provider rejected the request')
      })(),
    })
    expect(order).toBeUndefined()
  })

  it('returns undefined on an error finish', async () => {
    const order = await rerankOrder({ query: 'q', hits: HITS, provider: 'p', model: 'm', timeoutMs: 1000 }, {
      stream: () => (async function* generate() {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'quota' } } }
      })(),
    })
    expect(order).toBeUndefined()
  })

  it('does not call the model for a single candidate', async () => {
    let called = false
    const order = await rerankOrder({ query: 'q', hits: [HITS[0] as RankedHit], provider: 'p', model: 'm', timeoutMs: 1000 }, {
      stream: () => {
        called = true
        return (async function* generate() { /* no chunks */ })()
      },
    })
    expect(order).toBeUndefined()
    expect(called).toBe(false)
  })
})
