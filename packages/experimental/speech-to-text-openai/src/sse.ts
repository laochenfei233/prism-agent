/**
 * Decoding of the `text/event-stream` body an OpenAI-compatible transcription
 * endpoint returns when the request asks for streaming.
 * @module @deepseek-ai/dsh-experimental-speech-to-text-openai/sse
 */

/**
 * Read the `data` payloads of one server-sent event stream.
 * @param body - the response body, still arriving.
 * @param signal - request cancellation; it stops the read.
 * @returns each payload in arrival order, without the `data:` prefix.
 */
export async function* sseData(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      // Event blocks are separated by a blank line, which the wire spells with any
      // of the three line endings the event-stream format allows.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/gu, '\n')
      for (let boundary = buffer.indexOf('\n\n'); boundary >= 0; boundary = buffer.indexOf('\n\n')) {
        const payload = payloadOf(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (payload !== undefined) yield payload
      }
    }
    const payload = payloadOf(buffer)
    if (payload !== undefined) yield payload
  } finally {
    // An observer that stopped early leaves the body open; cancelling it lets the
    // transport settle instead of holding the connection until the body is collected.
    await reader.cancel()
  }
}

/**
 * Read the payload one event block carries.
 * @param block - one complete event block, without its terminating blank line.
 * @returns The joined `data` lines, or `undefined` when the block carries none.
 */
export function payloadOf(block: string): string | undefined {
  const lines = block.split('\n').filter(line => line.startsWith('data:'))
  if (lines.length === 0) return undefined
  return lines.map(line => line.slice('data:'.length).replace(/^ /u, '')).join('\n')
}
