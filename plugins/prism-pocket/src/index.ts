/**
 * Host half of Prism Pocket: remote-access status, push/Bark delivery, PWA
 * assets, and the notification triggers. The browser half owns every visual
 * surface; this half contributes services and the authenticated JSON routes.
 *
 * All host integrations are read structurally (the plugin ships without
 * workspace type dependencies, mirroring `session-import`), so the Loader
 * resolves this row on any profile that provides the web surface.
 *
 * @module @prism/prism-pocket
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { POCKET_PUSH_SUBSCRIBE_PATH, POCKET_PUSH_TEST_PATH, POCKET_REMOTE_PATH } from './routes.ts'
import { encryptPushPayload } from './push/encrypt.ts'
import { loadOrCreateVapidKeys, type VapidMaterial } from './push/keys.ts'
import { deliverBark, deliverWebPush } from './push/sender.ts'
import { installPocketTriggers, type PocketDeliverer } from './push/triggers.ts'
import { SubscriptionStore } from './push/store.ts'
import { detectTailscale } from './tailscale.ts'
import type { PocketPushPayload, PocketPushSubscriptionRecord, PocketRemoteStatus, PocketServerSurface } from './types.ts'
import { registerPwaAssets, type WebServerLike } from './pwa.ts'

export { POCKET_ICON_PATH, POCKET_MANIFEST_PATH, POCKET_PUSH_SUBSCRIBE_PATH, POCKET_PUSH_TEST_PATH, POCKET_REMOTE_PATH, POCKET_SW_PATH } from './routes.ts'
export { isOriginTrusted, remoteCommands } from './remote-status.ts'
export { detectTailscale, parseTailscaleStatus } from './tailscale.ts'
export { encryptPushPayload } from './push/encrypt.ts'
export { generateVapidKeys, loadOrCreateVapidKeys, vapidAuthorization } from './push/keys.ts'
export { deliverBark, deliverWebPush } from './push/sender.ts'
export { installPocketTriggers } from './push/triggers.ts'
export { SubscriptionStore } from './push/store.ts'
export type * from './types.ts'

/** Cordis plugin name, matching the `cordis.patch.yml` row id. */
export const name = 'pocket'

/** Host services this plugin needs (`webServer` is the carrier's service name). */
export const inject = ['connection', 'webServer', 'webStartup', 'dshHomePath']

/** Pocket delivery policy. */
export interface Config {
  /** Deliver push notifications at all. @default true */
  readonly pushEnabled?: boolean
  /** Notify on cleanly completed turns, not just blocking asks and failures. @default true */
  readonly notifyTurnComplete?: boolean
  /** Bark push endpoint (device key included); POSTed on every notification. */
  readonly barkUrl?: string
}

/** Validate and default the delivery policy. */
export const Config: Schema<Config> = Schema.object({
  pushEnabled: Schema.boolean().default(true),
  notifyTurnComplete: Schema.boolean().default(true),
  barkUrl: Schema.string(),
})

/** Structural view of the connection route carrier (mirrors `session-import`). */
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

/** Structural view of the startup-provided web surface values. */
interface WebStartupLike {
  readonly host?: string
  readonly port?: number
  readonly publicUrl?: string
  readonly trustedHosts?: readonly string[]
}

/** Everything `apply` resolved once, shared by the routes and the deliverer. */
interface PocketRuntime {
  surface: PocketServerSurface
  material: Promise<VapidMaterial>
  store: SubscriptionStore
  config: Required<Pick<Config, 'pushEnabled' | 'notifyTurnComplete'>> & Pick<Config, 'barkUrl'>
}

/**
 * Register the pocket host surface.
 * @param ctx - host context carrying the web-surface services.
 * @param config - delivery policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = Config(config) as Required<Pick<Config, 'pushEnabled' | 'notifyTurnComplete'>> & Pick<Config, 'barkUrl'>
  const connection = Reflect.get(ctx, 'connection') as ConnectionRoute
  const webserver = Reflect.get(ctx, 'webServer') as WebServerLike
  const webStartup = Reflect.get(ctx, 'webStartup') as WebStartupLike
  const runtime: PocketRuntime = {
    surface: {
      host: webStartup.host ?? '127.0.0.1',
      port: webStartup.port ?? 3080,
      ...(webStartup.publicUrl !== undefined ? { publicUrl: webStartup.publicUrl } : {}),
      trustedHosts: [...(webStartup.trustedHosts ?? [])],
    },
    material: loadOrCreateVapidKeys(join(homeOf(ctx), 'pocket', 'keys.json')),
    store: new SubscriptionStore(join(homeOf(ctx), 'pocket', 'subscriptions.json')),
    config: resolved,
  }

  ctx.effect(() => connection.fetch.register({
    path: POCKET_REMOTE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => jsonResponse(await statusOf(runtime)),
  }), 'pocket: remote status')

  ctx.effect(() => connection.fetch.register({
    path: POCKET_PUSH_SUBSCRIBE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => subscribeResponse(request, runtime),
  }), 'pocket: push subscribe')

  ctx.effect(() => connection.fetch.register({
    path: POCKET_PUSH_TEST_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => jsonResponse(await testDelivery(runtime), 200),
  }), 'pocket: push test')

  registerPwaAssets(ctx, webserver)
  installPocketTriggers(ctx, deliverer(ctx, runtime), {
    notifyTurnComplete: resolved.notifyTurnComplete,
  })
}

/**
 * Build the fire-and-forget deliverer: push to every subscription, Bark when
 * configured, and never surface a delivery failure into the agent loop.
 * @param ctx - host context for logging.
 * @param runtime - the resolved runtime state.
 */
