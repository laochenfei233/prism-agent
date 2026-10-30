/**
 * Settings import of conversation history from other coding agents.
 *
 * The Host half owns two authenticated Fetch routes: source discovery and the
 * plan/apply operation. The browser half registers the settings section and
 * calls those routes. Reading foreign stores is read-only; writes go through
 * `SessionPersistence` and `WorkspaceRegistry`.
 *
 * @module @prism/prism-session-import
 */

import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import Schema from '@deepseek-ai/schemastery'
import { brandNumber } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
// Type-only: the ctx.sessionPersistence, ctx.workspaceRegistry, and
// ctx.sessionProjectionCache merges.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-workspace'
import { SessionImportEngine, ImportEngineError } from './engine.ts'
import { isSourceId } from './catalog.ts'
import { SESSION_IMPORT_CANDIDATES_PATH, SESSION_IMPORT_PATH } from './routes.ts'
import { listOf, recordOf, stringOf } from './sources/shared.ts'
import type {
  ImportApplyRequest,
  ImportFailureBody,
  ImportPlanRequest,
  ImportSourceId,
} from './types.ts'

export { ImportEngineError } from './engine.ts'
export type { SessionImportEngineOptions } from './engine.ts'
export type * from './types.ts'
export { SESSION_IMPORT_CANDIDATES_PATH, SESSION_IMPORT_PATH } from './routes.ts'

export const name = 'session-import'
export const inject = ['connection', 'sessionPersistence', 'workspaceRegistry']

/** Import policy and per-source root overrides. */
export interface Config {
  /** Absolute root overrides keyed by source id. */
  readonly roots?: Partial<Record<ImportSourceId, string>>
  /** Maximum retained messages per imported conversation. @default 2000 */
  readonly maxMessages?: number
  /** UTF-8 byte budget for one imported message. @default 32768 */
  readonly maxMessageTextBytes?: number
}

/** Validate import policy. */
export const Config: Schema<Config> = Schema.object({
  roots: Schema.object({
    claude: Schema.string(),
    codex: Schema.string(),
    grok: Schema.string(),
    dsh: Schema.string(),
    mimocode: Schema.string(),
    opencode: Schema.string(),
    openclaw: Schema.string(),
    hermes: Schema.string(),
    pi: Schema.string(),
    gemini: Schema.string(),
  }),
  maxMessages: Schema.number().step(1).min(1).default(2000),
  maxMessageTextBytes: Schema.number().step(1).min(256).default(32768),
})

interface ConnectionRoute {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * Register the import routes.
 * @param ctx - Host context carrying connection, persistence, and workspaces.
 * @param config - root overrides and message limits.
 */
export function apply(ctx: Context, config: Config = {}): void {
  for (const root of Object.values(config.roots ?? {})) {
    if (typeof root !== 'string' || !isAbsolute(root)) {
      throw new Error('session-import: every configured source root must be an absolute path')
    }
  }
  const engine = new SessionImportEngine({
    persistence: ctx.sessionPersistence,
    workspaces: ctx.workspaceRegistry,
    currentHome: dshHomeOf(ctx),
    roots: config.roots ?? {},
    maxMessages: config.maxMessages ?? 2000,
    maxMessageTextBytes: config.maxMessageTextBytes ?? 32768,
    projections: { checkpoint: (header, events) => checkpointInto(ctx, header, events) },
  })
  const connection = Reflect.get(ctx, 'connection') as ConnectionRoute
  ctx.effect(() => connection.fetch.register({
    path: SESSION_IMPORT_CANDIDATES_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => jsonResponse(await engine.candidates()),
  }), 'session-import: candidates')
  ctx.effect(() => connection.fetch.register({
    path: SESSION_IMPORT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => importResponse(request, engine),
  }), 'session-import: plan and apply')
}

/** Read the harness home from the boot-provided path helper. */
function dshHomeOf(ctx: Context): string {
  const provider: unknown = Reflect.get(ctx, 'dshHomePath')
  if (typeof provider !== 'function') {
    throw new Error('session-import: the dshHomePath service is required to exclude the current home')
  }
  const value: unknown = Reflect.apply(provider, undefined, [])
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('session-import: dshHomePath returned a non-string path')
  }
  return value
}

