/**
 * Discord bot adapter: Gateway v10 over a reconnecting WebSocket, replies
 * through the REST messages route. Frame parsing, the identify payload, and
 * the dispatch filter are pure and tested.
 *
 * @module @prism/prism-pocket/bots/adapters
 */

import type { BotAdapterFactory, BotInbound } from '../types.ts'
import { chunkText } from '../shared/chunk.ts'
import { fetchBotJson, postBotJson, stringField } from '../shared/http.ts'
import { ReconnectingWs, waitForSocketReady } from '../shared/ws.ts'

/** Per-message character limit of Discord text messages. */
export const DISCORD_MESSAGE_LIMIT = 2000

/** Gateway intents: guild messages, direct messages, message content. */
export const DISCORD_INTENTS = (1 << 9) | (1 << 12) | (1 << 15)

/** Base URL of the Discord REST API v10. */
export const DISCORD_API_BASE = 'https://discord.com/api/v10'

/** One gateway frame, narrowed to the fields the adapter reads. */
export interface DiscordFrame {
  readonly op: number
  readonly t?: string
  readonly s?: number
  readonly data?: unknown
}

/** Parse one gateway text frame; non-JSON input reads as undefined. */
export function parseDiscordFrame(text: string): DiscordFrame | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const frame = parsed as { op?: unknown; t?: unknown; s?: unknown; d?: unknown }
    if (typeof frame.op !== 'number') return undefined
    return {
      op: frame.op,
      ...(typeof frame.t === 'string' ? { t: frame.t } : {}),
      ...(typeof frame.s === 'number' ? { s: frame.s } : {}),
      ...(frame.d !== undefined ? { data: frame.d } : {}),
    }
  } catch {
    return undefined
  }
}

/** The op 2 identify payload the gateway expects after Hello. */
export function buildDiscordIdentify(botToken: string): string {
  return JSON.stringify({
    op: 2,
    d: { token: botToken, intents: DISCORD_INTENTS, shard: [0, 1] },
  })
}

/** One MESSAGE_CREATE dispatch, narrowed to the fields the adapter reads. */
export interface DiscordMessage {
  readonly chatId: string
  readonly senderId: string
  readonly messageId: string
  readonly senderName?: string
  readonly text: string
}

/**
 * Narrow one MESSAGE_CREATE dispatch; bot-authored or empty messages read as
 * undefined.
 * @param data - the dispatch `d`.
 * @returns the message view, or undefined when not usable.
 */
export function readDiscordMessage(data: unknown): DiscordMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { content?: unknown; channel_id?: unknown; id?: unknown; author?: unknown }
  if (typeof record.channel_id !== 'string' || typeof record.content !== 'string') return undefined
  if (record.content.trim().length === 0) return undefined
  const author = typeof record.author === 'object' && record.author !== null
    ? record.author as { id?: unknown; bot?: unknown; username?: unknown }
    : undefined
  if (author?.bot === true) return undefined
  const senderName = typeof author?.username === 'string' ? author.username : undefined
  // The author snowflake is the stable per-user id; the message snowflake never repeats.
  const senderId = typeof author?.id === 'string' ? author.id : ''
  const messageId = typeof record.id === 'string' ? record.id : ''
  return {
    chatId: record.channel_id,
    senderId,
    messageId,
    text: record.content.trim(),
    ...(senderName !== undefined ? { senderName } : {}),
  }
}

/** The adapter: one managed gateway socket plus REST sends. */
export const createDiscordAdapter: BotAdapterFactory = (config, hooks) => {
  const botToken = (config as { botToken: string }).botToken
  let ws: ReconnectingWs | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let lastSequence: number | null = null

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }

  const handle = (socket: ReconnectingWs, frame: DiscordFrame): void => {
    if (frame.s !== undefined) lastSequence = frame.s
    if (frame.op === 10) {
      const interval = (frame.data as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval
      socket.send(buildDiscordIdentify(botToken))
      if (typeof interval === 'number' && interval > 0) {
        clearHeartbeat()
        heartbeatTimer = setInterval(() => {
          socket.send(JSON.stringify({ op: 1, d: lastSequence }))
        }, interval)
      }
      return
    }
    if (frame.op === 0 && frame.t === 'MESSAGE_CREATE') {
      const message = readDiscordMessage(frame.data)
      if (message !== undefined) hooks.onInbound(message satisfies BotInbound)
    }
  }

  return {
    async start() {
      hooks.onStatus('starting')
      const gateway = stringField(await fetchBotJson(`${DISCORD_API_BASE}/gateway/bot`, {
        headers: { Authorization: `Bot ${botToken}` },
      }), 'url')
      if (gateway === undefined) throw new Error('gateway URL missing from /gateway/bot')
      ws = new ReconnectingWs(
        () => new WebSocket(gateway),
        {
          onOpen: () => {
            hooks.onStatus('online')
          },
          onMessage: (data) => {
            if (typeof data !== 'string' || ws === undefined) return
            const frame = parseDiscordFrame(data)
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
      // READY either arrives or the credentials are wrong; wait a bounded time for it.
      await waitForSocketReady(() => lastSequence !== null, {
        channel: 'discord',
        awaited: 'gateway READY did not arrive',
      })
    },
    async stop() {
      clearHeartbeat()
      ws?.stop()
      ws = undefined
    },
    async send(chatId, text) {
      for (const piece of chunkText(text, DISCORD_MESSAGE_LIMIT)) {
        await postBotJson(`${DISCORD_API_BASE}/channels/${encodeURIComponent(chatId)}/messages`, { content: piece }, {
          Authorization: `Bot ${botToken}`,
        })
      }
    },
    async probe() {
      await fetchBotJson(`${DISCORD_API_BASE}/users/@me`, { headers: { Authorization: `Bot ${botToken}` } })
    },
  }
}
