/**
 * Feishu/Lark adapter: the open platform's WebSocket long connection with
 * protobuf frames (pbbp2.Frame), replies through the IM send API. The
 * endpoint request body, frame codec, ping frame, event envelope, and chunk
 * merge are pure and tested.
 *
 * @module @prism/prism-pocket/bots/adapters
 */

import type { BotAdapterFactory, BotInbound } from '../types.ts'
import { chunkText } from '../shared/chunk.ts'
import { postBotJson, stringField } from '../shared/http.ts'
import { decodeLarkFrame, encodeLarkFrame, type LarkFrame } from '../shared/protobuf.ts'
import { ReconnectingWs } from '../shared/ws.ts'

/** Per-message character limit applied on sends. */
export const FEISHU_MESSAGE_LIMIT = 4000

/** The open-platform host of one region. */
export function feishuDomain(region: 'feishu' | 'lark'): string {
  return region === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
}

/** The endpoint request body; the gateway names its fields in PascalCase. */
export function buildLarkEndpointRequest(appId: string, appSecret: string, domain: string): { url: string; body: string; headers: Record<string, string> } {
  return {
    url: `${domain}/callback/ws/endpoint`,
    body: JSON.stringify({ AppID: appId, AppSecret: appSecret }),
    headers: { locale: 'zh' },
  }
}

/** The ping control frame the client sends every PingInterval. */
export function buildLarkPing(serviceId: number): Uint8Array {
  return encodeLarkFrame({
    service: serviceId,
    method: 0,
    headers: [{ key: 'type', value: 'ping' }],
  })
}

/** The merged event envelope once all chunks of one message have arrived. */
export interface LarkEventEnvelope {
  readonly eventType?: string
  readonly chatId?: string
  readonly chatType?: string
  readonly text?: string
}

/**
 * Narrow one merged event JSON; only `im.message.receive_v1` text messages
 * produce a value.
 * @param data - the parsed event payload.
 * @returns the envelope view, or undefined when the event is not a usable text message.
 */
export function readLarkEventEnvelope(data: unknown): LarkEventEnvelope | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { header?: unknown; event?: unknown }
  const header = typeof record.header === 'object' && record.header !== null ? record.header as { event_type?: unknown } : undefined
  const event = typeof record.event === 'object' && record.event !== null ? record.event : undefined
  if (header?.event_type !== 'im.message.receive_v1' || event === undefined) return undefined
  const message = (event as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return undefined
  const fields = message as { chat_id?: unknown; chat_type?: unknown; message_type?: unknown; content?: unknown }
  if (typeof fields.chat_id !== 'string' || fields.message_type !== 'text' || typeof fields.content !== 'string') return undefined
  let text: string | undefined
  try {
    const content: unknown = JSON.parse(fields.content)
    text = typeof content === 'object' && content !== null && typeof (content as { text?: unknown }).text === 'string'
      ? (content as { text: string }).text
      : undefined
  } catch {
    return undefined
  }
  if (text === undefined || text.trim().length === 0) return undefined
  // Group messages arrive with the @mention leading; a message that does not
  // address the bot is left for the group to ignore.
  const stripped = text.replace(/^@\S+\s*/u, '').trim()
  if (stripped.length === 0) return undefined
  const chatType = typeof fields.chat_type === 'string' ? fields.chat_type : undefined
  return {
    chatId: fields.chat_id,
    text: stripped,
    ...(chatType !== undefined ? { chatType } : {}),
    ...(header.event_type !== undefined ? { eventType: header.event_type } : {}),
  }
}

/** One in-flight fragmented message pending its remaining chunks. */
interface LarkChunkCache {
  readonly buffer: Array<Uint8Array | undefined>
  readonly createdAt: number
}

/**
 * The fragment merge: events may arrive split across frames; one message_id
 * accumulates its `sum` chunks and resolves when complete.
 */
export class LarkChunkMerger {
  private readonly cache = new Map<string, LarkChunkCache>()

  /**
   * Add one frame's chunk.
   * @param messageId - the frame's `message_id` header.
   * @param seq - the frame's `seq` header (0-based).
   * @param sum - the frame's `sum` header (total chunk count).
   * @param payload - the frame payload bytes.
   * @returns the merged JSON text when complete, otherwise undefined.
   */
  merge(messageId: string, seq: number, sum: number, payload: Uint8Array): string | undefined {
    if (sum <= 0 || seq < 0 || seq >= sum) return undefined
    const existing = this.cache.get(messageId)
    const entry = existing ?? { buffer: new Array<Uint8Array | undefined>(sum).fill(undefined), createdAt: Date.now() }
    entry.buffer[seq] = payload
    if (entry.buffer.some(piece => piece === undefined)) {
      this.cache.set(messageId, entry)
      this.prune()
      return undefined
    }
    this.cache.delete(messageId)
    const total = entry.buffer.reduce((size, piece) => size + (piece?.byteLength ?? 0), 0)
    const merged = new Uint8Array(total)
    let at = 0
    for (const piece of entry.buffer) {
      if (piece === undefined) continue
      merged.set(piece, at)
      at += piece.byteLength
    }
    return new TextDecoder().decode(merged)
  }

