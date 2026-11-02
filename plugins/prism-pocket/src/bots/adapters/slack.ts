/**
 * Slack adapter: Socket Mode over a reconnecting WebSocket (envelopes are
 * acknowledged in place), replies through `chat.postMessage`. Envelope
 * parsing, the ack body, and the message filter are pure and tested.
 *
 * @module @prism/prism-pocket/bots/adapters
 */

import type { BotAdapterFactory, BotInbound } from '../types.ts'
import { chunkText } from '../shared/chunk.ts'
import { fetchBotJson, postBotJson, stringField } from '../shared/http.ts'
import { ReconnectingWs } from '../shared/ws.ts'

/** Per-message character limit applied on sends. */
export const SLACK_MESSAGE_LIMIT = 4000

/** Base URL of the Slack Web API. */
export const SLACK_API_BASE = 'https://slack.com/api'

/** One Socket Mode envelope, narrowed to the fields the adapter reads. */
export interface SlackEnvelope {
  readonly type?: string
  readonly envelopeId?: string
  readonly payload: unknown
}

/** Parse one Socket Mode text frame; non-JSON input reads as undefined. */
export function parseSlackEnvelope(text: string): SlackEnvelope | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as { type?: unknown; envelope_id?: unknown; payload?: unknown }
    return {
      ...(typeof record.type === 'string' ? { type: record.type } : {}),
      ...(typeof record.envelope_id === 'string' ? { envelopeId: record.envelope_id } : {}),
      payload: record.payload,
    }
  } catch {
    return undefined
  }
}

/** The ack body one envelope must receive. */
export function buildSlackAck(envelopeId: string): string {
  return JSON.stringify({ envelope_id: envelopeId })
}

/** One message event, narrowed to the fields the adapter reads. */
export interface SlackMessage {
  readonly chatId: string
  readonly senderName?: string
  readonly text: string
}

/**
 * Narrow one `events_api` message event; bot-authored and edit events read
 * as undefined.
 * @param payload - the envelope payload.
 * @returns the message view, or undefined when not usable.
 */
export function readSlackMessage(payload: unknown): SlackMessage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const event = (payload as { event?: unknown }).event
  if (typeof event !== 'object' || event === null) return undefined
  const record = event as { type?: unknown; channel?: unknown; user?: unknown; text?: unknown; bot_id?: unknown; subtype?: unknown }
  if (record.type !== 'message' || typeof record.channel !== 'string' || typeof record.text !== 'string') return undefined
  if (record.bot_id !== undefined || record.subtype !== undefined) return undefined
  if (record.text.trim().length === 0) return undefined
  const senderName = typeof record.user === 'string' ? record.user : undefined
  return {
    chatId: record.channel,
    text: record.text.trim(),
    ...(senderName !== undefined ? { senderName } : {}),
  }
}

/** The adapter: one managed Socket Mode socket plus Web API sends. */
export const createSlackAdapter: BotAdapterFactory = (config, hooks) => {
  const { botToken, appToken } = config as { botToken: string; appToken: string }
  let ws: ReconnectingWs | undefined

  return {
    async start() {
      hooks.onStatus('starting')
      const connected = await fetchBotJson(`${SLACK_API_BASE}/apps.connections.open`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${appToken}` },
      })
      const url = stringField(connected, 'url')
      if (url === undefined) throw new Error('Socket Mode URL missing from apps.connections.open')
      ws = new ReconnectingWs(
        () => new WebSocket(url),
        {
          onOpen: () => {
            hooks.onStatus('online')
          },
          onMessage: (data) => {
            if (typeof data !== 'string' || ws === undefined) return
            const envelope = parseSlackEnvelope(data)
            if (envelope === undefined) return
            if (envelope.envelopeId !== undefined) ws.send(buildSlackAck(envelope.envelopeId))
            if (envelope.type === 'events_api') {
              const message = readSlackMessage(envelope.payload)
              if (message !== undefined) hooks.onInbound(message satisfies BotInbound)
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
            reject(new Error('Socket Mode socket did not open within 15s'))
          }
        }, 250)
      })
    },
    async stop() {
      ws?.stop()
      ws = undefined
    },
    async send(chatId, text) {
      for (const piece of chunkText(text, SLACK_MESSAGE_LIMIT)) {
        await postBotJson(`${SLACK_API_BASE}/chat.postMessage`, { channel: chatId, text: piece }, {
          Authorization: `Bearer ${botToken}`,
        })
      }
    },
    async probe() {
      const result = await fetchBotJson(`${SLACK_API_BASE}/auth.test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${botToken}` },
      })
      if ((result as { ok?: unknown }).ok !== true) throw new Error('auth.test rejected')
    },
  }
}
