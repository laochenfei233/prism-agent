/**
 * Bot routes: one authenticated list/action endpoint on the `/api` channel,
 * plus the three callback channels' unauthenticated webserver routes whose
 * requests the platforms sign. The action endpoint fails loud: unknown
 * channels, unknown actions, and configs that fail validation answer 400
 * with the offending field named.
 *
 * @module @prism/prism-pocket/bots
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BotChannelId } from './types.ts'
import { BOT_CHANNELS, BOT_CHANNEL_KINDS, botCallbackPath } from './types.ts'
import type { BotStore } from './store.ts'
import type { BotSupervisor } from './supervisor.ts'
import { readBotConfig, summarizeConfig } from './validate.ts'
import { readWechatCallback, verifyWechatCallback, resolveWechatVerifyEcho } from './adapters/wechat.ts'
import { readWecomCallback, resolveWecomVerifyEcho } from './adapters/wecom.ts'
import { readWhatsappMessages, resolveWhatsappVerifyChallenge, verifyWhatsappSignature } from './adapters/whatsapp.ts'
import type { WechatConfig, WecomConfig, WhatsappConfig } from './types.ts'
import { callbackSignature, timestampFresh } from './shared/sign.ts'
import { readXmlField } from './shared/xml.ts'

/** The authenticated list/action route. */
export const POCKET_BOTS_PATH = '/api/pocket/bots'

/** One channel's view as the list route renders it. */
export interface BotChannelView {
  readonly channel: BotChannelId
  readonly kind: 'outbound' | 'callback'
  readonly enabled: boolean
  readonly status: string
  readonly detail?: string
  readonly fields: readonly { readonly name: string; readonly set: boolean }[]
  readonly sessionId?: string
  readonly chatId?: string
  readonly callbackPath?: string
}

/** What the list route answers. */
export interface BotListView {
  readonly bots: readonly BotChannelView[]
}

/** How the routes deliver inbound chat messages (ask relay already consumed). */
export interface BotRouteDeps {
  readonly store: BotStore
  readonly supervisor: BotSupervisor
  readonly deliverInbound: (channel: BotChannelId, message: { readonly chatId: string; readonly text: string }) => Promise<void>
  readonly warn: (detail: string) => void
}