/** Bound on waiting for the imported row's fire-and-forget cache write. */
const CHECKPOINT_DRAIN_TIMEOUT_MS = 2_000
/** Poll interval while waiting for that cache write to become readable. */
const CHECKPOINT_DRAIN_POLL_MS = 5

/**
 * Fold one written log into the mounted projection cache, which is what the
 * cold Session list reads a stored Session's title from. A composition without
 * the cache still imports; its rows list without cached projections until the
 * Session is opened.
 * @param ctx - Host context carrying the optional projection cache.
 * @param header - the stored Session header.
 * @param events - the Session's complete log in seq order.
 * @returns resolution once the row is readable, or immediately without the cache.
 */
async function checkpointInto(
  ctx: Context,
  header: SessionHeader,
  events: readonly SessionEvent[],
): Promise<void> {
  // Looked up per write: the cache service may initialize after this plugin.
  const cache = ctx.get('sessionProjectionCache')
  if (cache === undefined) return
  const snapshot = cache.coldSnapshot(header, brandNumber<SessionLogOffset>(0), events)
  // No served value means no registered unit has a client view, so the row
  // could never become readable and waiting would only delay the import.
  if (Object.keys(snapshot.values).length === 0) return
  const deadline = performance.now() + CHECKPOINT_DRAIN_TIMEOUT_MS
  while (cache.cachedSnapshot(header) === undefined) {
    if (performance.now() >= deadline) return
    await scheduler.wait(CHECKPOINT_DRAIN_POLL_MS)
  }
}

async function importResponse(request: Request, engine: SessionImportEngine): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return failure(400, 'invalid-request', 'request body must be JSON')
  }
  const record = recordOf(body)
  if (record === undefined) return failure(400, 'invalid-request', 'request body must be an object')
  const op = record['op']
  const source = stringOf(record['source'])
  if (source === undefined || !isSourceId(source)) {
    return failure(400, 'unknown-source', 'source must name a supported store')
  }
  try {
    if (op === 'plan') {
      return jsonResponse(await engine.plan(planRequestOf(source, record)))
    }
    if (op === 'apply') {
      return jsonResponse(await engine.apply(applyRequestOf(source, record)))
    }
    return failure(400, 'invalid-request', 'op must be "plan" or "apply"')
  } catch (error: unknown) {
    if (error instanceof ImportEngineError) {
      return failure(error.code === 'merge-confirmation-required' ? 409 : 400, error.code, error.message)
    }
    return failure(500, 'import-failed', error instanceof Error ? error.message : String(error))
  }
}

function planRequestOf(source: ImportSourceId, body: Readonly<Record<string, unknown>>): ImportPlanRequest {
  const sessionIds = optionalIds(body['sessionIds'])
  return { source, ...(sessionIds === undefined ? {} : { sessionIds }) }
}

function applyRequestOf(source: ImportSourceId, body: Readonly<Record<string, unknown>>): ImportApplyRequest {
  const sessionIds = optionalIds(body['sessionIds'])
  if (sessionIds === undefined || sessionIds.length === 0) {
    throw new ImportEngineError('invalid-request', 'sessionIds must be a non-empty string array')
  }
  return {
    source,
    sessionIds,
    ...(body['confirmMerge'] === true ? { confirmMerge: true } : {}),
  }
}

function optionalIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  const list = listOf(value)
  if (list === undefined) throw new ImportEngineError('invalid-request', 'sessionIds must be a string array')
  const ids: string[] = []
  for (const item of list) {
    const id = stringOf(item)
    if (id === undefined) throw new ImportEngineError('invalid-request', 'sessionIds must contain only strings')
    ids.push(id)
  }
  return ids
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function failure(status: number, code: ImportFailureBody['code'], message: string): Response {
  return new Response(JSON.stringify({ code, message } satisfies ImportFailureBody), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
