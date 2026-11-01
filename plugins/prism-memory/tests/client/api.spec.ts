/**
 * The browser request client: body shape, envelope decoding, and the failure a
 * person sees when the Host answers something this bundle cannot read.
 *
 * `fetch` is stubbed because the transport is the Host's; everything on this
 * side of the wire is the code under test.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryApi, MemoryRequestError } from '../../src/client/api.ts'

const original = globalThis.fetch
afterEach(() => {
  globalThis.fetch = original
})

/** One request the client issued. */
interface Sent {
  /** Request URL. */
  readonly url: string
  /** JSON body as sent. */
  readonly body: unknown
}

/**
 * Replace `fetch` with one canned answer.
 * @param answer - the decoded JSON value to answer with.
 * @param sent - collector receiving what the client sent.
 * @returns nothing; the stub is installed on the global.
 */
function stubFetch(answer: unknown, sent: Sent[]): void {
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    sent.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
    return Promise.resolve(Response.json(answer))
  }
}

/** Capture the MemoryRequestError a promise rejects with. */
async function errorOf(operation: Promise<unknown>): Promise<MemoryRequestError> {
  try {
    await operation
  } catch (error: unknown) {
    if (error instanceof MemoryRequestError) return error
    throw error
  }
  throw new Error('expected the operation to reject')
}

/** One complete row, as the Host projects it. */
const row = {
  id: 'mem_00000000-0000-4000-8000-000000000000',
  layer: 'fact',
  kind: 'fact',
  scope: 'global',
  status: 'active',
  text: 'the domain stays at version 1',
  tags: ['domain'],
  confidence: 1,
  createdAt: '2026-10-05T00:00:00.000Z',
  dueAt: null,
  expiresAt: null,
  sessionId: null,
}

describe('the browser request client', () => {
  it('addresses this plugin routes, relative to the host mount', async () => {
    const sent: Sent[] = []
    stubFetch({ ok: true, value: { counts: { total: 0, byStatus: {}, byLayer: {} }, pending: [], recent: [] } }, sent)
    await createMemoryApi().load()
    expect(sent[0]?.url).toBe('api/prism-memory/overview')
  })

  it('sends the query and answers the rows it decoded', async () => {
    const sent: Sent[] = []
    stubFetch({ ok: true, value: { rows: [row] } }, sent)
    const found = await createMemoryApi().search('domain version')
    expect(sent[0]?.body).toEqual({ query: 'domain version' })
    expect(found.map(entry => entry.id)).toEqual([row.id])
  })

  it('sends the operator write with its layer', async () => {
    const sent: Sent[] = []
    stubFetch({ ok: true, value: { row, outcome: 'created', duplicates: [] } }, sent)
    const stored = await createMemoryApi().remember(row.text, 'rule')
    expect(sent[0]?.body).toEqual({ text: row.text, layer: 'rule' })
    expect(stored.outcome).toBe('created')
  })

  it('answers the settled row of a review decision', async () => {
    const sent: Sent[] = []
    stubFetch({ ok: true, value: { row: { ...row, status: 'active' } } }, sent)
    const settled = await createMemoryApi().review(row.id, 'approve')
    expect(sent[0]?.body).toEqual({ id: row.id, decision: 'approve' })
    expect(settled.status).toBe('active')
  })

  it('surfaces the host failure code and message', async () => {
    stubFetch({ ok: false, error: { code: 'PRISM_MEMORY_NOT_FOUND', message: 'unknown memory id: mem_1' } }, [])
    const error = await errorOf(createMemoryApi().review('mem_1', 'approve'))
    expect(error.code).toBe('PRISM_MEMORY_NOT_FOUND')
    expect(error.message).toContain('unknown memory id')
  })

  it('refuses an answer whose value it cannot read', async () => {
    stubFetch({ ok: true, value: { rows: [{ id: 'not a row' }] } }, [])
    const error = await errorOf(createMemoryApi().search('anything'))
    expect(error.code).toBe('prism-memory/invalid-response')
  })

  it('refuses an answer that is not this plugin envelope', async () => {
    stubFetch({ hello: 'world' }, [])
    const error = await errorOf(createMemoryApi().load())
    expect(error.code).toBe('prism-memory/invalid-response')
  })

  it('reports an unreachable host as such instead of throwing a raw TypeError', async () => {
    globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'))
    const error = await errorOf(createMemoryApi().load())
    expect(error.code).toBe('prism-memory/unreachable')
  })
})
