/**
 * The browser routes: envelope shape, body validation, and the operator surface
 * they expose.
 *
 * The routes are driven through the exact objects they register with the
 * Connection registry, so an assertion here is an assertion about what the page
 * receives over HTTP — not about a service method behind it.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { createAgent, mountMemory } from './fixtures/harness.ts'
import * as MemoryWeb from '../src/web.ts'
import type { MemoryOverview, MemoryRememberValue, MemoryResponse, MemoryRow, MemoryRowsValue, MemoryReviewValue } from '../src/web-contract.ts'

const owned = new Set<Context>()

/** Mounted routes, keyed by the path each registered under. */
const routes = new Map<string, ConnectionFetchRoute>()

afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
  routes.clear()
})

/** Stand-in for the Connection registry the routes register against. */
const connectionStub = {
  name: 'connection-stub',
  apply(ctx: Context): void {
    ctx.provide('connection', {
      fetch: {
        register(route: ConnectionFetchRoute): () => Promise<void> {
          routes.set(route.path, route)
          return () => {
            routes.delete(route.path)
            return Promise.resolve()
          }
        },
      },
    })
  },
}

/** Stand-in for the web server the row declares so it stays pending without one. */
const webServerStub = {
  name: 'web-server-stub',
  apply(ctx: Context): void {
    ctx.provide('webServer', {})
  },
}

/**
 * Mount the memory rows and the route row.
 * @param config - field overrides for the plugin's Config row.
 * @returns the live context, disposed by the suite.
 */
async function boot(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = await mountMemory({ config })
  await ctx.plugin(connectionStub)
  await ctx.plugin(webServerStub)
  await ctx.plugin(MemoryWeb)
  owned.add(ctx)
  return ctx
}

/**
 * Post one JSON body to one route.
 * @param path - the route path below `/api`.
 * @param body - the body to encode, or a raw string to send verbatim.
 * @returns the decoded envelope.
 */
async function post<T>(path: string, body: unknown = {}): Promise<MemoryResponse<T>> {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`no route registered at ${path}`)
  const response = await route.fetch(new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  expect(response.status).toBe(200)
  return await response.json() as MemoryResponse<T>
}

/**
 * Post one request whose body is rejected before any operation runs.
 * @param path - the route path below `/api`.
 * @param body - the body to encode, or a raw string to send verbatim.
 * @returns the failure envelope's code.
 */
async function refusal(path: string, body: unknown): Promise<string> {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`no route registered at ${path}`)
  const response = await route.fetch(new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  expect(response.status).toBe(400)
  const envelope = await response.json() as MemoryResponse<unknown>
  if (envelope.ok) throw new Error('expected a failure envelope')
  return envelope.error.code
}

describe('the memory routes', () => {
  it('registers one route per operation below the plugin prefix', async () => {
    await boot()
    expect([...routes.keys()].sort()).toEqual([
      '/api/prism-memory/overview',
      '/api/prism-memory/remember',
      '/api/prism-memory/review',
      '/api/prism-memory/search',
    ])
  })

  it('reports counts, the review inbox, and the newest claims in one read', async () => {
    const ctx = await boot({ requireApproval: true })
    const agent = await createAgent(ctx, 'overview', 'C:/work/overview')
    await ctx.prismMemory.remember({
      text: 'the release branch is release/2026-02',
      scope: 'project',
      layer: 'project',
    }, agent)

    const answer = await post<MemoryOverview>('/api/prism-memory/overview')
    if (!answer.ok) throw new Error('the overview route answered a failure')
    expect(answer.value.counts.total).toBe(1)
    expect(answer.value.counts.byStatus.pending).toBe(1)
    expect(answer.value.counts.byLayer.project).toBe(1)
    // A page has no session, so a project claim only reaches it through the
    // operator read.
    expect(answer.value.pending.map(row => row.scope)).toEqual(['project'])
    expect(answer.value.recent).toEqual([])
  })

  it('searches the whole corpus and lists the newest claims for an empty query', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'search', 'C:/work/search')
    await ctx.prismMemory.remember({ text: 'the release branch is release/2026-02', scope: 'project' }, agent)

    const found = await post<MemoryRowsValue>('/api/prism-memory/search', { query: 'release branch' })
    if (!found.ok) throw new Error('the search route answered a failure')
    expect(found.value.rows.map(row => row.scope)).toEqual(['project'])

    const recent = await post<MemoryRowsValue>('/api/prism-memory/search', { query: '' })
    if (!recent.ok) throw new Error('the search route answered a failure')
    expect(recent.value.rows).toHaveLength(1)
  })

  it('stores an operator claim with its layer and returns the created row', async () => {
    const ctx = await boot()
    const answer = await post<MemoryRememberValue>('/api/prism-memory/remember', {
      text: 'the staging credentials rotate on the first monday',
      layer: 'rule',
    })
    if (!answer.ok) throw new Error('the remember route answered a failure')
    expect(answer.value.outcome).toBe('created')
    expect(answer.value.row.layer).toBe('rule')
    expect(answer.value.row.sessionId).toBeNull()
    expect(ctx.prismMemory.all()[0]?.origin).toBe('operator')
  })

  it('settles a pending claim through the review route', async () => {
    const ctx = await boot({ requireApproval: true })
    const agent = await createAgent(ctx, 'review', 'C:/work/review')
    const stored = await ctx.prismMemory.remember({ text: 'the nightly job runs at 02:00', scope: 'project' }, agent)

    const approved = await post<MemoryReviewValue>('/api/prism-memory/review', {
      id: stored.record.id,
      decision: 'approve',
    })
    if (!approved.ok) throw new Error('the review route answered a failure')
    expect(approved.value.row.status).toBe('active')

    // A second settlement has nothing left to settle, and says so instead of
    // silently succeeding.
    expect(await refusal('/api/prism-memory/review', { id: stored.record.id, decision: 'approve' }))
      .toBe('PRISM_MEMORY_NOT_PENDING')
  })

  it('rejects an unreadable body and an unknown record', async () => {
    await boot()
    expect(await refusal('/api/prism-memory/remember', { text: '' })).toBe('prism-memory/invalid-request')
    expect(await refusal('/api/prism-memory/remember', 'not json')).toBe('prism-memory/invalid-request')
    expect(await refusal('/api/prism-memory/search', { query: 42 })).toBe('prism-memory/invalid-request')
    expect(await refusal('/api/prism-memory/review', { id: 'mem_missing', decision: 'approve' }))
      .toBe('PRISM_MEMORY_NOT_FOUND')
  })

  it('projects a row without the fields the page does not render', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'projection')
    await ctx.prismMemory.remember({ text: 'the domain stays at version 1' }, agent)

    const answer = await post<MemoryRowsValue>('/api/prism-memory/search', { query: 'domain version' })
    if (!answer.ok) throw new Error('the search route answered a failure')
    const row = answer.value.rows[0] as MemoryRow
    expect(Object.keys(row).sort()).toEqual([
      'confidence', 'createdAt', 'dueAt', 'expiresAt', 'id', 'kind', 'layer',
      'scope', 'sessionId', 'status', 'tags', 'text',
    ])
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
  })
})
