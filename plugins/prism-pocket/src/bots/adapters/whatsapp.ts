/**
 * WhatsApp Cloud API adapter: receive rides the webhook route verified by
 * the X-Hub-Signature-256 HMAC, replies go through the Graph send API. The
 * signature check, verification handshake, and payload narrow are pure and
 * tested.
 *
 * @module @prism/prism-pocket/bots/adapters
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { BotAdapterFactory, WhatsappConfig } from '../types.ts'
import { chunkText } from '../shared/chunk.ts'
import { postBotJson } from '../shared/http.ts'

/** Per-message character limit of the Cloud API text message. */
export const WHATSAPP_MESSAGE_LIMIT = 4096

/** Graph API version pinned for the send route. */
export const WHATSAPP_GRAPH_VERSION = 'v21.0'

/**
 * Verify one webhook delivery's HMAC signature.
 * @param appSecret - the Meta app secret.
 * @param rawBody - the exact request body bytes.
 * @param header - the `X-Hub-Signature-256` header (`sha256=<hex>`).
 * @returns whether the signature matches.
 */
export function verifyWhatsappSignature(appSecret: string, rawBody: string, header: string): boolean {
  const prefix = 'sha256='
  if (!header.startsWith(prefix)) return false
  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')
  const provided = header.slice(prefix.length)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

/**
 * Resolve one webhook verification handshake.
 * @param query - the request's query parameters.
 * @param verifyToken - the configured verify token.
 * @returns the challenge to echo, or undefined when the handshake fails.
 */
export function resolveWhatsappVerifyChallenge(
  query: Readonly<Record<string, string | undefined>>,
  verifyToken: string,
): string | undefined {
  if (query['hub.mode'] !== 'subscribe' || query['hub.verify_token'] !== verifyToken) return undefined
  const challenge = query['hub.challenge']
  return challenge !== undefined && challenge.length > 0 ? challenge : undefined
}

/** One inbound webhook message, narrowed to the fields the adapter reads. */
export interface WhatsappMessage {
  readonly from: string
  readonly text: string
}

/**
 * Narrow one webhook delivery body; statuses and non-text messages read as
 * undefined.
 * @param body - the parsed webhook body.
 * @returns every usable text message in the delivery.
 */
export function readWhatsappMessages(body: unknown): readonly WhatsappMessage[] {
  if (typeof body !== 'object' || body === null) return []
  const entry = (body as { entry?: unknown }).entry
  if (!Array.isArray(entry)) return []
  const messages: WhatsappMessage[] = []
  for (const item of entry) {
    const changes = (item as { changes?: unknown } | undefined)?.changes
    if (!Array.isArray(changes)) continue
    for (const change of changes) {
      const value = (change as { value?: unknown } | undefined)?.value
      const list = typeof value === 'object' && value !== null ? (value as { messages?: unknown }).messages : undefined
      if (!Array.isArray(list)) continue
      for (const message of list) {
        const record = message as { from?: unknown; text?: unknown }
        const text = typeof record.text === 'object' && record.text !== null ? (record.text as { body?: unknown }).body : undefined
        if (typeof record.from !== 'string' || typeof text !== 'string' || text.trim().length === 0) continue
        messages.push({ from: record.from, text: text.trim() })
      }
    }
  }
  return messages
}

/** The adapter: webhook-only receive plus the Graph send. */
export const createWhatsappAdapter: BotAdapterFactory = (config, hooks) => {
  const fields = config as WhatsappConfig
  return {
    async start() {
      // Callback channels are online once configured; the route delivers inbound messages.
      hooks.onStatus('starting')
      hooks.onStatus('online')
    },
    async stop() { /* No connection to close; the route owns receive. */ },
    async send(chatId, text) {
      for (const piece of chunkText(text, WHATSAPP_MESSAGE_LIMIT)) {
        await postBotJson(
          `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(fields.phoneNumberId)}/messages`,
          { messaging_product: 'whatsapp', to: chatId, type: 'text', text: { body: piece } },
          { Authorization: `Bearer ${fields.accessToken}` },
        )
      }
    },
    async probe() {
      // The cheapest credential check is a phone-number read through the Graph API.
      await fetch(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(fields.phoneNumberId)}?access_token=${encodeURIComponent(fields.accessToken)}`)
        .then(async response => {
          if (!response.ok) throw new Error(`phone number read failed: HTTP ${response.status}`)
          return await response.json()
        })
    },
  }
}
