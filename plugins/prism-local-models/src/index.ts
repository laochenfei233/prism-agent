/**
 * Host half of Prism Local Models: the catalog/download/inference service and
 * its authenticated JSON routes. The browser half renders the Models-page
 * footer card; this half contributes services and routes only.
 *
 * All host integrations are read structurally (the plugin ships without
 * workspace type dependencies, mirroring `prism-pocket`), so the Loader
 * resolves this row on any profile that provides the web surface.
 *
 * @module @prism/prism-local-models
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, type Config as ConfigShape, type ResolvedConfig } from './config.ts'
import { LocalModelsError, type LocalModelsErrorCode } from './errors.ts'
import { LOCAL_MODELS_CATALOG_PATH, LOCAL_MODELS_CANCEL_PATH, LOCAL_MODELS_INSTALL_PATH, LOCAL_MODELS_PROBE_PATH, LOCAL_MODELS_REMOVE_PATH, LOCAL_MODELS_STATUS_PATH } from './routes.ts'
import { PrismLocalModelsService } from './service.ts'
import type { InstallRequest, TargetRequest } from './types.ts'

export { Config } from './config.ts'
export { LocalModelsError, type LocalModelsErrorCode } from './errors.ts'
export { LOCAL_MODELS_CATALOG_PATH, LOCAL_MODELS_CANCEL_PATH, LOCAL_MODELS_INSTALL_PATH, LOCAL_MODELS_PROBE_PATH, LOCAL_MODELS_REMOVE_PATH, LOCAL_MODELS_STATUS_PATH } from './routes.ts'
export { PrismLocalModelsService } from './service.ts'
export type * from './types.ts'

/** Cordis plugin name, matching the `cordis.patch.yml` row id. */
export const name = 'local-models'

/** Host services this plugin needs (`webStartup` gates web-app profiles). */
export const inject = ['connection', 'webStartup', 'dshHomePath']

/** Structural view of the connection route carrier (mirrors `prism-pocket`). */
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
 * Register the local-models host surface: the service claim plus six routes.
 * @param ctx - host context carrying the web-surface services.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: ConfigShape = {}): void {
  const resolved = Config(config) as ResolvedConfig
  const service = new PrismLocalModelsService(resolved, homeOf(ctx))

  ctx.effect(() => {
    ctx.provide('prismLocalModels', service)
    return () => service.dispose()
  }, 'local-models: service claim')

  const connection = Reflect.get(ctx, 'connection') as ConnectionRoute
  ctx.effect(() => connection.fetch.register({
    path: LOCAL_MODELS_CATALOG_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => jsonResponse(await service.catalog()),
  }), 'local-models: catalog')

  ctx.effect(() => connection.fetch.register({
    path: LOCAL_MODELS_STATUS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => jsonResponse(await service.status()),
  }), 'local-models: status')

  ctx.effect(() => connection.fetch.register({
    path: LOCAL_MODELS_INSTALL_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => routeResponse(async () => {
      const body = await readJson<InstallRequest>(request)
      await service.install(body.modelId, body.variantId)
      return jsonResponse({ ok: true })
    }),
  }), 'local-models: install')

  ctx.effect(() => connection.fetch.register({
    path: LOCAL_MODELS_CANCEL_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => routeResponse(async () => {
      const body = await readJson<TargetRequest>(request)
      await service.cancel(body.modelId)
      return jsonResponse({ ok: true })
    }),
  }), 'local-models: cancel')

  ctx.effect(() => connection.fetch.register({
    path: LOCAL_MODELS_REMOVE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => routeResponse(async () => {
      const body = await readJson<TargetRequest>(request)
      await service.remove(body.modelId)
      return jsonResponse({ ok: true })
    }),
  }), 'local-models: remove')

  ctx.effect(() => connection.fetch.register({
    path: LOCAL_MODELS_PROBE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => routeResponse(async () => {
      const body = await readJson<TargetRequest>(request)
      return jsonResponse(await service.probe(body.modelId))
    }),
  }), 'local-models: probe')
}

/** Read a JSON request body with the required fields the routes need. */
async function readJson<T extends InstallRequest | TargetRequest>(request: Request): Promise<T> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    throw new LocalModelsError('invalid-request', 'the request body is not valid JSON')
  }
  if (typeof value !== 'object' || value === null) {
    throw new LocalModelsError('invalid-request', 'the request body must be a JSON object')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate['modelId'] !== 'string') {
    throw new LocalModelsError('invalid-request', 'modelId is required')
  }
  if ('variantId' in candidate && typeof candidate['variantId'] !== 'string') {
    throw new LocalModelsError('invalid-request', 'variantId must be a string when present')
  }
  return value as T
}

/** JSON response helper. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
}

/** Run one route body, mapping typed failures to error responses the card renders. */
async function routeResponse(body: () => Promise<Response>): Promise<Response> {
  try {
    return await body()
  } catch (error) {
    if (error instanceof LocalModelsError) {
      return jsonResponse({ code: error.code, message: error.message }, errorStatus(error.code))
    }
    throw error
  }
}

/** HTTP status for one failure code. */
function errorStatus(code: LocalModelsErrorCode): number {
  if (code === 'busy') return 409
  if (code === 'unknown-model' || code === 'unknown-variant' || code === 'not-installed' || code === 'invalid-request') return 400
  return 500
}

/** Read the harness home from the boot-provided path helper. */
function homeOf(ctx: Context): string {
  const provider: unknown = Reflect.get(ctx, 'dshHomePath')
  if (typeof provider !== 'function') {
    throw new Error('local-models: the dshHomePath service is required to locate the models root')
  }
  const value: unknown = Reflect.apply(provider, undefined, [])
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('local-models: dshHomePath returned a non-string path')
  }
  return value
}
