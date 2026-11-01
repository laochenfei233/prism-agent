/**
 * Browser-facing memory operations: one exact Fetch route per operation on
 * Connection's shared `/api` channel, each answering one JSON envelope.
 *
 * Every route reads and writes through the service's operator surface, which has
 * no calling session: a page governs the whole corpus rather than one session's
 * slice. `webServer` is declared alongside `connection` because Connection's
 * route registry reads services through the caller's context; declaring it also
 * leaves this row pending, rather than failing, in a profile that composes no
 * web server.
 *
 * @module @prism/prism-memory/web
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
// Type-only: activates the `ctx.connection` Context merge these routes register on.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: activates the `ctx.webServer` Context merge this row declares.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { MemoryRecord } from './domain.ts'
import { layerOf, MEMORY_LAYERS } from './layers.ts'
import { isLive, MEMORY_KINDS } from './memory.ts'
import {
  MEMORY_OVERVIEW_PATH,
  MEMORY_REMEMBER_PATH,
  MEMORY_REVIEW_PATH,
  MEMORY_SEARCH_PATH,
} from './routes.ts'
import { PrismMemoryError, type PrismMemoryService } from './service.ts'
import type {
  MemoryCounts,
  MemoryFailure,
  MemoryOverview,
  MemoryRememberValue,
  MemoryReviewValue,
  MemoryRow,
  MemoryRowsValue,
} from './web-contract.ts'

/** Cordis plugin name for the browser route row. */
export const name = 'prism-memory-web'

/** Registries and services this row contributes to. */
export const inject = ['prismMemory', 'connection', 'webServer'] as const

/** Newest live claims the page's initial paint lists. */
const RECENT_LIMIT = 100

/** Pending claims the review inbox shows at the head of the queue. */
const PENDING_LIMIT = 50

/** One literal search body. */
const searchBody = z.object({
  query: z.string(),
  limit: z.number().int().positive().optional(),
})

/** One operator write body; the semantics stay with the service. */
const rememberBody = z.object({
  text: z.string().min(1),
  layer: z.enum(MEMORY_LAYERS).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
})

/** One review settlement body. */
const reviewBody = z.object({
  id: z.string().min(1),
  decision: z.enum(['approve', 'reject']),
  note: z.string().max(2000).optional(),
})

/**
 * Register every browser route.
 * @param ctx - Registrant context carrying `ctx.prismMemory` and `ctx.connection`.
 */
export function apply(ctx: Context): void {
  const memory = ctx.prismMemory
  /** Register one route so its contribution leaves with this plugin's fiber. */
  const route = (id: string, path: string, fetch: (request: Request) => Promise<Response>): void => {
    ctx.effect(
      () => ctx.connection.fetch.register({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => guard(() => fetch(request)),
      } satisfies ConnectionFetchRoute),
      `prismMemory.web.${id}`,
    )
  }

  route('overview', MEMORY_OVERVIEW_PATH, () => Promise.resolve(ok(overviewOf(memory))))

  route('search', MEMORY_SEARCH_PATH, json((body) => {
    const { query, limit } = searchBody.parse(body)
    const rows = query.trim() === ''
      ? memory.operatorRecords()
        .filter(record => isLive(record, Date.now()))
        .slice(0, limit ?? RECENT_LIMIT)
      : memory.operatorSearch(query, limit === undefined ? {} : { limit }).map(hit => hit.record)
    return Promise.resolve(ok<MemoryRowsValue>({ rows: rows.map(rowOf) }))
  }))

  route('remember', MEMORY_REMEMBER_PATH, json(async (body) => {
    const parsed = rememberBody.parse(body)
    const result = await memory.remember({
      text: parsed.text,
      origin: 'operator',
      ...parsed.layer === undefined ? {} : { layer: parsed.layer },
      ...parsed.kind === undefined ? {} : { kind: parsed.kind },
    }, undefined)
    const value: MemoryRememberValue = {
      row: rowOf(result.record),
      outcome: result.outcome,
      duplicates: result.duplicates.map(entry => ({ id: entry.id, text: entry.text })),
    }
    return ok(value)
  }))

  route('review', MEMORY_REVIEW_PATH, json(async (body) => {
    const { id, decision, note } = reviewBody.parse(body)
    const record = decision === 'approve'
      ? await memory.operatorApprove(id, note)
      : await memory.operatorReject(id, note)
    const value: MemoryReviewValue = { row: rowOf(record) }
    return ok(value)
  }))
}

/**
 * Compose the page's initial state from one read of the whole store.
 * @param memory - The memory service.
 * @returns counts, the review inbox, and the newest claims.
 */
function overviewOf(memory: PrismMemoryService): MemoryOverview {
  const records = memory.operatorRecords()
  const counts: MemoryCounts = {
    total: records.length,
    byStatus: countBy(records, record => record.status),
    byLayer: countBy(records, record => layerOf(record)),
  }
  return {
    counts,
    // The queue head is the oldest decision, so the person settles in the order
    // the claims arrived rather than in the order they happen to be newest.
    pending: records
      .filter(record => record.status === 'pending')
      .slice(-PENDING_LIMIT)
      .reverse()
      .map(rowOf),
    // The live corpus, matching what injection and search can reach: the inbox
    // above shows what is still waiting, so the two never repeat one record.
    recent: records
      .filter(record => isLive(record, Date.now()))
      .slice(0, RECENT_LIMIT)
      .map(rowOf),
  }
}

/** Count records by one key. */
function countBy(records: readonly MemoryRecord[], key: (record: MemoryRecord) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const record of records) {
    const name = key(record)
    counts[name] = (counts[name] ?? 0) + 1
  }
  return counts
}

/** Project one stored record onto the fields the page renders. */
function rowOf(record: MemoryRecord): MemoryRow {
  return {
    id: record.id,
    layer: layerOf(record),
    kind: record.kind,
    scope: record.scope,
    status: record.status,
    text: record.text,
    tags: [...record.tags],
    confidence: record.confidence,
    createdAt: new Date(record.createdAt).toISOString(),
    dueAt: isoOrNull(record.dueAt),
    expiresAt: isoOrNull(record.expiresAt),
    sessionId: record.evidence.sessionId,
  }
}

/** ISO-8601 rendering of one optional epoch-millisecond stamp, or null. */
function isoOrNull(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString()
}

/**
 * Wrap one JSON-body operation in this plugin's envelope.
 * @param operation - body reader answering the operation result.
 * @returns the Fetch handler for that route.
 */
function json(operation: (body: unknown) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    let body: unknown
    try {
      body = await request.json()
    } catch (error) {
      return fail('prism-memory/invalid-request', `the request body is not JSON: ${reasonOf(error)}`)
    }
    return await operation(body)
  }
}

/** Project one operation failure onto this plugin's failure vocabulary. */
async function guard(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof PrismMemoryError) return fail(error.code, error.message)
    if (error instanceof z.ZodError) return fail('prism-memory/invalid-request', error.message)
    return fail('prism-memory/failure', reasonOf(error))
  }
}

/** Answer one successful operation. */
function ok<T>(value: T): Response {
  return Response.json({ ok: true, value } satisfies { ok: true, value: T })
}

/** Answer one failed operation with the status the page reports as an error. */
function fail(code: string, message: string): Response {
  const failure: MemoryFailure = { code, message }
  return Response.json({ ok: false, error: failure }, { status: 400 })
}

/** Operator-readable text for one thrown value. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Plugin descriptor consumed by the Cordis loader. */
export default { name, inject, apply }
