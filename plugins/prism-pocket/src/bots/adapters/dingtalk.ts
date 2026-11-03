/**
 * DingTalk adapter: Stream Mode over a reconnecting WebSocket — every frame
 * is JSON and every message must be acknowledged with its `messageId`.
 * Ticket acquisition, frame routing, the ack body, and the message extract
 * are pure and tested; replies ride the message's `sessionWebhook`.
 *
 * @module @prism/prism-pocket/bots/adapters
 */

import type { BotAdapterFactory, BotInbound } from '../types.ts'
import { chunkText } from '../shared/chunk.ts'
import { postBotJson } from '../shared/http.ts'
import { ReconnectingWs } from '../shared/ws.ts'

/** Per-message character limit applied on sends. */
export const DINGTALK_MESSAGE_LIMIT = 2000

/** The connection-open API. */
export const DINGTALK_OPEN_API = 'https://api.dingtalk.com/v1.0/gateway/connections/open'

/** The topic the robot's inbound messages arrive on. */
export const DINGTALK_ROBOT_TOPIC = '/v1.0/im/bot/messages/get'

/** The body the connections/open API expects. */
export function buildDingtalkOpenRequest(clientId: string, clientSecret: string): unknown {
  return {
    clientId,
    clientSecret,
    subscriptions: [{ type: 'CALLBACK', topic: DINGTALK_ROBOT_TOPIC }],
  }
}

/** One stream frame, narrowed to the fields the adapter reads. */
export interface DingtalkFrame {
  readonly type?: string
  readonly headers: Readonly<Record<string, unknown>>
  readonly data?: string
  readonly code?: unknown
  readonly message?: unknown
}

/** Parse one stream text frame; non-JSON input reads as undefined. */
export function parseDingtalkFrame(text: string): DingtalkFrame | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as { type?: unknown; headers?: unknown; data?: unknown; code?: unknown; message?: unknown }
    return {
      ...(typeof record.type === 'string' ? { type: record.type } : {}),
      headers: typeof record.headers === 'object' && record.headers !== null ? record.headers as Record<string, unknown> : {},
      ...(typeof record.data === 'string' ? { data: record.data } : {}),
      ...(record.code !== undefined ? { code: record.code } : {}),
      ...(record.message !== undefined ? { message: record.message } : {}),
    }
  } catch {
    return undefined
  }
}

/** The ack body every received message must answer with. */
export function buildDingtalkAck(frame: DingtalkFrame): string {
  return JSON.stringify({
    code: 200,
    headers: { contentType: 'application/json', messageId: frame.headers.messageId },
    message: 'OK',
    data: '{}',
  })
}

/** One robot message, narrowed to the fields the adapter reads. */
export interface DingtalkMessage {
  readonly chatId: string
  readonly senderName?: string
  readonly text: string
  readonly webhook: string
}

/**
 * Narrow one robot message body; messages without a webhook or text read as
 * undefined.
 * @param data - the frame's parsed `data` JSON.
 * @returns the message view, or undefined when not usable.
 */
export function readDingtalkMessage(data: unknown): DingtalkMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { sessionWebhook?: unknown; text?: unknown; senderNick?: unknown; senderStaffId?: unknown; conversationId?: unknown }
  if (typeof record.sessionWebhook !== 'string') return undefined
  const content = typeof record.text === 'object' && record.text !== null ? (record.text as { content?: unknown }).content : undefined
  if (typeof content !== 'string' || content.trim().length === 0) return undefined
  const chatId = typeof record.conversationId === 'string' ? record.conversationId : record.sessionWebhook
  const senderName = typeof record.senderNick === 'string' ? record.senderNick : undefined
  return {
    chatId,
    text: content.trim(),
    webhook: record.sessionWebhook,
    ...(senderName !== undefined ? { senderName } : {}),
  }
}

/** The adapter: one managed stream socket plus webhook sends. */
export const createDingtalkAdapter: BotAdapterFactory = (config, hooks) => {
  const { clientId, clientSecret } = config as { clientId: string; clientSecret: string }
  let ws: ReconnectingWs | undefined
  // chatId → the webhook replies go to; refreshed on every inbound message.
  const webhooks = new Map<string, string>()

  const sendViaWebhook = async (webhook: string, text: string): Promise<void> => {
    for (const piece of chunkText(text, DINGTALK_MESSAGE_LIMIT)) {
      await postBotJson(webhook, { msgtype: 'text', text: { content: piece } })
    }
  }

  return {
    async start() {
      hooks.onStatus('starting')
      ws = new ReconnectingWs(
        async () => {
          // Stream tickets are single-use, so every dial opens a fresh connection.
          const opened = await postBotJson(DINGTALK_OPEN_API, buildDingtalkOpenRequest(clientId, clientSecret))
          const endpoint = opened as { endpoint?: unknown; ticket?: unknown }
          if (typeof endpoint.endpoint !== 'string' || typeof endpoint.ticket !== 'string') {
            throw new Error('connections/open did not return endpoint and ticket')
          }
          return new WebSocket(`${endpoint.endpoint}?ticket=${encodeURIComponent(endpoint.ticket)}`)
        },
        {
          onOpen: () => {
            hooks.onStatus('online')
          },
          onMessage: (data) => {
            if (typeof data !== 'string' || ws === undefined) return
            const frame = parseDingtalkFrame(data)
            if (frame === undefined) return
            ws.send(buildDingtalkAck(frame))
            if (frame.type === 'CALLBACK' && frame.headers.topic === DINGTALK_ROBOT_TOPIC) {
              try {
                const message = readDingtalkMessage(JSON.parse(frame.data ?? '{}'))
                if (message !== undefined) {
                  webhooks.set(message.chatId, message.webhook)
                  const { webhook: _webhook, ...inbound } = message
                  hooks.onInbound(inbound satisfies BotInbound)
                }
              } catch {
                // A body that fails to parse stays silent; the platform owns its schema.
              }
            }
          },
          onClosed: () => {
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
            reject(new Error('stream socket did not open within 15s'))
          }
        }, 250)
      })
    },
    async stop() {
      ws?.stop()
      ws = undefined
    },
    async send(chatId, text) {
      const webhook = webhooks.get(chatId)
      if (webhook === undefined) throw new Error(`no session webhook for chat ${chatId}; reply after the next inbound message`)
      await sendViaWebhook(webhook, text)
    },
    async probe() {
      const opened = await postBotJson(DINGTALK_OPEN_API, buildDingtalkOpenRequest(clientId, clientSecret))
      const endpoint = opened as { endpoint?: unknown; ticket?: unknown }
      if (typeof endpoint.endpoint !== 'string' || typeof endpoint.ticket !== 'string') {
        throw new Error('connections/open rejected the credentials')
      }
    },
  }
}
