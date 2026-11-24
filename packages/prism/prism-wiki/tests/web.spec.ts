/**
 * Behaviour of the wiki browser routes: the six exact Fetch routes the
 * Knowledge page calls, dispatched through a recording Connection registry
 * against a real vault on disk, together with the request validation each route
 * owns. The real WebServer and Connection composition is the composition
 * suite's case; this one answers what each route does with its body.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WikiVaultService from '../src/index.ts'
import * as web from '../src/web.ts'
import type { WikiFrontmatter, WikiPagePath, WikiSourcePath } from '../src/types.ts'

/** Every route this plugin owns, named as its endpoint below `/api/prism-wiki`. */
const ROUTES = ['list', 'read', 'search', 'save', 'source', 'lint'] as const

/** One route answer as the Knowledge page receives it. */
interface Answer {
  readonly status: number
  readonly body: Record<string, unknown>
}

/** The mounted deployment: the recording registry, the vault, and the browser half. */
interface WebHarness {
  readonly ctx: Context
  readonly webFiber: Fiber
  /** Send one request body to a wiki route and read its envelope. */
  readonly post: (endpoint: string, body: string) => Promise<Answer>
  /** Send one request body to a wiki route and return the raw answer. */
  readonly send: (endpoint: string, body: string) => Promise<Response>
}

/** Brand one vault-relative page path. */
const pagePath = (value: string): WikiPagePath => brandString<WikiPagePath>(value)

/** Complete frontmatter with every required field, overridable per case. */
function frontmatter(overrides: Partial<WikiFrontmatter> = {}): WikiFrontmatter {
  return {
    title: 'A page',
    type: 'concept',
    tags: [],
    updated: '2026-10-07',
    status: 'current',
    sources: [],
    aliases: [],
    confidence: null,
    contradicts: [],
    ...overrides,
  }
}

/** One JSON request body. */
function json(body: unknown): string {
  return JSON.stringify(body)
}

let root: string

/** Roots the current case mounted, disposed after it. */
const roots: Context[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prism-wiki-web-'))
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await rm(root, { recursive: true, force: true })
})

/**
 * Mount the vault service and the browser half over a recording Connection
 * registry, then seed the vault every case reads. A recording registry keeps
 * this suite about route behaviour; the real service is the composition suite's
 * case.
 * @param vaultRoot - the temp vault directory the service owns.
 * @returns the mounts a case drives and disposes.
 */