/** Build every channel's view for the list route. */
export function listView(deps: Pick<BotRouteDeps, 'store' | 'supervisor'>): BotListView {
  return {
    bots: BOT_CHANNELS.map(channel => {
      const entry = deps.store.entry(channel)
      const state = deps.supervisor.state(channel)
      const config = entry?.config
      return {
        channel,
        kind: BOT_CHANNEL_KINDS[channel],
        enabled: entry?.enabled === true,
        status: state.status,
        ...(state.detail !== undefined ? { detail: state.detail } : {}),
        fields: config === undefined ? [] : summarizeConfig(config),
        ...(entry?.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
        ...(entry?.chatId !== undefined ? { chatId: entry.chatId } : {}),
        ...(BOT_CHANNEL_KINDS[channel] === 'callback' ? { callbackPath: botCallbackPath(channel) } : {}),
      }
    }),
  }
}

/** The actions the POST route accepts. */
type BotAction = 'config' | 'start' | 'stop' | 'test'

/** The POST body, validated before use. */
interface BotActionRequest {
  readonly channel: BotChannelId
  readonly action: BotAction
  readonly config?: unknown
  readonly enabled?: boolean
}

/** Read one action request; anything else is a 400. */
export function readBotAction(value: unknown): BotActionRequest {
  if (typeof value !== 'object' || value === null) throw new Error('expected a JSON body')
  const record = value as { channel?: unknown; action?: unknown; config?: unknown; enabled?: unknown }
  if (typeof record.channel !== 'string' || !BOT_CHANNELS.includes(record.channel as BotChannelId)) {
    throw new Error(`unknown channel: ${String(record.channel)}`)
  }
  if (record.action !== 'config' && record.action !== 'start' && record.action !== 'stop' && record.action !== 'test') {
    throw new Error(`unknown action: ${String(record.action)}`)
  }
  return {
    channel: record.channel as BotChannelId,
    action: record.action,
    ...(record.action === 'config' ? { config: record.config, enabled: record.enabled === true } : {}),
  }
}

/**
 * Run one validated action; the reply is always JSON.
 * @param request - the validated request.
 * @param deps - the route dependencies.
 * @returns the response body; `error` carries the failure detail when one applies.
 */
export async function runBotAction(request: BotActionRequest, deps: BotRouteDeps): Promise<unknown> {
  const { channel, action } = request
  if (action === 'config') {
    const config = readBotConfig(channel, request.config)
    deps.store.setConfig(config)
    if (request.enabled === true) {
      if (!deps.store.setEnabled(channel, true)) throw new Error('enable requires a stored config')
      await deps.supervisor.start(channel, config)
    }
    return listView(deps)
  }
  if (action === 'start') {
    const config = deps.store.config(channel)
    if (config === undefined) throw new Error(`${channel} has no stored config`)
    if (!deps.store.setEnabled(channel, true)) throw new Error(`${channel} could not be enabled`)
    await deps.supervisor.start(channel, config)
    return listView(deps)
  }
  if (action === 'stop') {
    deps.store.setEnabled(channel, false)
    await deps.supervisor.stop(channel)
    return listView(deps)
  }
  // test: probe the credentials without sending; a stopped channel starts once to probe
  // and stops again, so the switch state is untouched.
  const config = deps.store.config(channel)
  if (config === undefined) throw new Error(`${channel} has no stored config`)
  const running = deps.supervisor.handle(channel)
  if (running !== undefined) {
    await running.probe()
    return listView(deps)
  }
  await deps.supervisor.start(channel, config)
  if (deps.supervisor.handle(channel) === undefined) {
    throw new Error(deps.supervisor.state(channel).detail ?? `${channel} failed to start for the probe`)
  }
  await deps.supervisor.stop(channel)
  return listView(deps)
}

/** Collect one webserver request body as UTF-8 text. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Reply with a plain text body and status. */
function reply(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(body)
}

/**
 * Register the three callback channels' webserver routes. Every route
 * validates its platform's signature before processing; a channel without a
 * stored config answers 404, and a failed verification answers 403.
 * @param ctx - host context; registration rides `ctx.effect`.
 * @param webserver - the webserver service.
 * @param deps - the route dependencies.
 */
export function registerBotCallbackRoutes(
  ctx: Context,
  webserver: { register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void },
  deps: BotRouteDeps,
): void {
  const wechatHandler = callbackHandler('wechat', deps.warn, async (request, url, body) => {
    const config = deps.store.config('wechat')?.fields as WechatConfig | undefined
    if (config === undefined) return { status: 404, body: 'not configured' }
    const signature = url.searchParams.get('signature') ?? ''
    const timestamp = url.searchParams.get('timestamp') ?? ''
    const nonce = url.searchParams.get('nonce') ?? ''
    if (request.method === 'GET') {
      const echo = url.searchParams.get('echostr') ?? ''
      if (!verifyWechatCallback(config.token, signature, timestamp, nonce) || !timestampFresh(timestamp)) {
        return { status: 403, body: 'signature mismatch' }
      }
      // The echo is plaintext in plain mode and a cipher in encrypted mode; return what decrypts.
      const decrypted = resolveWechatVerifyEcho(config, echo)
      return { status: 200, body: decrypted ?? echo }
    }
    const encrypt = readXmlField(body, 'Encrypt') ?? ''
    const encryptedMode = encrypt.length > 0
    const signatureMatches = verifyWechatCallback(config.token, signature, timestamp, nonce)
      || (encryptedMode && callbackSignatureOf(config.token, timestamp, nonce, encrypt) === signature)
    if (!signatureMatches || !timestampFresh(timestamp)) return { status: 403, body: 'signature mismatch' }
    if (!encryptedMode) return { status: 200, body: 'success' }
    const message = readWechatCallback(config, body)
    if (message?.content !== undefined && message.content.trim().length > 0) {
      await deps.deliverInbound('wechat', { chatId: message.from, text: message.content.trim() })
    }
    return { status: 200, body: 'success' }
  })

  const wecomHandler = callbackHandler('wecom', deps.warn, async (request, url, body) => {
    const config = deps.store.config('wecom')?.fields as WecomConfig | undefined
    if (config === undefined) return { status: 404, body: 'not configured' }
    const msgSignature = url.searchParams.get('msg_signature') ?? ''
    const timestamp = url.searchParams.get('timestamp') ?? ''
    const nonce = url.searchParams.get('nonce') ?? ''
    if (request.method === 'GET') {
      const echo = url.searchParams.get('echostr') ?? ''
      const encrypt = echo
      if (callbackSignatureOf(config.token, timestamp, nonce, encrypt) !== msgSignature) return { status: 403, body: 'signature mismatch' }
      const decrypted = resolveWecomVerifyEcho(config, echo)
      if (decrypted === undefined) return { status: 403, body: 'decrypt failed' }
      return { status: 200, body: decrypted }
    }
    const encrypt = readXmlField(body, 'Encrypt') ?? ''
    if (callbackSignatureOf(config.token, timestamp, nonce, encrypt) !== msgSignature || !timestampFresh(timestamp)) {
      return { status: 403, body: 'signature mismatch' }
    }
    const message = readWecomCallback(config, encrypt)
    if (message !== undefined) await deps.deliverInbound('wecom', { chatId: message.from, text: message.content })
    return { status: 200, body: 'success' }
  })

  const whatsappHandler = callbackHandler('whatsapp', deps.warn, async (request, url, body) => {
    const config = deps.store.config('whatsapp')?.fields as WhatsappConfig | undefined
    if (config === undefined) return { status: 404, body: 'not configured' }
    if (request.method === 'GET') {
      const challenge = resolveWhatsappVerifyChallenge(Object.fromEntries(url.searchParams), config.verifyToken)
      if (challenge === undefined) return { status: 403, body: 'verification failed' }
      return { status: 200, body: challenge }
    }
    const signature = request.headers['x-hub-signature-256'] ?? ''
    if (typeof signature !== 'string' || !verifyWhatsappSignature(config.appSecret, body, signature)) {
      return { status: 403, body: 'signature mismatch' }
    }
    try {
      for (const message of readWhatsappMessages(JSON.parse(body))) {
        await deps.deliverInbound('whatsapp', { chatId: message.from, text: message.text })
      }
    } catch (cause: unknown) {
      // A body that fails to parse is answered 200 so Meta stops retrying; the detail is logged.
      deps.warn(`whatsapp callback body did not parse: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    return { status: 200, body: 'OK' }
  })

  ctx.effect(() => webserver.register({ kind: 'exact', path: botCallbackPath('wechat'), handler: wechatHandler }), 'pocket: wechat callback')
  ctx.effect(() => webserver.register({ kind: 'exact', path: botCallbackPath('wecom'), handler: wecomHandler }), 'pocket: wecom callback')
  ctx.effect(() => webserver.register({ kind: 'exact', path: botCallbackPath('whatsapp'), handler: whatsappHandler }), 'pocket: whatsapp callback')
}

/** The WeChat-family 4-part signature used by encrypted POSTs and WeCom. */
function callbackSignatureOf(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return callbackSignature(token, timestamp, nonce, encrypt)
}

/** One callback handler skeleton: body collection plus a per-platform async. */
function callbackHandler(
  channel: BotChannelId,
  warn: (detail: string) => void,
  handle: (request: IncomingMessage, url: URL, body: string) => Promise<{ status: number; body: string }>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (request, res) => {
    try {
      const host = request.headers.host ?? 'localhost'
      const url = new URL(request.url ?? `/${channel}`, `http://${host}`)
      const body = request.method === 'POST' ? await readBody(request) : ''
      const outcome = await handle(request, url, body)
      reply(res, outcome.status, outcome.body)
    } catch (cause: unknown) {
      warn(`${channel} callback failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      reply(res, 500, 'internal error')
    }
  }
}
