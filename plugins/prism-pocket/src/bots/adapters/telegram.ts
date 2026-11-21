/**
 * Telegram bot adapter: long polling on `getUpdates`, replies via
 * `sendMessage`. The polling loop, the update filter, and the send body are
 * pure and tested; the loop only drives fetches.
 *
 * @module @prism/prism-pocket/bots/adapters
 */

import type { BotAdapterFactory, BotInbound } from '../types.ts'
import { chunkText } from '../shared/chunk.ts'
import { fetchBotJson, postBotJson, stringField } from '../shared/http.ts'

/** Per-message character limit of the Telegram Bot API. */
export const TELEGRAM_MESSAGE_LIMIT = 4096

/** Long-poll wait the platform holds the request open. */
export const TELEGRAM_POLL_SECONDS = 25

/**
 * Internal pacing of the poll loop: the pause after one failed poll before
 * it retries. Not a deployment knob.
 */
const POLL_ERROR_BACKOFF_MS = 5_000

/** Base URL of the Bot API for one bot token. */
export function telegramApiBase(botToken: string): string {
  return `https://api.telegram.org/bot${encodeURIComponent(botToken)}`
}

/** One raw Telegram update, narrowed to the fields the adapter reads. */
interface TelegramUpdate {
  readonly updateId: number
  readonly chatId: string
  readonly senderId: string
  readonly messageId: string
  readonly senderName?: string
  readonly text?: string
}

/**
 * Narrow one getUpdates array element into the adapter's view; non-text or
 * bot-authored updates read as undefined.
 * @param value - one element of the `result` array.
 * @returns the update view, or undefined when it carries no usable text.
 */
export function readTelegramUpdate(value: unknown): TelegramUpdate | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const update = value as { update_id?: unknown; message?: unknown }
  if (typeof update.update_id !== 'number') return undefined
  const message = typeof update.message === 'object' && update.message !== null ? update.message : undefined
  if (message === undefined) return undefined
  const record = message as { chat?: unknown; from?: unknown; text?: unknown; bot?: unknown; message_id?: unknown }
  const chat = typeof record.chat === 'object' && record.chat !== null ? record.chat : undefined
  const id = chat === undefined ? undefined : (chat as { id?: unknown }).id
  if (typeof record.text !== 'string' || record.text.trim().length === 0) return undefined
  const sender = typeof record.from === 'object' && record.from !== null
    ? record.from as { id?: unknown; first_name?: unknown; is_bot?: unknown }
    : undefined
  if (sender?.is_bot === true) return undefined
  const senderName = typeof sender?.first_name === 'string' ? sender.first_name : undefined
  // from.id is the Bot API's stable user id across chats and sessions.
  const senderId = typeof sender?.id === 'number' || typeof sender?.id === 'string' ? String(sender.id) : ''
  const messageId = typeof record.message_id === 'number' ? String(record.message_id) : ''
  return {
    updateId: update.update_id,
    chatId: String(id),
    senderId,
    messageId,
    text: record.text.trim(),
    ...(senderName !== undefined ? { senderName } : {}),
  }
}

/** Extract the `offset` the next getUpdates call must carry. */
export function nextTelegramOffset(updates: readonly TelegramUpdate[]): number | undefined {
  const last = updates[updates.length - 1]
  return last === undefined ? undefined : last.updateId + 1
}

/** Extract the reply body of one sendMessage response; absence is an error. */
export function readTelegramSendResult(body: unknown): string {
  const ok = (body as { ok?: unknown } | undefined)?.ok
  if (ok !== true) {
    const description = stringField(body, 'description') ?? 'no description'
    throw new Error(`sendMessage rejected: ${description}`)
  }
  return stringField((body as { result?: unknown }).result, 'message_id') ?? ''
}

/** The adapter: long polling with a per-handle abort. */
export const createTelegramAdapter: BotAdapterFactory = (config, hooks) => {
  const botToken = (config as { botToken: string }).botToken
  const base = telegramApiBase(botToken)
  let abort: AbortController | undefined
  let stopped = false

  const pollOnce = async (offset: number | undefined, signal: AbortSignal | undefined): Promise<TelegramUpdate[]> => {
    const url = `${base}/getUpdates?timeout=${TELEGRAM_POLL_SECONDS}${offset !== undefined ? `&offset=${offset}` : ''}`
    const response = await fetch(url, signal === undefined ? {} : { signal })
    if (!response.ok) throw new Error(`getUpdates HTTP ${response.status}`)
    const body: unknown = await response.json().catch(() => undefined)
    if ((body as { ok?: unknown } | undefined)?.ok !== true) throw new Error('getUpdates rejected')
    const result = (body as { result?: unknown }).result
    if (!Array.isArray(result)) return []
    return result.map(readTelegramUpdate).filter((update): update is TelegramUpdate => update !== undefined)
  }

  const loop = async (): Promise<void> => {
    const signal = abort?.signal
    const aborted = (): boolean => signal?.aborted === true
    let offset: number | undefined
    while (!stopped && !aborted()) {
      try {
        const updates = await pollOnce(offset, signal)
        offset = nextTelegramOffset(updates) ?? offset
        for (const update of updates) {
          const inbound: BotInbound = {
            chatId: update.chatId,
            senderId: update.senderId,
            messageId: update.messageId,
            text: update.text ?? '',
            ...(update.senderName !== undefined ? { senderName: update.senderName } : {}),
          }
          hooks.onInbound(inbound)
        }
      } catch (cause: unknown) {
        if (stopped || aborted()) return
        hooks.onStatus('error', cause instanceof Error ? cause.message : String(cause))
        await new Promise(resolve => setTimeout(resolve, POLL_ERROR_BACKOFF_MS))
      }
    }
  }

  return {
    async start() {
      abort = new AbortController()
      stopped = false
      hooks.onStatus('starting')
      await fetchBotJson(`${base}/getMe`)
      hooks.onStatus('online')
      void loop()
    },
    async stop() {
      stopped = true
      abort?.abort()
    },
    async send(chatId, text) {
      for (const piece of chunkText(text, TELEGRAM_MESSAGE_LIMIT)) {
        await postBotJson(`${base}/sendMessage`, { chat_id: chatId, text: piece })
      }
    },
    async probe() {
      await fetchBotJson(`${base}/getMe`)
    },
  }
}
