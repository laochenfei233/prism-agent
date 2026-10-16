/**
 * Wire rules of the OpenAI audio transcription request: the endpoint path, the
 * response fields that carry recognized text, the streaming event vocabulary, and
 * the bounded diagnostic excerpt taken from a failed response.
 * @module @deepseek-ai/dsh-experimental-speech-to-text-openai/protocol
 */

/** Transcription endpoint path, relative to the configured base URL. */
const TRANSCRIPTIONS_PATH = '/audio/transcriptions'

/** Base URL of the public OpenAI API; deployments serving another compatible endpoint override it. */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/** Language hint asking the recognizer to detect the language itself. */
export const AUTO_LANGUAGE = 'auto'

/** Characters of a failed response body retained in the thrown diagnostic. */
const MAX_DETAIL_CHARACTERS = 500

/** Sample rate, in Hz, every recording this provider builds declares. */
const SAMPLE_RATE = 16_000

/** PCM16 bytes one second of this provider's audio occupies. */
export const PCM_BYTES_PER_SECOND = SAMPLE_RATE * 2

/** Bytes of the canonical WAV header one built recording carries. */
const WAV_HEADER_BYTES = 44

/** One event of a streaming transcription response; payloads outside this set are ignored. */
export type TranscriptStreamEvent =
  /** Text appended to the transcript so far. */
  | { readonly type: 'transcript.text.delta'; readonly delta: string }
  /** One diarized span, which the endpoint sends only for a diarizing model and format. */
  | {
    readonly type: 'transcript.text.segment'
    readonly id: string
    readonly text: string
    readonly speaker: string
    readonly start: number
    readonly end: number
  }
  /** The complete transcript, sent once at the end of the stream. */
  | { readonly type: 'transcript.text.done'; readonly text: string }

/**
 * Join one configured base URL with the transcription path.
 * @param baseUrl - deployment-selected API root, with or without trailing slashes.
 * @returns The absolute transcription endpoint.
 */
export function transcriptionUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}${TRANSCRIPTIONS_PATH}`
}

/**
 * Build one canonical 16 kHz mono PCM16 WAV recording from submitted samples.
 * @param chunks - PCM16 samples in submission order.
 * @param bytes - total sample bytes across the chunks.
 * @returns The complete recording, header included.
 */
export function wavOf(chunks: readonly Uint8Array[], bytes: number): Uint8Array<ArrayBuffer> {
  const recording = new Uint8Array(WAV_HEADER_BYTES + bytes)
  const header = new DataView(recording.buffer)
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index++) recording[offset + index] = text.charCodeAt(index)
  }
  ascii(0, 'RIFF')
  header.setUint32(4, WAV_HEADER_BYTES - 8 + bytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true)
  header.setUint16(22, 1, true)
  header.setUint32(24, SAMPLE_RATE, true)
  header.setUint32(28, PCM_BYTES_PER_SECOND, true)
  header.setUint16(32, 2, true)
  header.setUint16(34, 16, true)
  ascii(36, 'data')
  header.setUint32(40, bytes, true)
  let offset = WAV_HEADER_BYTES
  for (const chunk of chunks) {
    recording.set(chunk, offset)
    offset += chunk.byteLength
  }
  return recording
}

/**
 * Read recognized text from a transcription response.
 * @param payload - decoded JSON body of a successful non-streaming response.
 * @returns The recognized text; an empty string means no speech was recognized.
 * @throws {Error} The payload is not an object carrying a string `text` field.
 */
export function transcriptText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || !('text' in payload) || typeof payload.text !== 'string') {
    throw new Error('The transcription response carried no text field')
  }
  return payload.text
}

/**
 * Decode a response body as JSON.
 * @param body - the complete response body.
 * @returns The decoded value, which callers still validate.
 * @throws {Error} The body is not JSON.
 */
export function decodeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new Error('The transcription response was not JSON', { cause: error })
  }
}

/** Read one member of a decoded payload without asserting the payload's type. */
function memberOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

/** Read a required string member, naming the field a malformed event omitted. */
function requiredString(value: unknown, key: string): string {
  const found = memberOf(value, key)
  if (typeof found !== 'string') throw new Error(`A transcription event carried no ${key}`)
  return found
}

/** Read a required numeric member, naming the field a malformed event omitted. */
function requiredNumber(value: unknown, key: string): number {
  const found = memberOf(value, key)
  if (typeof found !== 'number') throw new Error(`A transcription event carried no ${key}`)
  return found
}

/**
 * Decode one streaming payload.
 * @param payload - the text after `data:` in one event block.
 * @returns The decoded event, or `undefined` for the end-of-stream sentinel and any event this provider ignores.
 * @throws {Error} The payload is not JSON or names an event with a missing field.
 */
export function transcriptEvent(payload: string): TranscriptStreamEvent | undefined {
  if (payload === '[DONE]') return undefined
  const decoded = decodeJson(payload)
  const type = memberOf(decoded, 'type')
  if (type === 'transcript.text.delta') {
    return { type, delta: requiredString(decoded, 'delta') }
  }
  if (type === 'transcript.text.segment') {
    return {
      type,
      id: requiredString(decoded, 'id'),
      text: requiredString(decoded, 'text'),
      speaker: requiredString(decoded, 'speaker'),
      start: requiredNumber(decoded, 'start'),
      end: requiredNumber(decoded, 'end'),
    }
  }
  if (type === 'transcript.text.done') {
    return { type, text: requiredString(decoded, 'text') }
  }
  return undefined
}

/**
 * Condense a failed response body into a single-line diagnostic suffix.
 * @param body - the complete response body, which may be empty or arbitrarily long.
 * @returns `''` for an empty body, else `': <excerpt>'` truncated to {@link MAX_DETAIL_CHARACTERS}.
 */
export function failureDetail(body: string): string {
  const collapsed = body.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return ''
  const excerpt = collapsed.slice(0, MAX_DETAIL_CHARACTERS)
  return `: ${excerpt}${collapsed.length > MAX_DETAIL_CHARACTERS ? '…' : ''}`
}
