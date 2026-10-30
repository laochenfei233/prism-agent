/**
 * Push and Bark delivery.
 *
 * Web Push posts one encrypted body per subscription with VAPID auth; Bark is
 * one POST against a user-provided endpoint. Both fail soft: delivery errors
 * reach the caller as results, never as agent-loop failures.
 *
 * @module @prism/prism-pocket/push
 */

import type { PocketPushPayload } from '../types.ts'
import type { VapidMaterial } from './keys.ts'
import { vapidAuthorization } from './keys.ts'

/** Injectable fetch; defaults to the global. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** One delivery outcome; `prune` marks an endpoint the service retired. */
export interface DeliveryResult {
  ok: boolean
  status: number
  prune: boolean
  /** Transport-level failure text when `status` is 0. */
  detail?: string
}

/** TTL the push service may hold the message for; matches the VAPID JWT lifetime. */
const PUSH_TTL_SECONDS = '86400'

/**
 * Deliver one encrypted push to one subscription endpoint.
 * @param endpoint - the push service URL.
 * @param body - the RFC 8291 ciphertext from `encryptPushPayload`.
 * @param urgency - `high` for blocking asks, `normal` for completions.
 * @param material - the VAPID keypair material.
 * @param fetchImpl - injectable fetch for tests.
 */
export async function deliverWebPush(
  endpoint: string,
  body: Buffer,
  urgency: 'high' | 'normal',
  material: VapidMaterial,
  fetchImpl: FetchLike = fetch,
): Promise<DeliveryResult> {
  try {
    const authorization = await vapidAuthorization(new URL(endpoint).origin, 'mailto:prism-pocket@localhost', material)
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        TTL: PUSH_TTL_SECONDS,
        Urgency: urgency,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(body),
    })
    return { ok: response.ok, status: response.status, prune: response.status === 404 || response.status === 410 }
  } catch (error: unknown) {
    return { ok: false, status: 0, prune: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Deliver one Bark notification.
 * @param barkUrl - the user's Bark push endpoint (device key included).
 * @param payload - the trigger payload; the title maps from `kind`.
 * @param fetchImpl - injectable fetch for tests.
 */
export async function deliverBark(
  barkUrl: string,
  payload: PocketPushPayload,
  fetchImpl: FetchLike = fetch,
): Promise<DeliveryResult> {
  const text = BARK_TITLES[payload.kind]
  try {
    const response = await fetchImpl(barkUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        title: text.title,
        body: [payload.detail, payload.sessionTitle].filter(Boolean).join(' · ') || text.body,
        group: 'prism-pocket',
      }),
    })
    return { ok: response.ok, status: response.status, prune: false }
  } catch (error: unknown) {
    return { ok: false, status: 0, prune: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** Node-side notification titles; the service worker keeps its own localized table. */
const BARK_TITLES: Record<PocketPushPayload['kind'], { title: string; body: string }> = {
  approval: { title: 'Approval needed', body: 'Prism is waiting for a decision' },
  question: { title: 'Question', body: 'Prism asked a question' },
  'turn-end': { title: 'Turn complete', body: 'A Prism turn finished' },
  error: { title: 'Run failed', body: 'A Prism turn failed' },
}
