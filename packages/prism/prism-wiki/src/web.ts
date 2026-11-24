/**
 * Browser-facing wiki operations: exact Fetch routes under Connection's shared
 * `/api` channel. Every route answers one `WikiResponse` envelope, and every
 * operation delegates to `ctx.wikiVault`, so the Knowledge page reads and writes
 * the same vault the model's `wiki_*` tools do.
 *
 * Each request body is validated against the wire types in `web-contract.ts`
 * before any vault method sees it. Semantic rules — path legality, frontmatter
 * agreement with the page's directory, revision freshness — stay with the
 * service.
 *
 * Routes rather than a channel: a plugin-registered RPC channel is created
 * through `HostConnectionService`'s own context, which does not inject
 * `webServer`, so `ctx.connection.rpc.handle()` throws at load. The exact
 * Fetch-route registry has no such dependency.
 *
 * `webServer` is declared because Connection's registries read services through
 * the CALLER's context: `HostConnectionService.fetch` is a getter, and Cordis
 * invokes a service getter with `this.ctx` rebound to the reader, so anything
 * that registry touches resolves against this plugin's `inject` set. Declaring
 * it also keeps the row pending — rather than failing — in a profile that
 * composes no web server, which is the same profile that composes no browser
 * Connection.
 * @module @prism/prism-wiki/web
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
// Type-only: activates the `ctx.connection` Context merge these routes register on.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: activates the `ctx.webServer` Context merge this row declares.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { WikiVaultError, brandPagePath, brandSourcePath } from './service.ts'
import type { WikiPage, WikiPageDraft, WikiPagePath, WikiPageStatus, WikiPageType, WikiSearchFilter } from './types.ts'
import type {
  WikiLintValue, WikiListValue, WikiPagePayload, WikiPageSummary, WikiReadValue, WikiResponse,
  WikiSaveValue, WikiSearchValue, WikiSourceValue,
} from './web-contract.ts'

/** Plugin name the Cordis loader reports for this row. */
export const name = 'prism-wiki-web'

/** The vault, the Fetch registry the routes register on, and the web server the row stays pending without. */
export const inject = ['wikiVault', 'connection', 'webServer'] as const

/** Path prefix every route of this plugin owns below Connection's `/api` channel. */
const BASE = '/api/prism-wiki'

/** Hits one search answers with when its body states no limit; the vault's configured cap still applies on top. */
const DEFAULT_SEARCH_LIMIT = 20

/** Page kinds the vault accepts; mirrors `WikiPageType`. */
const PAGE_TYPES = [
  'overview',
  'entity',
  'concept',
  'source',
  'comparison',
  'synthesis',
] as const satisfies readonly WikiPageType[]

/** Page states the vault accepts; mirrors `WikiPageStatus`. */
const PAGE_STATUSES = [
  'current',
  'stub',
  'superseded',
  'disputed',
] as const satisfies readonly WikiPageStatus[]

/**
 * Frontmatter one save body carries. `title`, `type`, `tags`, `updated`, and
 * `status` are required; the remaining four fields are optional on the wire and
 * take their empty value here.
 */
const frontmatterBody = z.object({
  title: z.string(),
  type: z.enum(PAGE_TYPES),
  tags: z.array(z.string()),
  updated: z.string(),
  status: z.enum(PAGE_STATUSES),
  sources: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  confidence: z.number().nullable().default(null),
  contradicts: z.array(z.string()).default([]),
})

/** One JSON body addressing a page by vault-relative path. */
const pathBody = z.object({ path: z.string().min(1) })

/** One JSON body carrying a page write; a stated revision is echoed to the service so a stale editor is refused. */
const saveBody = z.object({
  path: z.string().min(1),
  frontmatter: frontmatterBody,
  body: z.string(),
  expectedRevision: z.string().min(1).optional(),
})

/** One JSON body carrying a literal search with optional narrowing. */
const searchBody = z.object({
  query: z.string(),
  type: z.enum(PAGE_TYPES).optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(PAGE_STATUSES).optional(),
  limit: z.number().int().min(1).optional(),
})