async function webHarness(vaultRoot: string): Promise<WebHarness> {
  const ctx = new Context()
  roots.push(ctx)
  const routes = new Map<string, ConnectionFetchRoute>()
  ctx.provide('connection', {
    fetch: {
      register: (route: ConnectionFetchRoute) => {
        routes.set(route.path, route)
        return async () => { routes.delete(route.path) }
      },
    },
  })
  // The row declares `webServer` because Connection's registries resolve
  // services through the caller's context; the stub only has to exist.
  ctx.provide('webServer', { register: () => () => {} })
  // SystemPrompt injects `sessionProjections`, so the registry must be live
  // before the prompt and the vault service activate.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(WikiVaultService, { vaultRoot })
  await seed(ctx)
  const webFiber = ctx.plugin({ name: web.name, inject: [...web.inject], apply: web.apply })
  await webFiber
  const send = async (endpoint: string, body: string): Promise<Response> => {
    const route = routes.get(`/api/prism-wiki/${endpoint}`)
    if (route === undefined) return new Response(null, { status: 404 })
    return await route.fetch(new Request(`http://127.0.0.1/api/prism-wiki/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }))
  }
  return {
    ctx,
    webFiber,
    send,
    async post(endpoint, body) {
      const response = await send(endpoint, body)
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    },
  }
}

/**
 * Store the two interlinked pages and the one cited source every case reads.
 * @param ctx - a context with the vault service mounted.
 * @returns after both pages and the source are stored.
 */
async function seed(ctx: Context): Promise<void> {
  await ctx.wikiVault.addSource(brandString<WikiSourcePath>('notes/paper.md'), 'The source text.\n')
  await ctx.wikiVault.write({
    path: pagePath('concepts/alpha.md'),
    frontmatter: frontmatter({ title: 'Alpha', tags: ['alpha'], sources: ['notes/paper.md'] }),
    body: 'Alpha carries the needle.\n\nSee [[Beta]].\n',
  })
  await ctx.wikiVault.write({
    path: pagePath('concepts/beta.md'),
    frontmatter: frontmatter({ title: 'Beta', tags: ['beta'] }),
    body: 'See [[Alpha]].\n',
  })
}

/** Read the value of a successful answer. */
function value(answer: Answer): Record<string, unknown> {
  expect(answer.status).toBe(200)
  expect(answer.body.ok).toBe(true)
  return answer.body.value as Record<string, unknown>
}

/** Read the failure code of a refused answer. */
function failure(answer: Answer): string {
  expect(answer.status).toBe(400)
  expect(answer.body.ok).toBe(false)
  return (answer.body.error as { code: string }).code
}

describe('wiki browser routes', () => {
  it('registers one POST route per operation under the plugin prefix', async () => {
    const h = await webHarness(root)

    expect(web.name).toBe('prism-wiki-web')
    expect(web.inject).toEqual(['wikiVault', 'connection', 'webServer'])
    for (const endpoint of ROUTES) {
      expect((await h.send(endpoint, json({}))).status, endpoint).not.toBe(404)
    }
  })

  it('lists every page in the vault tree, ordered by path', async () => {
    const h = await webHarness(root)
    await h.ctx.wikiVault.write({
      path: pagePath('entities/one.md'),
      frontmatter: frontmatter({ title: 'One', type: 'entity' }),
      body: 'One body.\n',
    })

    const pages = value(await h.post('list', json({}))).pages as readonly Record<string, unknown>[]

    expect(pages.map(entry => entry['path'])).toEqual(['concepts/alpha.md', 'concepts/beta.md', 'entities/one.md'])
    expect(pages[0]).toMatchObject({
      path: 'concepts/alpha.md',
      title: 'Alpha',
      type: 'concept',
      status: 'current',
      updated: '2026-10-07',
      tags: ['alpha'],
    })
  })

  it('reads one page with its links, backlinks, and cited sources', async () => {
    const h = await webHarness(root)

    const read = value(await h.post('read', json({ path: 'concepts/alpha.md' })))
    const page = read.page as {
      readonly path: string
      readonly body: string
      readonly revision: string
      readonly frontmatter: Record<string, unknown>
    }

    expect(page.path).toBe('concepts/alpha.md')
    expect(page.frontmatter).toMatchObject({
      title: 'Alpha',
      type: 'concept',
      status: 'current',
      sources: ['notes/paper.md'],
    })
    expect(page.body).toContain('the needle')
    expect(page.revision).toMatch(/^[0-9a-f]{64}$/u)
    expect(read.links).toEqual(['concepts/beta.md'])
    expect(read.backlinks).toEqual(['concepts/beta.md'])
    expect(read.sources).toEqual(['notes/paper.md'])
  })

  it('ranks the pages one literal query matches', async () => {
    const h = await webHarness(root)

    const hits = value(await h.post('search', json({ query: 'needle' }))).hits as readonly Record<string, unknown>[]

    expect(hits.map(hit => hit['path'])).toEqual(['concepts/alpha.md'])
    expect(hits[0]).toMatchObject({
      title: 'Alpha',
      type: 'concept',
      status: 'current',
      updated: '2026-10-07',
    })
    expect(String(hits[0]?.['excerpt'])).toContain('needle')
  })

  it('stores a page and answers its new revision', async () => {
    const h = await webHarness(root)
    const loaded = value(await h.post('read', json({ path: 'concepts/alpha.md' })))
    const revision = (loaded.page as { revision: string }).revision

    const saved = value(await h.post('save', json({
      path: 'concepts/alpha.md',
      frontmatter: { title: 'Alpha', type: 'concept', tags: ['alpha'], updated: '2026-10-08', status: 'current' },
      body: 'Rewritten body.\n',
      expectedRevision: revision,
    })))
    const page = saved.page as {
      readonly path: string
      readonly body: string
      readonly revision: string
      readonly frontmatter: Record<string, unknown>
    }

    expect(page.path).toBe('concepts/alpha.md')
    expect(page.revision).not.toBe(revision)
    expect(page.body).toContain('Rewritten body')
    expect(page.frontmatter).toMatchObject({ title: 'Alpha', updated: '2026-10-08' })
    expect(await readFile(join(root, 'wiki', 'concepts', 'alpha.md'), 'utf8')).toContain('Rewritten body')
  })

  it('reads a cited raw source and reports where the bound cut it', async () => {
    const h = await webHarness(root)

    const slice = value(await h.post('source', json({ path: 'notes/paper.md' })))
    expect(slice).toEqual({ path: 'notes/paper.md', text: 'The source text.\n', truncated: false })

    const bounded = value(await h.post('source', json({ path: 'raw/notes/paper.md', maxChars: 4 })))
    expect(bounded).toEqual({ path: 'raw/notes/paper.md', text: 'The ', truncated: true })
  })

  it('reports a raw source that does not exist and one whose body fails the schema', async () => {
    const h = await webHarness(root)

    expect(failure(await h.post('source', json({ path: 'notes/ghost.md' })))).toBe('prism-wiki/not-found')
    expect(failure(await h.post('source', json({ path: '' })))).toBe('prism-wiki/invalid-request')
    expect(failure(await h.post('source', json({ path: 'notes/paper.md', maxChars: 0 }))))
      .toBe('prism-wiki/invalid-request')
  })

  it('refuses a browser creation over an existing page and leaves it unchanged', async () => {
    const h = await webHarness(root)
    const before = await readFile(join(root, 'wiki', 'concepts', 'alpha.md'), 'utf8')

    const refused = await h.post('save', json({
      path: 'concepts/alpha.md',
      frontmatter: { title: 'Replacement', type: 'concept', tags: [], updated: '2026-10-08', status: 'current' },
      body: 'Replaced without a revision.\n',
    }))

    expect(refused.body).toMatchObject({
      error: { code: 'prism-wiki/revision-conflict', current: { path: 'concepts/alpha.md' } },
    })
    expect(JSON.stringify(refused.body)).toContain('Alpha carries the needle')
    expect(await readFile(join(root, 'wiki', 'concepts', 'alpha.md'), 'utf8')).toBe(before)
  })

  it('creates a page that does not exist yet without a revision, and refuses one whose stored copy cannot be parsed', async () => {
    const h = await webHarness(root)

    const created = value(await h.post('save', json({
      path: 'concepts/gamma.md',
      frontmatter: { title: 'Gamma', type: 'concept', tags: [], updated: '2026-10-08', status: 'current' },
      body: 'Gamma body.\n',
    })))
    expect((created.page as { path: string }).path).toBe('concepts/gamma.md')

    await writeFile(
      join(root, 'wiki', 'concepts', 'broken.md'),
      '---\ntitle: Broken\ntype: concept\ntags: [x]\n---\n\nBody.\n',
      'utf8',
    )
    expect(failure(await h.post('save', json({
      path: 'concepts/broken.md',
      frontmatter: { title: 'Repaired', type: 'concept', tags: [], updated: '2026-10-08', status: 'current' },
      body: 'Repaired body.\n',
    })))).toBe('prism-wiki/revision-conflict')
  })

  it('answers the vault health report', async () => {
    const h = await webHarness(root)

    const report = value(await h.post('lint', json({}))).report as {
      readonly pages: number
      readonly sources: number
      readonly findings: readonly unknown[]
    }

    expect(report.pages).toBe(2)
    expect(report.sources).toBe(1)
    expect(report.findings).toEqual([])
  })

  it('refuses a body that is not JSON and one that fails the route schema', async () => {
    const h = await webHarness(root)

    expect(failure(await h.post('read', 'not json'))).toBe('prism-wiki/invalid-request')
    expect(failure(await h.post('read', json({ path: 7 })))).toBe('prism-wiki/invalid-request')
    expect(failure(await h.post('save', json({ path: 'concepts/alpha.md' })))).toBe('prism-wiki/invalid-request')
  })

  it('refuses a stale revision and leaves the stored page unchanged', async () => {
    const h = await webHarness(root)
    const loaded = value(await h.post('read', json({ path: 'concepts/alpha.md' })))
    const original = (loaded.page as { revision: string }).revision
    const accepted = value(await h.post('save', json({
      path: 'concepts/alpha.md',
      frontmatter: { title: 'Alpha', type: 'concept', tags: ['alpha'], updated: '2026-10-08', status: 'current' },
      body: 'First replacement.\n',
      expectedRevision: original,
    })))
    expect((accepted.page as { revision: string }).revision).not.toBe(original)

    const refused = await h.post('save', json({
      path: 'concepts/alpha.md',
      frontmatter: { title: 'Alpha', type: 'concept', tags: ['alpha'], updated: '2026-10-09', status: 'current' },
      body: 'Second replacement.\n',
      expectedRevision: original,
    }))

    // The refusal carries the page that is actually stored, so the editor can show it.
    expect(refused.body).toMatchObject({
      error: { code: 'prism-wiki/revision-conflict', current: { path: 'concepts/alpha.md' } },
    })
    expect(failure(refused)).toBe('prism-wiki/revision-conflict')
    const stored = await readFile(join(root, 'wiki', 'concepts', 'alpha.md'), 'utf8')
    expect(stored).toContain('First replacement')
    expect(stored).not.toContain('Second replacement')
  })

  it('reports a page that does not exist', async () => {
    const h = await webHarness(root)

    expect(failure(await h.post('read', json({ path: 'concepts/ghost.md' })))).toBe('prism-wiki/not-found')
  })

  it('keeps listing the vault when one page file cannot be parsed', async () => {
    const h = await webHarness(root)
    await writeFile(
      join(root, 'wiki', 'concepts', 'broken.md'),
      '---\ntitle: Broken\ntype: concept\ntags: [x]\n---\n\nBody.\n',
      'utf8',
    )

    const answer = await h.post('list', json({}))

    expect(answer.status).toBe(200)
    const pages = (answer.body.value as { pages: readonly { path: string }[] }).pages
    expect(pages.map(entry => entry.path)).toContain('concepts/alpha.md')
    expect(pages.map(entry => entry.path)).not.toContain('concepts/broken.md')
  })

  it('answers a read of an unparsable page as a vault failure, not a missing page', async () => {
    const h = await webHarness(root)
    await writeFile(
      join(root, 'wiki', 'concepts', 'broken.md'),
      '---\ntitle: Broken\ntype: concept\ntags: [x]\n---\n\nBody.\n',
      'utf8',
    )

    expect(failure(await h.post('read', json({ path: 'concepts/broken.md' })))).toBe('prism-wiki/failed')
  })

  it('reports an unexpected save failure as the failure it is', async () => {
    const h = await webHarness(root)
    // A page path held open by a directory makes the existence probe fail with
    // a filesystem error the vault does not classify.
    await mkdir(join(root, 'wiki', 'concepts', 'solid.md'))

    const answer = await h.post('save', json({
      path: 'concepts/solid.md',
      frontmatter: { title: 'Solid', type: 'concept', tags: [], updated: '2026-10-08', status: 'current' },
      body: 'Body.\n',
    }))

    expect(failure(answer)).toBe('prism-wiki/failed')
    expect((answer.body.error as { message: string }).message).toMatch(/EISDIR|directory/iu)
  })

  it('narrows a search by every filter the body carries', async () => {
    const h = await webHarness(root)

    const hits = value(await h.post('search', json({
      query: 'needle',
      type: 'concept',
      tags: ['alpha'],
      status: 'current',
      limit: 5,
    }))).hits as readonly Record<string, unknown>[]

    expect(hits.map(hit => hit['path'])).toEqual(['concepts/alpha.md'])
  })

  it('withdraws every route on disposal', async () => {
    const h = await webHarness(root)

    await h.webFiber.dispose()

    for (const endpoint of ROUTES) {
      expect((await h.send(endpoint, json({}))).status, endpoint).toBe(404)
    }
  })
})
