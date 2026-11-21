/**
 * Browser wiki client: the request each operation shapes, the value it narrows
 * out of the envelope, and the failures it raises instead of returning garbage.
 */

import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { WikiRequestError, createWikiApi, type WikiApi } from '../src/client/api.ts'
import type { WikiFrontmatter, WikiLintReport, WikiPagePath, WikiSearchHit } from '../src/types.ts'
import type {
  WikiPagePayload, WikiPageSummary, WikiReadRequest, WikiSaveRequest, WikiSearchRequest, WikiSourceRequest,
} from '../src/web-contract.ts'

/** Frontmatter as the host answers it. */
const frontmatter: WikiFrontmatter = {
  title: 'Alpha',
  type: 'concept',
  tags: ['alpha'],
  updated: '2026-10-07',
  status: 'current',
  sources: ['notes/paper.md'],
  aliases: [],
  confidence: 0.5,
  contradicts: [],
}

/** One vault-tree row as the host answers it. */
const summary: WikiPageSummary = {
  path: 'concepts/alpha.md',
  title: 'Alpha',
  type: 'concept',
  status: 'current',
  updated: '2026-10-07',
  tags: ['alpha'],
}

/** One stored page as the host answers it. */
const stored: WikiPagePayload = {
  path: 'concepts/alpha.md',
  frontmatter,
  body: 'Alpha body.\n',
  revision: 'rev-1',
}

/** One ranked hit as the host answers it. */
const hit: WikiSearchHit = {
  path: brandString<WikiPagePath>('concepts/alpha.md'),
  title: 'Alpha',
  type: 'concept',
  status: 'current',
  updated: '2026-10-07',
  excerpt: 'the needle excerpt',
}

/** The vault health report the host answers with. */
const report: WikiLintReport = { pages: 1, sources: 1, findings: [] }

/** The read request every read case sends. */
const readRequest: WikiReadRequest = { path: 'concepts/alpha.md' }

/** The search request every search case sends. */
const searchRequest: WikiSearchRequest = { query: 'needle', limit: 5 }

/** The save request every save case sends. */
const saveRequest: WikiSaveRequest = { path: 'concepts/alpha.md', frontmatter, body: 'Alpha body.\n' }

/** The raw-source request every source case sends. */
const sourceRequest: WikiSourceRequest = { path: 'notes/paper.md', maxChars: 20 }

/** One recorded request. */
interface Call {
  readonly url: string
  readonly init: RequestInit
}

/** A fetch stub answering one body, with the requests it received. */
function fetchOf(body: unknown, status = 200): { readonly fetch: typeof fetch; readonly calls: Call[] } {
  const calls: Call[] = []
  return {
    fetch: async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      calls.push({ url, init: init ?? {} })
      return Response.json(body, { status })
    },
    calls,
  }
}

/** Answer every request with one successful value. */
function okFetch(value: unknown): { readonly fetch: typeof fetch; readonly calls: Call[] } {
  return fetchOf({ ok: true, value })
}

/** Read one operation's outcome, resolving or rejecting to the value itself. */
async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  return await run().catch((error: unknown) => error)
}

