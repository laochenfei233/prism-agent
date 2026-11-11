/**
 * Cordis plugin entry for the HachimoDock <-> Prism bridge.
 *
 * Mounting it as a Host plugin starts a loopback HTTP/SSE endpoint used by
 * the HachimoDock PC bridge, registers the `approval/request` answerer,
 * forwards compact session/turn/tool/title events, and exposes the
 * conversation-switch route the device drives. See README.md for the wire
 * contract.
 *
 * All host integrations are read structurally (the plugin ships without
 * workspace type dependencies), so the Loader resolves this row on any
 * profile that provides the session trio and the web surface.
 *
 * @module @prism/prism-hachimodock
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createBridge, PLUGIN_NAME, type BridgeConfig } from './bridge.ts'
import { capabilities, serviceView } from './host-contract.ts'
import { ActivationHub, ACTIVATION_PATH } from './activation.ts'
import type { LoggerLike } from './types.ts'

export { AGENT_ID, PLUGIN_NAME, createBridge, forwardSessionEvent, handleApprovalRequest, injectToSession, interruptSession, normalizeOptions, resolveTargetSession, summarizeSession } from './bridge.ts'
export { ACTIVATION_PATH, ActivationHub } from './activation.ts'
export { BridgeServer, PROTOCOL_VERSION } from './server.ts'

/** Cordis plugin name, matching the `cordis.patch.yml` row id. */
export const name = PLUGIN_NAME

/**
 * Structural view of the authenticated same-origin route carrier
 * (mirrors `session-import`/`prism-pocket`).
 */
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

/** Bridge deployment policy. */
export interface Config {
  /** Fixed loopback port; the default binds a free port at startup. */
  readonly port?: number
  /** Approval wait before failing closed. @default 30000 */
  readonly approvalTimeoutMs?: number
  /** Answer when no relay is attached: delegate to the resident UI or fail. @default 'delegate' */
  readonly approvalFallback?: 'unavailable' | 'delegate'
  /** Prompt admission deadline before `inject-timeout`. @default 600000 */
  readonly injectTimeoutMs?: number
  /** Exact browser Origins allowed to pair; empty disables browser voice. */
  readonly allowedOrigins?: string[]
  /** Capability descriptor path override (tests). */
  readonly descriptorPath?: string
}

/** Validated bridge config schema; fields without a default pass through as optional. */
export const Config: Schema<Config> = Schema.object({
  port: Schema.number(),
  approvalTimeoutMs: Schema.number().default(30000),
  approvalFallback: Schema.union(['unavailable', 'delegate']).default('delegate'),
  injectTimeoutMs: Schema.number().default(600000),
  allowedOrigins: Schema.array(Schema.string()),
  descriptorPath: Schema.string(),
})

/** The resolved config shape `apply` works with. */
type ResolvedConfig = Required<Pick<Config, 'approvalFallback'>> & Omit<Config, 'approvalFallback'>

/** Host services this plugin needs before mounting. */
export const inject = ['sessions', 'agents', 'sessionController']

/**
 * Create the bridge, register the activation route, and own the server
 * lifecycle through one effect.
 * @param ctx - host context.
 * @param config - resolved patch-row config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = Config(config) as ResolvedConfig
  const hub = new ActivationHub(ctx.logger as unknown as LoggerLike | null)
  const bridge = createBridge(ctx as never, resolved as BridgeConfig, hub)
  bridge.ctx = serviceView(bridge.ctx)
  bridge.server.capabilities = () => capabilities(bridge.ctx)

  // The same-origin activation stream; the webserver authenticates /api.
  const connection = Reflect.get(ctx, 'connection') as ConnectionRoute | undefined
  if (connection !== undefined && typeof connection.fetch?.register === 'function') {
    ctx.effect(() => connection.fetch.register({
      path: ACTIVATION_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => Promise.resolve(hub.subscribe(request)),
    }), 'hachimodock: activation stream')
  }

  ctx.effect(async () => {
    const port = await bridge.start()
    bridge.logger.info(`hachimodock: bridge listening on http://127.0.0.1:${port}`)
    return () => {
      hub.close()
      void bridge.stop()
    }
  }, 'hachimodock: http bridge')
}