/** One JSON body carrying a raw-source read; the deployment's character cap still applies. */
const sourceBody = z.object({
  path: z.string().min(1),
  maxChars: z.number().int().min(1).optional(),
})

/**
 * Refuse a browser write that carries no revision while the vault already holds
 * the page. A browser draft without a revision is a creation, so the page it
 * would replace is reported back instead of overwritten; a stored page that
 * cannot be parsed is still refused, with no page to compare.
 * @param ctx - Registrant context carrying the vault service.
 * @param path - The page the save addresses.
 * @returns Nothing, when the path is free or the caller sent a revision.
 * @throws WikiVaultError with code `WIKI_REVISION_CONFLICT` when the page exists.
 */
async function refuseOverwrite(ctx: Context, path: WikiPagePath): Promise<void> {
  let stored: WikiPage
  try {
    stored = (await ctx.wikiVault.read(path)).page
  } catch (error) {
    if (error instanceof WikiVaultError && error.code === 'WIKI_PAGE_NOT_FOUND') return
    // An unparsable stored page cannot be compared, but it must not be replaced
    // by a write that never saw it.
    if (error instanceof WikiVaultError && error.code === 'WIKI_FRONTMATTER_INVALID') {
      throw new WikiVaultError(
        `page "${path}" exists but its frontmatter cannot be parsed, so this save would replace it unseen`,
        'WIKI_REVISION_CONFLICT',
      )
    }
    throw error
  }
  throw new WikiVaultError(
    `page "${path}" already exists: load it and save with its revision to replace it`,
    'WIKI_REVISION_CONFLICT',
    stored,
  )
}

/**
 * Register every browser route on Connection's shared Fetch registry.
 * @param ctx - Registrant context carrying `ctx.wikiVault` and `ctx.connection`.
 * @returns Nothing; every route is an effect that leaves with this plugin's fiber.
 */
export function apply(ctx: Context): void {
  /** Register one route so its contribution leaves with this plugin's fiber. */
  const route = (
    routeName: string,
    path: string,
    serve: (request: Request) => Promise<Response>,
  ): void => {
    ctx.effect(
      () => ctx.connection.fetch.register({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => guard(() => serve(request)),
      } satisfies ConnectionFetchRoute),
      `prismWiki.web.${routeName}`,
    )
  }

  // The vault tree comes from the file layer the service itself lists for
  // `lint()` and `status()`, because a search hit carries no tags. The entries
  // arrive ordered by path, so the listing needs no sort of its own.
  route('list', `${BASE}/list`, async () => {
    const files = await ctx.wikiVault.ready()
    const pages: readonly WikiPageSummary[] = (await files.listPageEntries())
      .map(entry => ({
        path: entry.page.path.toString(),
        title: entry.page.frontmatter.title,
        type: entry.page.frontmatter.type,
        status: entry.page.frontmatter.status,
        updated: entry.page.frontmatter.updated,
        tags: entry.page.frontmatter.tags,
      }))
    const value: WikiListValue = { pages }
    return ok(value)
  })

  route('read', `${BASE}/read`, json(async (body) => {
    const { path } = pathBody.parse(body)
    const view = await ctx.wikiVault.read(brandPagePath(path))
    const value: WikiReadValue = {
      page: pagePayload(view.page),
      links: view.links.map(link => link.toString()),
      backlinks: view.backlinks.map(link => link.toString()),
      sources: view.sources,
    }
    return ok(value)
  }))

  route('search', `${BASE}/search`, json(async (body) => {
    const parsed = searchBody.parse(body)
    const filter: WikiSearchFilter = {
      ...(parsed.type === undefined ? {} : { type: parsed.type }),
      ...(parsed.tags === undefined ? {} : { tags: parsed.tags }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      limit: parsed.limit ?? DEFAULT_SEARCH_LIMIT,
    }
    const hits = await ctx.wikiVault.search(parsed.query, filter)
    const value: WikiSearchValue = { hits }
    return ok(value)
  }))

  route('save', `${BASE}/save`, json(async (body) => {
    const parsed = saveBody.parse(body)
    const path = brandPagePath(parsed.path)
    if (parsed.expectedRevision === undefined) await refuseOverwrite(ctx, path)
    const draft: WikiPageDraft = {
      path,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      ...(parsed.expectedRevision === undefined ? {} : { expectedRevision: parsed.expectedRevision }),
    }
    const page = await ctx.wikiVault.write(draft)
    const value: WikiSaveValue = { page: pagePayload(page) }
    return ok(value)
  }))

  route('source', `${BASE}/source`, json(async (body) => {
    const parsed = sourceBody.parse(body)
    const slice = await ctx.wikiVault.readSource(brandSourcePath(parsed.path), parsed.maxChars)
    const value: WikiSourceValue = { path: parsed.path, text: slice.text, truncated: slice.truncated }
    return ok(value)
  }))

  route('lint', `${BASE}/lint`, async () => {
    const value: WikiLintValue = { report: await ctx.wikiVault.lint() }
    return ok(value)
  })
}

/**
 * Wrap one JSON-body operation in this plugin's envelope.
 * @param operation - Body reader answering the operation result.
 * @returns The Fetch handler for that route.
 */
function json(
  operation: (body: unknown) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    let body: unknown
    try {
      body = await request.json()
    } catch (error) {
      return fail('prism-wiki/invalid-request', `the request body is not JSON: ${reasonOf(error)}`)
    }
    return await operation(body)
  }
}