function deliverer(ctx: Context, runtime: PocketRuntime): PocketDeliverer {
  return (payload, urgency) => {
    void (async () => {
      if (!runtime.config.pushEnabled) return
      if (runtime.store.size === 0 && runtime.config.barkUrl === undefined) return
      const material = await runtime.material
      const body = Buffer.from(JSON.stringify(payload), 'utf8')
      let delivered = 0
      let pruned = 0
      for (const record of runtime.store.all()) {
        const result = await deliverToSubscription(record, body, urgency, material)
        if (result.prune) {
          runtime.store.remove(record.endpoint)
          pruned += 1
        } else if (result.ok) {
          delivered += 1
        }
      }
      if (runtime.config.barkUrl !== undefined) {
        const bark = await deliverBark(runtime.config.barkUrl, payload)
        if (bark.ok) delivered += 1
      }
      ctx.logger.info(`pocket: delivered ${delivered} notification(s)${pruned > 0 ? `, pruned ${pruned} stale subscription(s)` : ''}`)
    })().catch((error: unknown) => {
      ctx.logger.warn(`pocket: notification delivery failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}

/** Encrypt and send to one subscription; bad key material fails soft per subscriber. */
async function deliverToSubscription(
  record: PocketPushSubscriptionRecord,
  body: Buffer,
  urgency: 'high' | 'normal',
  material: VapidMaterial,
): Promise<{ ok: boolean; prune: boolean }> {
  try {
    const encrypted = encryptPushPayload(record.keys.p256dh, record.keys.auth, body)
    return await deliverWebPush(record.endpoint, encrypted, urgency, material)
  } catch {
    return { ok: false, prune: false }
  }
}

/** Assemble the remote-status body: surface facts, tailscale probe, pocket state. */
async function statusOf(runtime: PocketRuntime): Promise<PocketRemoteStatus> {
  return {
    server: runtime.surface,
    tailscale: await detectTailscale(),
    pocket: {
      pushEnabled: runtime.config.pushEnabled,
      notifyTurnComplete: runtime.config.notifyTurnComplete,
      barkConfigured: runtime.config.barkUrl !== undefined,
      vapidPublicKey: (await runtime.material).keys.publicKey,
      subscriptions: runtime.store.size,
    },
  }
}

/** Validate and persist one subscription; the reply carries the VAPID public key. */
async function subscribeResponse(request: Request, runtime: PocketRuntime): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400)
  }
  const record = readSubscription(body)
  if (record === undefined) {
    return jsonResponse({ error: 'expected { endpoint, keys: { p256dh, auth } } with https endpoint and base64url keys' }, 400)
  }
  runtime.store.add(record)
  return jsonResponse({ vapidPublicKey: (await runtime.material).keys.publicKey })
}

/** Deliver one test notification through every configured channel. */
async function testDelivery(runtime: PocketRuntime): Promise<{ delivered: number; subscriptions: number; barkConfigured: boolean }> {
  const payload: PocketPushPayload = { kind: 'turn-end', detail: 'This is a test notification from Prism Pocket' }
  const material = await runtime.material
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  let delivered = 0
  for (const record of runtime.store.all()) {
    const result = await deliverToSubscription(record, body, 'normal', material)
    if (result.prune) runtime.store.remove(record.endpoint)
    else if (result.ok) delivered += 1
  }
  if (runtime.config.barkUrl !== undefined && await deliverBark(runtime.config.barkUrl, payload).then(result => result.ok)) {
    delivered += 1
  }
  return { delivered, subscriptions: runtime.store.size, barkConfigured: runtime.config.barkUrl !== undefined }
}

/** Validate one subscription payload from the wire. */
function readSubscription(value: unknown): PocketPushSubscriptionRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  if (typeof candidate.endpoint !== 'string' || !candidate.endpoint.startsWith('https://')) return undefined
  const keys = candidate.keys
  if (typeof keys !== 'object' || keys === null) return undefined
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return undefined
  if (!isBase64url(keys.p256dh) || !isBase64url(keys.auth)) return undefined
  // RFC 8291 client keys: a 65-byte uncompressed P-256 point and a >=16-byte auth secret.
  const p256dh = Buffer.from(keys.p256dh, 'base64url')
  if (p256dh.byteLength !== 65 || p256dh[0] !== 0x04) return undefined
  if (Buffer.from(keys.auth, 'base64url').byteLength < 16) return undefined
  return { endpoint: candidate.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, addedAt: new Date().toISOString() }
}

/** Strict base64url check for subscription key material. */
function isBase64url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, 'base64url').byteLength > 0
}

/** JSON response helper. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
}

/** Read the harness home from the boot-provided path helper. */
function homeOf(ctx: Context): string {
  const provider: unknown = Reflect.get(ctx, 'dshHomePath')
  if (typeof provider !== 'function') {
    throw new Error('pocket: the dshHomePath service is required to locate pocket storage')
  }
  const value: unknown = Reflect.apply(provider, undefined, [])
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('pocket: dshHomePath returned a non-string path')
  }
  return value
}
