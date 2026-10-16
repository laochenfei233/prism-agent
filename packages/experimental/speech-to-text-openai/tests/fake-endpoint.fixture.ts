/** Stand-in HTTP endpoint for the OpenAI-compatible transcription protocol. */
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'

/** One accepted request, captured before the endpoint answers. */
export interface RecordedRequest {
  readonly authorization: string | undefined
  readonly contentType: string
  readonly body: Buffer
}

/** What the stand-in answers with, and how late. */
export interface FakeEndpointOptions {
  /** Response body sent with every answer; defaults to a one-word transcript. */
  readonly response?: string
  /** HTTP status every answer carries; defaults to 200. */
  readonly status?: number
  /** Hold the answer this long, so a caller can cancel with the request in flight. */
  readonly delayMs?: number
  /** Accept the request and never answer it. */
  readonly neverAnswer?: boolean
  /** When set, answer with `text/event-stream` carrying one `data` frame per payload. */
  readonly events?: readonly string[]
}

/** A running stand-in endpoint. */
export interface FakeTranscriptionEndpoint {
  /** Base URL to configure the recognizer with; carries a `/v1` root. */
  readonly url: string
  /** Accepted requests in arrival order, each complete once its body was read. */
  readonly requests: RecordedRequest[]
  /** Release every connection and stop listening. */
  close(): Promise<void>
}

/**
 * Start one stand-in endpoint on an ephemeral loopback port.
 * @param options - answer body, status, and delay.
 * @returns The running endpoint.
 */
export async function startFakeEndpoint(options: FakeEndpointOptions = {}): Promise<FakeTranscriptionEndpoint> {
  const requests: RecordedRequest[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    let abandoned = false
    response.on('close', () => { abandoned = true })
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      requests.push({
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'] ?? '',
        body: Buffer.concat(chunks),
      })
      if (options.neverAnswer === true) return
      const answer = (): void => {
        // A caller that cancelled or timed out has already dropped the socket.
        if (abandoned || response.destroyed) return
        if (options.events !== undefined) {
          response.writeHead(options.status ?? 200, { 'content-type': 'text/event-stream' })
          response.end(options.events.map(payload => `data: ${payload}\n\n`).join(''))
          return
        }
        response.writeHead(options.status ?? 200, { 'content-type': 'application/json' })
        response.end(options.response ?? '{"text":"hello"}')
      }
      if (options.delayMs === undefined) answer()
      else setTimeout(answer, options.delayMs)
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The stand-in endpoint bound no TCP port')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { error === undefined ? resolve() : reject(error) })
      })
    },
  }
}

/**
 * Split one `multipart/form-data` body into its named parts.
 * @param body - the complete request body.
 * @param contentType - the request's Content-Type, carrying the boundary.
 * @returns Each part's name and raw bytes, without its headers or trailing CRLF.
 */
export function multipartParts(body: Buffer, contentType: string): Map<string, Buffer> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/u.exec(contentType)
  const delimiter = Buffer.from(`--${boundary?.[1] ?? boundary?.[2] ?? ''}`)
  if (delimiter.length === 2) throw new Error('The request carried no multipart boundary')
  const parts = new Map<string, Buffer>()
  let cursor = body.indexOf(delimiter)
  while (cursor >= 0) {
    const next = body.indexOf(delimiter, cursor + delimiter.length)
    const headerEnd = body.indexOf('\r\n\r\n', cursor)
    if (next < 0 || headerEnd < 0) break
    const name = /name="([^"]+)"/u.exec(body.toString('utf8', cursor + delimiter.length, headerEnd))?.[1]
    if (name !== undefined) parts.set(name, body.subarray(headerEnd + 4, next - 2))
    cursor = next
  }
  return parts
}

/**
 * Read one part as text.
 * @param parts - parts decoded by {@link multipartParts}.
 * @param name - the part's declared name.
 * @returns The part's UTF-8 text, or `undefined` when the request carried no such part.
 */
export function partText(parts: Map<string, Buffer>, name: string): string | undefined {
  return parts.get(name)?.toString('utf8')
}

/**
 * Build one canonical 16 kHz mono PCM16 WAV recording of silence.
 * @param seconds - duration in whole seconds.
 * @returns Complete WAV bytes accepted by the seam's `validateWave`.
 */
export function waveRecording(seconds: number): Buffer {
  const data = Buffer.alloc(seconds * 16_000 * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}