/**
 * Wrap one route's work in this plugin's failure vocabulary.
 * @param operation - The route's work.
 * @returns The route's answer, or the mapped failure envelope.
 */
async function guard(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation()
  } catch (error) {
    return failureOf(error)
  }
}

/**
 * Project one thrown value onto a failure envelope. A write refused because the
 * stored page moved and a read of a page that is not there answer the codes the
 * page branches on; every other wiki failure carries the error's own message.
 * @param error - One thrown value.
 * @returns The failure envelope with HTTP 400.
 */
function failureOf(error: unknown): Response {
  if (error instanceof z.ZodError) return fail('prism-wiki/invalid-request', error.message)
  if (error instanceof WikiVaultError) {
    if (error.code === 'WIKI_REVISION_CONFLICT') {
      const current = error.current
      return fail(
        'prism-wiki/revision-conflict',
        error.message,
        current === undefined ? undefined : pagePayload(current),
      )
    }
    if (error.code === 'WIKI_PAGE_NOT_FOUND' || error.code === 'WIKI_SOURCE_NOT_FOUND') {
      return fail('prism-wiki/not-found', error.message)
    }
    return fail('prism-wiki/failed', error.message)
  }
  return fail('prism-wiki/failed', reasonOf(error))
}

/**
 * Answer one successful operation.
 * @param value - The value the route's wire type declares.
 * @returns The JSON answer carrying `{ ok: true, value }`.
 */
function ok(value: unknown): Response {
  const body: WikiResponse<unknown> = { ok: true, value }
  return Response.json(body)
}

/**
 * Answer one rejected operation with the status the page reports as an error.
 * @param code - Stable discriminant the page branches on.
 * @param message - One plain-language sentence.
 * @param current - The stored page, when a revision conflict refused the write.
 * @returns The JSON answer carrying `{ ok: false, error }` and HTTP 400.
 */
function fail(code: string, message: string, current?: WikiPagePayload): Response {
  const body: WikiResponse<never> = current === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, current } }
  return Response.json(body, { status: 400 })
}

/**
 * Project one stored page onto its wire payload.
 * @param page - The stored page.
 * @returns The payload the browser renders, with plain-string identity fields.
 */
function pagePayload(page: WikiPage): WikiPagePayload {
  return {
    path: page.path.toString(),
    frontmatter: page.frontmatter,
    body: page.body,
    revision: page.revision,
  }
}

/**
 * Operator-readable text for one thrown value.
 * @param error - One thrown value.
 * @returns The error's own message, or the value rendered as text.
 */
function reasonOf(error: unknown): string {
  /* v8 ignore next -- every failure a route or the vault raises is an Error instance. */
  return error instanceof Error ? error.message : String(error)
}
