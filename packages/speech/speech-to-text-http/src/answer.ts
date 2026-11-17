/** Shared request plumbing for the provider-specific forms: bounded bodies, JSON answers, polling sleeps. */

/** Longest JSON answer the provider reads before giving up on the body. */
const MAX_RESPONSE_BYTES = 1024 * 1024

/**
 * Read one bounded answer body.
 * @param response - the service response.
 * @returns the body text; empty when the service sent none.
 */
export async function readBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > MAX_RESPONSE_BYTES) throw new Error(`Speech service answer exceeded ${MAX_RESPONSE_BYTES} bytes`)
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Read one JSON answer body, mapping parse failures to the operator-readable form.
 * @param response - the service response.
 * @param name - the service display name for the failure message.
 * @returns the parsed answer.
 */
export async function readAnswerJson(response: Response, name: string): Promise<unknown> {
  return parseAnswerText(await readBody(response), name)
}

/**
 * Parse one already-read answer body, mapping parse failures to the operator-readable form.
 * @param body - the response body text.
 * @param name - the service display name for the failure message.
 * @returns the parsed answer.
 */
export function parseAnswerText(body: string, name: string): unknown {
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new Error(`Speech service ${name} answered malformed JSON: ${reasonOf(error)}`)
  }
}

/** @returns after one delay, rejecting when the deadline signal aborts. */
export async function sleepFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Operator-readable text for one thrown value. */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read one bounded JSON-object answer, rejecting HTTP failures, malformed JSON,
 * and non-object bodies in the operator-readable forms.
 * @param response - the service response.
 * @returns the parsed object envelope.
 */
export async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const body = await readBody(response)
  if (!response.ok) throw new Error(`Speech service answered ${response.status}: ${body}`)
  const parsed = parseAnswerText(body, 'answer')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Speech service did not answer a JSON object')
  }
  return parsed as Record<string, unknown>
}