describe('wiki api', () => {
  it('unwraps the envelope of every operation', async () => {
    const cases: readonly [string, (api: WikiApi) => Promise<unknown>, unknown][] = [
      ['list', async api => await api.list(), { pages: [summary] }],
      ['read', async api => await api.read(readRequest), {
        page: stored, links: ['concepts/beta.md'], backlinks: [], sources: ['notes/paper.md'],
      }],
      ['search', async api => await api.search(searchRequest), { hits: [hit] }],
      ['save', async api => await api.save(saveRequest), { page: stored }],
      ['source', async api => await api.source(sourceRequest), {
        path: 'notes/paper.md', text: 'The source text.', truncated: false,
      }],
      ['lint', async api => await api.lint(), { report }],
    ]

    for (const [endpoint, run, value] of cases) {
      const stub = okFetch(value)
      await expect(run(createWikiApi(stub.fetch)), endpoint).resolves.toEqual(value)
    }
  })

  it('posts each operation to its own endpoint with its JSON body', async () => {
    const cases: readonly [string, (api: WikiApi) => Promise<unknown>, unknown, string][] = [
      ['list', async api => await api.list(), { pages: [summary] }, '{}'],
      ['read', async api => await api.read(readRequest), {
        page: stored, links: [], backlinks: [], sources: [],
      }, JSON.stringify(readRequest)],
      ['search', async api => await api.search(searchRequest), { hits: [hit] }, JSON.stringify(searchRequest)],
      ['save', async api => await api.save(saveRequest), { page: stored }, JSON.stringify(saveRequest)],
      ['source', async api => await api.source(sourceRequest), {
        path: 'notes/paper.md', text: 'The source text.', truncated: false,
      }, JSON.stringify(sourceRequest)],
      ['lint', async api => await api.lint(), { report }, '{}'],
    ]

    for (const [endpoint, run, value, body] of cases) {
      const stub = okFetch(value)
      await run(createWikiApi(stub.fetch))

      const call = stub.calls[0]
      expect(call?.url, endpoint).toBe(`api/prism-wiki/${endpoint}`)
      expect(call?.init.method, endpoint).toBe('POST')
      expect(call?.init.headers, endpoint).toEqual({ 'content-type': 'application/json' })
      expect(call?.init.body, endpoint).toBe(body)
    }
  })

  it('passes the caller signal through', async () => {
    const stub = okFetch({ pages: [] })
    const signal = new AbortController().signal

    await createWikiApi(stub.fetch).list(signal)

    expect(stub.calls[0]?.init.signal).toBe(signal)
  })

  it('turns a host failure into a request error carrying its code', async () => {
    const stub = fetchOf({
      ok: false,
      error: { code: 'prism-wiki/revision-conflict', message: 'changed elsewhere' },
    }, 400)

    await expect(createWikiApi(stub.fetch).save(saveRequest)).rejects.toMatchObject({
      name: 'WikiRequestError',
      code: 'prism-wiki/revision-conflict',
      message: 'changed elsewhere',
    })
  })

  it('rejects a body that is not an envelope', async () => {
    const bodies: readonly [string, unknown][] = [
      ['a body that is not an object', 'nope'],
      ['a success envelope without a value', { ok: true }],
      ['a failure envelope without an error', { ok: false }],
      ['a failure envelope with a malformed error', { ok: false, error: { code: 7 } }],
    ]

    for (const [name, body] of bodies) {
      const failure = await outcome(async () => await createWikiApi(fetchOf(body).fetch).list())
      if (!(failure instanceof WikiRequestError)) throw new Error(`${name}: the client resolved instead of raising`)
      expect(failure.code, name).toBe('prism-wiki/invalid-response')
    }
  })

  it('rejects a value that does not carry its documented fields', async () => {
    const invalid: readonly [string, (api: WikiApi) => Promise<unknown>, unknown][] = [
      ['a vault tree that is not a list', async api => await api.list(), { pages: 'none' }],
      ['a vault-tree row missing its title', async api => await api.list(), { pages: [{ ...summary, title: 7 }] }],
      ['a vault-tree row with an unknown type', async api => await api.list(), { pages: [{ ...summary, type: 'nonsense' }] }],
      ['a page missing its revision', async api => await api.read(readRequest), {
        page: { ...stored, revision: undefined }, links: [], backlinks: [], sources: [],
      }],
      ['a page whose frontmatter is not an object', async api => await api.read(readRequest), {
        page: { ...stored, frontmatter: null }, links: [], backlinks: [], sources: [],
      }],
      ['a page whose body is not text', async api => await api.read(readRequest), {
        page: { ...stored, body: 7 }, links: [], backlinks: [], sources: [],
      }],
      ['a page whose confidence is not a number', async api => await api.read(readRequest), {
        page: { ...stored, frontmatter: { ...frontmatter, confidence: 'high' } }, links: [], backlinks: [], sources: [],
      }],
      ['a backlink list that is not a list', async api => await api.read(readRequest), {
        page: stored, links: [], backlinks: 'none', sources: [],
      }],
      ['a hit list that is not a list', async api => await api.search(searchRequest), { hits: 'none' }],
      ['a hit with an unknown status', async api => await api.search(searchRequest), { hits: [{ ...hit, status: 'maybe' }] }],
      ['a stored page whose revision is not text', async api => await api.save(saveRequest), { page: { ...stored, revision: 7 } }],
      ['a source whose truncated flag is not a boolean', async api => await api.source(sourceRequest), {
        path: 'notes/paper.md', text: 'x', truncated: 'no',
      }],
      ['a source missing its text', async api => await api.source(sourceRequest), {
        path: 'notes/paper.md', truncated: false,
      }],
      ['a report whose findings are not a list', async api => await api.lint(), { report: { ...report, findings: 'none' } }],
      ['a finding without its kind', async api => await api.lint(), {
        report: { ...report, findings: [{ page: null, detail: 'x' }] },
      }],
    ]

    for (const [name, run, value] of invalid) {
      const failure = await outcome(async () => await run(createWikiApi(okFetch(value).fetch)))
      if (!(failure instanceof WikiRequestError)) throw new Error(`${name}: the client resolved instead of raising`)
      expect(failure.code, name).toBe('prism-wiki/invalid-response')
    }
  })
})
