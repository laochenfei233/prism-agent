/**
 * Fusion behavior: RRF ordering, URL identity across engines, and the merge of
 * redirect aliases after page fetching.
 */
import { describe, expect, it } from 'vitest'
import { dedupeByUrl, fuse, RRF_K, type RankedHit } from '../src/fusion.ts'

describe('fuse', () => {
  it('ranks a result two engines returned above a single-engine result', () => {
    const fused = fuse([
      { engine: 'a', hits: [{ url: 'https://x.test/1', title: 'One' }, { url: 'https://x.test/2', title: 'Two' }] },
      { engine: 'b', hits: [{ url: 'https://x.test/2?utm_source=z', title: 'Two b', snippet: 'a longer excerpt' }, { url: 'https://x.test/3', title: 'Three' }] },
    ])
    expect(fused.map(hit => hit.url)).toEqual(['https://x.test/2', 'https://x.test/1', 'https://x.test/3'])
    expect(fused[0]?.engines).toEqual(['a', 'b'])
    expect(fused[0]?.title).toBe('Two')
    expect(fused[0]?.snippet).toBe('a longer excerpt')
    expect(fused[0]?.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 10)
  })

  it('keeps first appearance order for equal scores', () => {
    const fused = fuse([
      { engine: 'a', hits: [{ url: 'https://y.test/a' }] },
      { engine: 'b', hits: [{ url: 'https://y.test/b' }] },
    ])
    expect(fused.map(hit => hit.url)).toEqual(['https://y.test/a', 'https://y.test/b'])
  })

  it('ignores empty answers', () => {
    expect(fuse([{ engine: 'a', hits: [] }])).toEqual([])
  })
})

describe('dedupeByUrl', () => {
  it('merges redirect aliases and keeps the longest excerpt', () => {
    const hits: RankedHit[] = [
      { url: 'https://z.test/page', title: 'Page', snippet: 'short', score: 0.2, engines: ['a'] },
      { url: 'https://z.test/page/', snippet: 'a much longer excerpt', score: 0.1, engines: ['b'] },
    ]
    const merged = dedupeByUrl(hits)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({
      url: 'https://z.test/page',
      title: 'Page',
      snippet: 'a much longer excerpt',
      score: 0.2,
      engines: ['a', 'b'],
    })
  })
})
