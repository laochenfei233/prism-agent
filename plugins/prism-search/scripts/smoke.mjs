/**
 * Built-artifact smoke check: loads `lib/index.js` the way the Loader does,
 * registers the provider on a minimal web registry, and runs one search with a
 * stubbed network so the package's own engine parsing and fusion run end to end.
 *
 * Run after `npm run build`: `node scripts/smoke.mjs`
 */
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'

assert.equal(name, 'prism-search')
assert.deepEqual(inject, ['web'])

/** Volatile field stand-in the Loader hands to `apply`. */
const field = value => ({ get: () => value })
const config = {
  rerankProvider: field(''),
  rerankModel: field(''),
  fetchTopN: field(2),
  engineTimeoutMs: field(2000),
  fetchTimeoutMs: field(2000),
  rerankTimeoutMs: field(2000),
  maxSnippetChars: field(300),
  maxRerankCandidates: field(12),
}

const registered = []
const ctx = {
  effect: (callback) => {
    const dispose = callback()
    return dispose
  },
  web: { registerSearchProvider: (provider) => { registered.push(provider); return () => {} } },
}

apply(ctx, config)
assert.equal(registered.length, 1)
const provider = registered[0]
assert.equal(provider.id, 'prism-search')
assert.equal(provider.available(), true)

const RESULT_PAGE = `<!doctype html><html><head><title>Composition smoke</title></head><body>
  <a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLm9yZy9hcnRpY2xl">Example Org Article</a>
  <p>The excerpt that the reader takes as the result snippet.</p>
  <a href="/search?q=other">Other</a>
</body></html>`

globalThis.fetch = async (url) => new Response(
  url.includes('api.github.com') ? JSON.stringify({ items: [] })
    : url.includes('api.qwant.com') ? JSON.stringify({ data: { result: { items: [] } } })
      : RESULT_PAGE,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
)

const result = await provider.search({ query: 'deepseek harness', maxResults: 3 })
assert.ok(result.sources.length >= 1, 'the search returns at least one source')
assert.ok(result.sources.length <= 3, 'the provider honors maxResults')
assert.equal(result.sources[0].url, 'https://example.org/article', 'the Bing wrapper is unwrapped')
assert.match(String(result.sources[0].snippet), /excerpt|Example/, 'the snippet carries page or engine text')

console.log(JSON.stringify({ registered: provider.id, sources: result.sources.length, first: result.sources[0].url }))
