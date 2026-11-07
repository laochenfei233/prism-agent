/**
 * One config-driven HTTP transcription provider: it uploads the canonical WAV
 * to a third-party endpoint using the OpenAI `/audio/transcriptions` request
 * shape and reads the recognized text from one JSON response field. The
 * provider owns no preparation, so the registry reports it ready on arrival.
 * @module @deepseek-ai/dsh-experimental-speech-to-text-http/provider
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  SpeechProvider, SpeechProviderId, SpeechProviderInfo, SpeechInput, Transcript,
} from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave'
import { deadline } from '@deepseek-ai/dsh-timeout'

/** Deadline code the provider reports when the service exceeds its budget. */
export const HTTP_ASR_TIMEOUT_CODE = 'HTTP_ASR_TIMEOUT'

/** Longest JSON answer this provider reads before giving up on the body. */
const MAX_RESPONSE_BYTES = 1024 * 1024

/** One configured third-party transcription service. */
export interface HttpAsrServiceOptions {
  /** Registration identity this recognizer occupies. */
  readonly id: string
  /** Operator-facing display name; defaults to the model. */
  readonly name?: string
  /** Complete POST URL of the transcription endpoint. */
  readonly endpoint: string
  /** Transcription model named in the form. */
  readonly model: string
  /** Language hints this recognizer accepts, including `auto`. */
  readonly languages: readonly string[]
  /** Top-level JSON response field carrying the recognized text. */
  readonly textField: string
  /** Rejected recording size in bytes. */
  readonly maxAudioBytes: number
  /** Rejected recording duration in seconds. */
  readonly maxDurationSeconds: number
  /** Deadline, in milliseconds, covering upload and answer. */
  readonly timeoutMs: number
  /** Resolves the bearer credential; `undefined` fails the recognition. */
  readonly resolveApiKey: () => Promise<string | undefined>
  /** HTTP entry, injectable for tests. */
  readonly doFetch?: typeof fetch
}

/** One configured third-party transcription provider. */
export class HttpSpeechProvider implements SpeechProvider {
  /** Registry facts; the recognizer is usable the moment it is registered. */
  readonly info: SpeechProviderInfo

  private readonly endpoint: string
  private readonly model: string
  private readonly textField: string
  private readonly maxAudioBytes: number
  private readonly maxDurationSeconds: number
  private readonly timeoutMs: number
  private readonly resolveApiKey: () => Promise<string | undefined>
  private readonly doFetch: typeof fetch

  /**
   * @param options - identity, endpoint, bounds, credential resolution, and the HTTP entry.
   */
  constructor(options: HttpAsrServiceOptions) {
    this.info = {
      id: brandString<SpeechProviderId>(options.id),
      name: options.name ?? options.model,
      location: 'cloud',
      languages: [...options.languages],
    }
    this.endpoint = options.endpoint
    this.model = options.model
    this.textField = options.textField
    this.maxAudioBytes = options.maxAudioBytes
    this.maxDurationSeconds = options.maxDurationSeconds
    this.timeoutMs = options.timeoutMs
    this.resolveApiKey = options.resolveApiKey
    this.doFetch = options.doFetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  /**
   * Upload one canonical recording as `multipart/form-data` and read the mapped
   * text field of the JSON answer.
   * @param input - complete WAV bytes and the resolved language hint.
   * @param signal - caller or registration cancellation.
   * @returns the recognized text and measured durations.
   */
  async transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript> {
    signal.throwIfAborted()
    if (input.audio.byteLength > this.maxAudioBytes) {
      throw new Error(`Recording exceeds ${this.maxAudioBytes} bytes for ${this.info.name}`)
    }
    const audioSeconds = validateWave(input.audio, this.maxDurationSeconds)
    const apiKey = await this.resolveApiKey()
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(`Speech provider ${this.info.name} has no API key; configure the credential its deployment names`)
    }
    using callDeadline = deadline(signal, this.timeoutMs, HTTP_ASR_TIMEOUT_CODE)
    const startedAt = performance.now()
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(input.audio)], { type: 'audio/wav' }), 'audio.wav')
    form.append('model', this.model)
    if (input.language !== 'auto') form.append('language', input.language)
    const response = await this.doFetch(this.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: callDeadline.signal,
    })
    const body = await readBody(response)
    if (!response.ok) {
      throw new Error(`Speech service ${this.info.name} answered ${response.status}: ${body}`)
    }
    const text = readTextField(body, this.textField, this.info.name)
    callDeadline.signal.throwIfAborted()
    return {
      text,
      audioSeconds,
      inferenceSeconds: (performance.now() - startedAt) / 1000,
    }
  }
}

/**
 * Read one bounded answer body.
 * @param response - the service response.
 * @returns the body text; empty when the service sent none.
 */
async function readBody(response: Response): Promise<string> {
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
 * Read the mapped top-level field of one JSON answer.
 * @param body - the response body text.
 * @param field - the configured field name.
 * @param name - the service display name for the failure message.
 * @returns the recognized text; empty when the service recognized no speech.
 */
function readTextField(body: string, field: string, name: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new Error(`Speech service ${name} answered malformed JSON: ${reasonOf(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Speech service ${name} did not answer a JSON object carrying the "${field}" field`)
  }
  const text = (parsed as Record<string, unknown>)[field]
  // An empty string is the legitimate "no speech was recognized" transcript.
  if (typeof text !== 'string') {
    throw new Error(`Speech service ${name} answered without the "${field}" field`)
  }
  return text
}

/** Operator-readable text for one thrown value. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
