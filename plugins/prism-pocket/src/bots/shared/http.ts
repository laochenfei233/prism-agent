/**
 * Thin HTTP helpers for the bot adapters: one JSON fetch with a timeout and
 * a readable error, so every adapter reports failures the same way.
 *
 * @module @prism/prism-pocket/bots/shared
 */

/** How long one platform API call may take before it counts as failed. */
export const BOT_HTTP_TIMEOUT_MS = 10_000

/**
 * Fetch one JSON API route with a timeout.
 * @param url - the absolute API URL.
 * @param init - the request init; `body` must be pre-serialized JSON.
 * @returns the parsed JSON body.
 * @throws when the request fails or the platform answers non-2xx; the message carries the status and any platform error text.
 */
export async function fetchBotJson(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(BOT_HTTP_TIMEOUT_MS) })
  } catch (cause: unknown) {
    throw new Error(cause instanceof Error ? cause.message : String(cause))
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const detail = typeof body === 'object' && body !== null ? JSON.stringify(body) : `HTTP ${response.status}`
    throw new Error(`HTTP ${response.status}: ${detail}`)
  }
  return body
}

/**
 * POST one JSON body and return the parsed JSON response.
 * @param url - the absolute API URL.
 * @param body - the payload to serialize.
 * @param headers - extra headers, typically the authorization.
 * @returns the parsed JSON body.
 */
export async function postBotJson(url: string, body: unknown, headers?: Record<string, string>): Promise<unknown> {
  return await fetchBotJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/**
 * Read one string field from a JSON object response.
 * @param body - the parsed response.
 * @param field - the field name.
 * @returns the string, or undefined when absent or not a string.
 */
export function stringField(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}