  /** Drop entries older than 10s so aborted merges cannot accumulate. */
  private prune(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > 10_000) this.cache.delete(key)
    }
  }
}

/** The adapter: endpoint pull, managed socket, REST sends. */
export const createFeishuAdapter: BotAdapterFactory = (config, hooks) => {
  const { appId, appSecret, region } = config as { appId: string; appSecret: string; region: 'feishu' | 'lark' }
  const domain = feishuDomain(region)
  const merger = new LarkChunkMerger()
  let ws: ReconnectingWs | undefined
  let pingTimer: ReturnType<typeof setInterval> | undefined
  let serviceId = 0
  let tenantToken: { token: string; expiresAt: number } | undefined

  const clearPing = (): void => {
    if (pingTimer !== undefined) clearInterval(pingTimer)
    pingTimer = undefined
  }

  const token = async (): Promise<string> => {
    if (tenantToken !== undefined && Date.now() < tenantToken.expiresAt) return tenantToken.token
    const body = await postBotJson(`${domain}/auth/v3/tenant_access_token/internal`, { app_id: appId, app_secret: appSecret })
    const value = stringField(body, 'tenant_access_token')
    const expire = (body as { expire?: unknown } | undefined)?.expire
    if (value === undefined) throw new Error('tenant_access_token missing')
    tenantToken = { token: value, expiresAt: Date.now() + (typeof expire === 'number' ? expire - 60 : 1800) * 1000 }
    return value
  }

  const handleData = (frame: LarkFrame): void => {
    const headerOf = (key: string): string | undefined => frame.headers.find(entry => entry.key === key)?.value
    const type = headerOf('type')
    const messageId = headerOf('message_id')
    const sum = Number.parseInt(headerOf('sum') ?? '', 10)
    const seq = Number.parseInt(headerOf('seq') ?? '', 10)
    if (type !== 'event' || messageId === undefined || !Number.isFinite(sum) || !Number.isFinite(seq)) return
    const merged = merger.merge(messageId, seq, sum, frame.payload)
    if (merged === undefined) return
    try {
      const envelope = readLarkEventEnvelope(JSON.parse(merged))
      if (envelope !== undefined) {
        hooks.onInbound({ chatId: envelope.chatId ?? '', text: envelope.text ?? '' } satisfies BotInbound)
      }
    } catch {
      // A merged body that fails to parse stays silent; the platform owns its schema.
    }
  }

  return {
    async start() {
      hooks.onStatus('starting')
      const endpoint = buildLarkEndpointRequest(appId, appSecret, domain)
      const body = await postBotJson(endpoint.url, JSON.parse(endpoint.body), endpoint.headers)
      const code = (body as { code?: unknown }).code
      if (code !== 0) throw new Error(`endpoint request rejected: ${JSON.stringify(body)}`)
      const data = (body as { data?: unknown }).data
      const url = stringField(data, 'URL')
      if (url === undefined) throw new Error('connect URL missing from endpoint response')
      const clientConfig = (data as { ClientConfig?: unknown }).ClientConfig
      const pingInterval = (clientConfig as { PingInterval?: unknown } | undefined)?.PingInterval
      const service = new URL(url).searchParams.get('service_id')
      serviceId = service === null ? 1 : Number.parseInt(service, 10)
      ws = new ReconnectingWs(
        () => new WebSocket(url),
        {
          onOpen: () => {
            hooks.onStatus('online')
            clearPing()
            pingTimer = setInterval(() => {
              ws?.send(Buffer.from(buildLarkPing(serviceId)).toString('base64'))
            }, typeof pingInterval === 'number' && pingInterval > 0 ? pingInterval * 1000 : 120_000)
          },
          onMessage: (data) => {
            const raw = typeof data === 'string' ? new TextEncoder().encode(data) : data
            const frame = decodeLarkFrame(raw)
            if (frame === undefined) return
            if (frame.method === 1) handleData(frame)
          },
          onClosed: () => {
            clearPing()
            hooks.onStatus('starting', 'socket closed; reconnecting')
          },
          onError: (detail) => {
            hooks.onStatus('error', detail)
          },
        },
      )
      ws.start()
      await new Promise<void>((resolve, reject) => {
        const began = Date.now()
        const check = setInterval(() => {
          if (ws?.open === true) {
            clearInterval(check)
            resolve()
          } else if (Date.now() - began > 15_000) {
            clearInterval(check)
            reject(new Error('long connection did not open within 15s'))
          }
        }, 250)
      })
    },
    async stop() {
      clearPing()
      ws?.stop()
      ws = undefined
    },
    async send(chatId, text) {
      const credential = await token()
      for (const piece of chunkText(text, FEISHU_MESSAGE_LIMIT)) {
        await postBotJson(`${domain}/im/v1/messages?receive_id_type=chat_id`, {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: piece }),
        }, { Authorization: `Bearer ${credential}` })
      }
    },
    async probe() {
      await token()
    },
  }
}
