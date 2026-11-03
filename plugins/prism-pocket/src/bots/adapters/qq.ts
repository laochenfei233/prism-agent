/**
 * QQ open-platform adapter: the WebSocket gateway over a reconnecting
 * socket, replies through the v2 message routes with passive `msg_id`
 * correlation. Token minting, the identify payload, dispatch parsing, and
 * the send bodies are pure and tested.
 *
 * @module @prism/prism-pocket/bots/adapters
 */

import type { BotAdapterFactory, BotInbound } from '../types.ts'
import { chunkText } from '../shared/chunk.ts'
import { fetchBotJson, postBotJson, stringField } from '../shared/http.ts'
import { ReconnectingWs } from '../shared/ws.ts'

/** Per-message character limit applied on sends. */
export const QQ_MESSAGE_LIMIT = 1000

/** Gateway intents: group and C2C message events. */
export const QQ_INTENTS_GROUP_AND_C2C = 1 << 25

/** The access-token API. */
export const QQ_TOKEN_API = 'https://bots.qq.com/app/getAppAccessToken'

/** The REST API base. */
export const QQ_API_BASE = 'https://api.sgroup.qq.com'

/** One gateway frame, narrowed to the fields the adapter reads. */
export interface QqFrame {
  readonly op: number
  readonly t?: string
  readonly s?: number
  readonly data?: unknown
}

/** Parse one gateway text frame; non-JSON input reads as undefined. */
export function parseQqFrame(text: string): QqFrame | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as { op?: unknown; t?: unknown; s?: unknown; d?: unknown }
    if (typeof record.op !== 'number') return undefined
    return {
      op: record.op,
      ...(typeof record.t === 'string' ? { t: record.t } : {}),
      ...(typeof record.s === 'number' ? { s: record.s } : {}),
      ...(record.d !== undefined ? { data: record.d } : {}),
    }
  } catch {
    return undefined
  }
}

/** The op 2 identify payload; the token carries the `QQBot ` prefix. */
export function buildQqIdentify(accessToken: string): string {
  return JSON.stringify({
    op: 2,
    d: { token: `QQBot ${accessToken}`, intents: QQ_INTENTS_GROUP_AND_C2C, shard: [0, 1] },
  })
}

/** One inbound C2C or group message, narrowed to the fields the adapter reads. */
export interface QqMessage {
  readonly chatId: string
  readonly text: string
  readonly msgId: string
  readonly group: boolean
}

/**
 * Narrow one C2C_MESSAGE_CREATE or GROUP_AT_MESSAGE_CREATE dispatch; group
 * messages must address the bot, which the platform guarantees by only
 * dispatching @-mentions.
 * @param type - the dispatch event type.
 * @param data - the dispatch `d`.
 * @returns the message view, or undefined when not usable.
 */
export function readQqMessage(type: string, data: unknown): QqMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { content?: unknown; id?: unknown; author?: unknown }
  const group = type === 'GROUP_AT_MESSAGE_CREATE'
  if (!group && type !== 'C2C_MESSAGE_CREATE') return undefined
  if (typeof record.content !== 'string' || record.content.trim().length === 0) return undefined
  const author = typeof record.author === 'object' && record.author !== null ? record.author as Record<string, unknown> : undefined
  const openid = group ? author?.member_openid : author?.user_openid
  if (typeof openid !== 'string') return undefined
  const msgId = typeof record.id === 'string' ? record.id : ''
  return { chatId: openid, text: record.content.trim(), msgId, group }
}

/** The REST body for one passive reply to an inbound message. */
export function buildQqSendBody(text: string, msgId: string, msgSeq: number): unknown {
  return { msg_type: 0, content: text, msg_id: msgId, msg_seq: msgSeq }
}

/** The send route of one chat. */
export function qqSendUrl(chatId: string, group: boolean): string {
  return group
    ? `${QQ_API_BASE}/v2/groups/${encodeURIComponent(chatId)}/messages`
    : `${QQ_API_BASE}/v2/users/${encodeURIComponent(chatId)}/messages`
}

