/**
 * Provider behavior: fan-out with failure isolation, RRF ordering, page text,
 * the model's order, and the caller's result bound.
 */
import { describe, expect, it, vi } from 'vitest'
import type { EngineHit, EngineSpec } from '../src/engines.ts'
import type { HttpRequest, HttpResponse } from '../src/http.ts'
import {
  PrismSearchError, PrismSearchProvider, type PrismSearchDeps, type PrismSearchOptions,
} from '../src/provider.ts'
import type { RerankRequest } from '../src/rerank.ts'

/** Search controls with no page fetching and no model ordering. */
const OPTIONS: PrismSearchOptions = {
  rerankProvider: '',
  rerankModel: '',
  fetchTopN: 0,
  engineTimeoutMs: 1000,
  fetchTimeoutMs: 1000,
  rerankTimeoutMs: 1000,
  maxSnippetChars: 200,
  maxRerankCandidates: 5,
}

/** One engine spec that always returns the given hits. */
function engineSpec(id: string, hits: readonly EngineHit[]): EngineSpec {
  return {
    id,
    build: query => ({ url: `https://${id}.test/?q=${encodeURIComponent(query)}` }),
    parse: () => [...hits],
  }
}

/** An HTTP answer for the stubbed transport. */
function okAnswer(request: HttpRequest): HttpResponse {
  return { url: request.url, status: 200, contentType: 'text/html', text: '' }
}

/** Build a provider over the given engines and overrides. */
function harness(
  engines: readonly EngineSpec[],
  options: Partial<PrismSearchOptions> = {},
  overrides: Partial<PrismSearchDeps> = {},
): PrismSearchProvider {
  return new PrismSearchProvider({
    engines,
    http: overrides.http ?? (async request => okAnswer(request)),
    fetchPage: overrides.fetchPage ?? (async () => undefined),
    rerank: overrides.rerank ?? (async () => undefined),
    options: overrides.options ?? (() => ({ ...OPTIONS, ...options })),
  })
}

describe('PrismSearchProvider', () => {
  it('fuses two engines, deduplicates one URL, and keeps the fused order', async () => {
    const provider = harness([
      engineSpec('alpha', [{ url: 'https://x.test/1', title: 'One' }, { url: 'https://x.test/2', title: 'Two' }]),
      engineSpec('beta', [{ url: 'https://x.test/2?utm_source=z', title: 'Two b' }, { url: 'https://x.test/3', title: 'Three' }]),
    ])
    const result = await provider.search({ query: 'deepseek', maxResults: 8 })
    expect(result.sources.map(source => source.url)).toEqual(['https://x.test/2', 'https://x.test/1', 'https://x.test/3'])
    expect(result.truncated).toBe(false)
  })

  it('caps the returned sources and reports truncation', async () => {
    const provider = harness([engineSpec('alpha', [
      { url: 'https://x.test/1', title: 'One' },
      { url: 'https://x.test/2', title: 'Two' },
    ])])
    const result = await provider.search({ query: 'q', maxResults: 1 })
    expect(result.sources).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('skips an engine whose request failed', async () => {
    const provider = harness(
      [engineSpec('alpha', [{ url: 'https://x.test/1', title: 'One' }]), engineSpec('beta', [{ url: 'https://x.test/2', title: 'Two' }])],
      {},
      {
        http: async (request) => {
          if (request.url.includes('beta.test')) throw new Error('blocked')
          return okAnswer(request)
        },
      },
    )
    const result = await provider.search({ query: 'q' })
    expect(result.sources.map(source => source.url)).toEqual(['https://x.test/1'])
  })

  it('fails with an actionable error when every engine returns nothing', async () => {
    const provider = harness([engineSpec('alpha', [])])
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'prism-search/no-results',
      message: expect.stringContaining('1 engines'),
    })
  })

  it('rejects an empty query without calling an engine', async () => {
    const http = vi.fn(async (request: HttpRequest) => okAnswer(request))
    const provider = harness([engineSpec('alpha', [])], {}, { http })
    await expect(provider.search({ query: '   ' })).rejects.toBeInstanceOf(PrismSearchError)
    expect(http).not.toHaveBeenCalled()
  })

  it('fetches the top pages, adopts the final URL, and keeps the rest untouched', async () => {
    const fetchPage = vi.fn(async (url: string) => ({
      url: `https://final.test/${new URL(url).pathname.slice(1)}`,
      title: `Final ${url}`,
      text: `full page text for ${url}`,
    }))
    const provider = harness(
      [engineSpec('alpha', [
        { url: 'https://x.test/1', title: 'One', snippet: 'engine excerpt' },
        { url: 'https://x.test/2', title: 'Two' },
        { url: 'https://x.test/3', title: 'Three' },
      ])],
      { fetchTopN: 2 },
      { fetchPage },
    )
    const result = await provider.search({ query: 'q', maxResults: 3 })
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(result.sources[0]).toMatchObject({ url: 'https://final.test/1', snippet: 'full page text for https://x.test/1' })
    expect(result.sources[2]).toMatchObject({ url: 'https://x.test/3', title: 'Three' })
  })

  it('does not fetch pages when fetchTopN is zero', async () => {
    const fetchPage = vi.fn(async () => undefined)
    const provider = harness([engineSpec('alpha', [{ url: 'https://x.test/1', title: 'One' }])], { fetchTopN: 0 }, { fetchPage })
    await provider.search({ query: 'q' })
    expect(fetchPage).not.toHaveBeenCalled()
  })

  it('applies the selected model order to the candidates', async () => {
    const rerank = vi.fn(async (_request: RerankRequest) => [1, 0])
    const provider = harness(
      [engineSpec('alpha', [{ url: 'https://x.test/1', title: 'One' }, { url: 'https://x.test/2', title: 'Two' }])],
      { rerankProvider: 'provider', rerankModel: 'model', maxRerankCandidates: 2 },
      { rerank },
    )
    const result = await provider.search({ query: 'q' })
    expect(result.sources.map(source => source.url)).toEqual(['https://x.test/2', 'https://x.test/1'])
    expect(rerank).toHaveBeenCalledTimes(1)
    expect(rerank.mock.calls[0]?.[0]).toMatchObject({ query: 'q', provider: 'provider', model: 'model' })
  })

  it('keeps the fused order when the model returns no order', async () => {
    const provider = harness(
      [engineSpec('alpha', [{ url: 'https://x.test/1', title: 'One' }, { url: 'https://x.test/2', title: 'Two' }])],
      { rerankProvider: 'provider', rerankModel: 'model' },
      { rerank: async () => undefined },
    )
    const result = await provider.search({ query: 'q' })
    expect(result.sources.map(source => source.url)).toEqual(['https://x.test/1', 'https://x.test/2'])
  })

  it('fails the search with the caller cancellation reason', async () => {
    const provider = harness([engineSpec('alpha', [])])
    await expect(provider.search({ query: 'q' }, AbortSignal.abort(new Error('stop')))).rejects.toThrow('stop')
  })
})
