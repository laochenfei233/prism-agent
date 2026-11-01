/**
 * Host composition: the plugin mounts in a real Cordis context, registers the
 * provider through the web service, orders through the LLM service, and reads
 * pages through the web fetch seam. These are the seams the unit tests below it
 * cannot see.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject, name, type Config } from '../src/index.ts'
import type { LlmStreamRequest } from '../src/rerank.ts'

/** One result the fake web service exposes. */
interface SourceLike {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
}

/** The provider the plugin registers. */
interface ProviderLike {
  readonly id: string
  available(): boolean
  search(request: { readonly query: string; readonly maxResults?: number }, signal?: AbortSignal): Promise<{
    readonly sources: readonly SourceLike[]
    readonly truncated: boolean
  }>
}

/** Engine answer with two result links, shared by every engine request. */
const ENGINE_PAGE = `<!doctype html><html><body>
  <a href="https://example.org/one">Example One</a><p>engine excerpt one</p>
  <a href="https://example.org/two">Example Two</a><p>engine excerpt two</p>
</body></html>`

/** Page answer the fetch seam returns for any result URL. */
const PAGE = '<!doctype html><html><head><title>Page title</title></head><body><p>Full page body text.</p></body></html>'

/** A volatile field the Loader would hand to `apply`. */
function field<T>(value: T): { get(): T } {
  return { get: () => value }
}

/** Plugin configuration with ordering on by default. */
function configOf(overrides: Partial<Record<'rerankProvider' | 'rerankModel', string>> = {}): Config {
  return {
    rerankProvider: field(overrides.rerankProvider ?? 'fixture-provider'),
    rerankModel: field(overrides.rerankModel ?? 'fixture-model'),
    fetchTopN: field(2),
    engineTimeoutMs: field(2000),
    fetchTimeoutMs: field(2000),
    rerankTimeoutMs: field(2000),
    maxSnippetChars: field(300),
    maxRerankCandidates: field(12),
  }
}

/** Stand-in for `ctx.web`: the search registry plus the fetch seam. */
class FakeWeb extends Service {
  readonly providers = new Map<string, ProviderLike>()
  readonly fetched: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'web')
  }

  registerSearchProvider(provider: ProviderLike): () => void {
    this.providers.set(provider.id, provider)
    return () => { this.providers.delete(provider.id) }
  }

  async fetch(request: { readonly url: string }): Promise<{
    url: string
    statusCode: number
    body: { kind: 'html'; content: string }
  }> {
    this.fetched.push(request.url)
    // The shipped fetch provider refuses the cross-origin hop of an engine wrapper.
    if (request.url.includes('/link?')) throw new Error('cross-origin redirect blocked')
    return { url: request.url, statusCode: 200, body: { kind: 'html', content: PAGE } }
  }
}

/** Stand-in for `ctx.llm`: records each request and answers with a fixed order. */
class FakeLlm extends Service {
  readonly requests: LlmStreamRequest[] = []

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  stream(request: LlmStreamRequest): AsyncIterable<unknown> {
    this.requests.push(request)
    return (async function* generate() {
      yield { type: 'text-delta', text: '{"order":[2,1]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Answer every engine request with the shared two-result page. */
function stubEngines(): void {
  globalThis.fetch = async () => new Response(ENGINE_PAGE, { status: 200, headers: { 'content-type': 'text/html' } })
}

describe('host composition', () => {
  it('mounts, registers the provider, and orders through the LLM service', async () => {
    stubEngines()
    const ctx = new Context()
    await ctx.plugin(FakeWeb)
    await ctx.plugin(FakeLlm)
    await ctx.plugin({ name, inject, apply }, configOf())

    const web = ctx.get('web') as FakeWeb
    const llm = ctx.get('llm') as FakeLlm
    const provider = web.providers.get('prism-search')
    expect(provider).toBeDefined()
    expect(provider?.available()).toBe(true)

    const result = await provider?.search({ query: 'deepseek', maxResults: 5 })
    expect(result?.sources.map(source => source.url)).toEqual(['https://example.org/two', 'https://example.org/one'])
    expect(llm.requests).toHaveLength(1)
    expect(llm.requests[0]).toMatchObject({ provider: 'fixture-provider', model: 'fixture-model' })
    // Pages came through the fetch seam, not a second connection of the plugin's own.
    expect(web.fetched).toEqual(['https://example.org/one', 'https://example.org/two'])
    expect(result?.sources[0]?.snippet).toContain('Full page body text.')
  })

  it('keeps the fused order when the deployment has no LLM service', async () => {
    stubEngines()
    const ctx = new Context()
    await ctx.plugin(FakeWeb)
    await ctx.plugin({ name, inject, apply }, configOf())

    const web = ctx.get('web') as FakeWeb
    const result = await web.providers.get('prism-search')?.search({ query: 'deepseek', maxResults: 5 })
    expect(result?.sources.map(source => source.url)).toEqual(['https://example.org/one', 'https://example.org/two'])
  })

  it('resolves an engine wrapper through its own redirect, then reads it through the seam', async () => {
    const wrapperPage = '<a href="http://www.baidu.com/link?url=abc">Wrapped Baidu Result</a><p>baidu excerpt</p>'
    globalThis.fetch = async (url) => (String(url).includes('/link?')
      ? new Response('', { status: 302, headers: { location: 'https://example.org/resolved' } })
      : new Response(wrapperPage, { status: 200, headers: { 'content-type': 'text/html' } }))
    const ctx = new Context()
    await ctx.plugin(FakeWeb)
    await ctx.plugin({ name, inject, apply }, configOf({ rerankProvider: '', rerankModel: '' }))

    const web = ctx.get('web') as FakeWeb
    const result = await web.providers.get('prism-search')?.search({ query: 'deepseek', maxResults: 5 })
    expect(result?.sources[0]?.url).toBe('https://example.org/resolved')
    expect(result?.sources[0]?.snippet).toContain('Full page body text.')
    expect(web.fetched).toContain('https://example.org/resolved')
  })

  it('removes the provider when the plugin fiber disposes', async () => {
    stubEngines()
    const ctx = new Context()
    await ctx.plugin(FakeWeb)
    const fiber = await ctx.plugin({ name, inject, apply }, configOf())
    const web = ctx.get('web') as FakeWeb
    expect(web.providers.has('prism-search')).toBe(true)
    await fiber.dispose()
    expect(web.providers.has('prism-search')).toBe(false)
  })
})