/** The adapter: token minting, managed gateway socket, REST sends. */
export const createQqAdapter: BotAdapterFactory = (config, hooks) => {
  const { appId, clientSecret } = config as { appId: string; clientSecret: string }
  let ws: ReconnectingWs | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let lastSequence: number | null = null
  let accessToken: string | undefined
  let tokenExpiresAt = 0
  // chatId → the last inbound msg_id, how many replies used it, and the chat kind.
  const passive = new Map<string, { msgId: string; seq: number; group: boolean }>()

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }

  const token = async (): Promise<string> => {
    if (accessToken !== undefined && Date.now() < tokenExpiresAt) return accessToken
    const body = await postBotJson(QQ_TOKEN_API, { appId, clientSecret })
    const value = stringField(body, 'access_token')
    if (value === undefined) throw new Error('access_token missing from token API')
    const expires = Number.parseInt(stringField(body, 'expires_in') ?? '', 10)
    accessToken = value
    tokenExpiresAt = Date.now() + (Number.isFinite(expires) ? expires - 60 : 600) * 1000
    return value
  }

  const handle = (socket: ReconnectingWs, frame: QqFrame): void => {
    if (frame.s !== undefined) lastSequence = frame.s
    if (frame.op === 10) {
      const interval = (frame.data as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval
      if (accessToken !== undefined) socket.send(buildQqIdentify(accessToken))
      if (typeof interval === 'number' && interval > 0) {
        clearHeartbeat()
        heartbeatTimer = setInterval(() => {
          socket.send(JSON.stringify({ op: 1, d: lastSequence }))
        }, interval)
      }
      return
    }
    if (frame.op === 0 && (frame.t === 'C2C_MESSAGE_CREATE' || frame.t === 'GROUP_AT_MESSAGE_CREATE')) {
      const message = readQqMessage(frame.t ?? '', frame.data)
      if (message !== undefined) {
        if (message.msgId.length > 0) passive.set(message.chatId, { msgId: message.msgId, seq: 0, group: message.group })
        hooks.onInbound({ chatId: message.chatId, text: message.text } satisfies BotInbound)
      }
    }
  }

  return {
    async start() {
      hooks.onStatus('starting')
      accessToken = await token()
      /** Gateway URLs are issued per session, so every dial re-fetches one. */
      const mintUrl = async (): Promise<WebSocket> => {
        const accessTokenNow = accessToken ?? await token()
        const gateway = stringField(await fetchBotJson(`${QQ_API_BASE}/gateway`, {
          headers: { Authorization: `QQBot ${accessTokenNow}` },
        }), 'url')
        if (gateway === undefined) throw new Error('gateway URL missing from /gateway')
        return new WebSocket(gateway)
      }
      ws = new ReconnectingWs(
        () => mintUrl(),
        {
          onOpen: () => {
            hooks.onStatus('online')
          },
          onMessage: (data) => {
            if (typeof data !== 'string' || ws === undefined) return
            const frame = parseQqFrame(data)
            if (frame !== undefined) handle(ws, frame)
          },
          onClosed: () => {
            clearHeartbeat()
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
          if (lastSequence !== null) {
            clearInterval(check)
            resolve()
          } else if (Date.now() - began > 15_000) {
            clearInterval(check)
            reject(new Error('gateway READY did not arrive within 15s'))
          }
        }, 250)
      })
    },
    async stop() {
      clearHeartbeat()
      ws?.stop()
      ws = undefined
    },
    async send(chatId, text) {
      const credential = await token()
      const pending = passive.get(chatId)
      // Passive replies must cite an inbound msg_id; without one the send is refused.
      const msgId = pending?.msgId ?? ''
      const seq = (pending?.seq ?? 0) + 1
      if (pending !== undefined) passive.set(chatId, { msgId, seq, group: pending.group })
      for (const piece of chunkText(text, QQ_MESSAGE_LIMIT)) {
        await postBotJson(qqSendUrl(chatId, pending?.group === true), buildQqSendBody(piece, msgId, seq), {
          Authorization: `QQBot ${credential}`,
        })
      }
    },
    async probe() {
      await token()
    },
  }
}
