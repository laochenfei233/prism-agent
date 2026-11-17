/**
 * One config-driven HTTP transcription provider: it uploads the canonical WAV
 * to a third-party endpoint speaking the OpenAI `/audio/transcriptions` multipart
 * form, an audio-bearing chat-completions request, or a raw-bytes upload, and
 * reads the recognized text from the JSON answer under the configured dot path.
 * The provider owns no preparation, so the registry reports it ready on arrival.
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

/** Request form one configured service speaks. */
export type SpeechHttpMode = 'transcriptions' | 'chat-completions' | 'raw-body'

/** Credential placement one configured service expects. */
export type SpeechHttpAuthStyle = 'bearer' | 'token' | 'raw'

/** Longest JSON answer this provider reads before giving up on the body. */
const MAX_RESPONSE_BYTES = 1024 * 1024

/** One configured third-party transcription service. */
export interface HttpAsrServiceOptions {
  /** Registration identity this recognizer occupies. */
  readonly id: string
  /** Operator-facing display name; defaults to the model, then the id. */
  readonly name?: string
  /** Complete POST URL of the transcription endpoint; `raw-body` services carry any fixed query parameters here. */
  readonly endpoint: string
  /** Request form the service speaks; defaults to the OpenAI multipart form. */
  readonly mode?: SpeechHttpMode
  /** Transcription model named in the request; omitted models send no model field or parameter. */
  readonly model?: string
  /** Language hints this recognizer accepts, including `auto`. */
  readonly languages: readonly string[]
  /**
   * Response field carrying the recognized text, as a dot path: object keys and
   * numeric array indices (`results.channels.0.alternatives.0.transcript`).
   */
  readonly textField: string
  /** Credential header; defaults to `authorization`. */
  readonly authHeader?: string
  /** Credential value prefix; defaults to the `Bearer` scheme. */
  readonly authStyle?: SpeechHttpAuthStyle
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
  private readonly mode: SpeechHttpMode
  private readonly model: string | undefined
  private readonly textField: string
  private readonly authHeader: string
  private readonly authStyle: SpeechHttpAuthStyle
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
      name: options.name ?? options.model ?? options.id,
      location: 'cloud',
      languages: [...options.languages],
      // The registry splits recordings beyond this cap, so the per-service duration
      // and byte limits both stay satisfied by whatever pieces arrive.
      maxAudioSeconds: Math.min(options.maxDurationSeconds, Math.floor((options.maxAudioBytes - 44) / 32000)),
    }
    this.endpoint = options.endpoint
    this.mode = options.mode ?? 'transcriptions'
    this.model = options.model
    this.textField = options.textField
    this.authHeader = options.authHeader?.toLowerCase() ?? 'authorization'
    this.authStyle = options.authStyle ?? 'bearer'
    this.maxAudioBytes = options.maxAudioBytes
    this.maxDurationSeconds = options.maxDurationSeconds
    this.timeoutMs = options.timeoutMs
    this.resolveApiKey = options.resolveApiKey
    this.doFetch = options.doFetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  /**
   * Upload one canonical recording in the configured request form and read the
   * recognized text of the JSON answer.
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
    const response = await this.doFetch(this.endpoint, this.mode === 'chat-completions'
      ? this.chatCompletionsRequest(apiKey, input, callDeadline.signal)
      : this.mode === 'raw-body'
        ? this.rawBodyRequest(apiKey, input, callDeadline.signal)
        : this.transcriptionsRequest(apiKey, input, callDeadline.signal))
    const body = await readBody(response)
    if (!response.ok) {
      throw new Error(`Speech service ${this.info.name} answered ${response.status}: ${body}`)
    }
    const text = this.mode === 'chat-completions'
      ? readChatCompletionsText(body, this.info.name)
      : readTextPath(body, this.textField, this.info.name)
    callDeadline.signal.throwIfAborted()
    return {
      text,
      audioSeconds,
      inferenceSeconds: (performance.now() - startedAt) / 1000,
    }
  }

  /**
   * Build the OpenAI `/audio/transcriptions` multipart request.
   * @param apiKey - resolved credential.
   * @param input - complete WAV bytes and the resolved language hint.
   * @param signal - deadline signal covering the request.
   * @returns the fetch request descriptor.
   */
  private transcriptionsRequest(apiKey: string, input: SpeechInput, signal: AbortSignal): RequestInit {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(input.audio)], { type: 'audio/wav' }), 'audio.wav')
    if (this.model !== undefined) form.append('model', this.model)
    if (input.language !== 'auto') form.append('language', input.language)
    return {
      method: 'POST',
      headers: this.credentialHeaders(apiKey),
      body: form,
      signal,
    }
  }

  /**
   * Build the raw-bytes request: the canonical WAV travels as the whole body and
   * any fixed model or language parameters live in the configured endpoint URL.
   * @param apiKey - resolved credential.
   * @param input - complete WAV bytes; the language hint is not transmitted.
   * @param signal - deadline signal covering the request.
   * @returns the fetch request descriptor.
   */
  private rawBodyRequest(apiKey: string, input: SpeechInput, signal: AbortSignal): RequestInit {
    return {
      method: 'POST',
      headers: { ...this.credentialHeaders(apiKey), 'content-type': 'audio/wav' },
      body: new Uint8Array(input.audio),
      signal,
    }
  }

  /**
   * Headers carrying the resolved credential under the configured header and scheme.
   * @param apiKey - resolved credential value.
   * @returns one header record for the request builders.
   */
  private credentialHeaders(apiKey: string): Record<string, string> {
    const prefix = this.authStyle === 'bearer' ? 'Bearer ' : this.authStyle === 'token' ? 'Token ' : ''
    return { [this.authHeader]: `${prefix}${apiKey}` }
  }

  /**
   * Build the audio-bearing chat-completions request: the canonical WAV travels
   * as one base64 data URL inside an `input_audio` content part, the form
   * chat-completions ASR services such as MiMo-V2.5-ASR document. `asr_options`
   * is those services' language knob; the auto hint uses the endpoint's own
   * detection default.
   * @param apiKey - resolved credential.
   * @param input - complete WAV bytes and the resolved language hint.
   * @param signal - deadline signal covering the request.
   * @returns the fetch request descriptor.
   */
  private chatCompletionsRequest(apiKey: string, input: SpeechInput, signal: AbortSignal): RequestInit {
    const audio = `data:audio/wav;base64,${Buffer.from(input.audio).toString('base64')}`
    return {
      method: 'POST',
      headers: { ...this.credentialHeaders(apiKey), 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(this.model === undefined ? {} : { model: this.model }),
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: audio } }] }],
        ...(input.language === 'auto' ? {} : { asr_options: { language: input.language } }),
      }),
      signal,
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
 * Read the mapped response field of one JSON answer, following the configured dot
 * path through object keys and numeric array indices.
 * @param body - the response body text.
 * @param path - the configured field path (`text`, `results.channels.0.alternatives.0.transcript`).
 * @param name - the service display name for the failure message.
 * @returns the recognized text; empty when the service recognized no speech.
 */
function readTextPath(body: string, path: string, name: string): string {
  let walked: unknown
  try {
    walked = JSON.parse(body)
  } catch (error) {
    throw new Error(`Speech service ${name} answered malformed JSON: ${reasonOf(error)}`)
  }
  for (const segment of path.split('.')) {
    const container = walked
    const index = /^\d+$/.test(segment) ? Number(segment) : segment
    const value = typeof container === 'object' && container !== null
      ? (container as Record<string | number, unknown>)[index]
      : undefined
    if (value === undefined) {
      throw new Error(`Speech service ${name} answered without the "${path}" field`)
    }
    walked = value
  }
  // An empty string is the legitimate "no speech was recognized" transcript.
  if (typeof walked !== 'string') {
    throw new Error(`Speech service ${name} answered without a "${path}" text`)
  }
  return walked
}

/**
 * Read the recognized text of one chat-completions answer.
 * @param body - the response body text.
 * @param name - the service display name for the failure message.
 * @returns the recognized text; empty when the service recognized no speech.
 */
function readChatCompletionsText(body: string, name: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new Error(`Speech service ${name} answered malformed JSON: ${reasonOf(error)}`)
  }
  const message = typeof parsed === 'object' && parsed !== null
    && Array.isArray((parsed as Record<string, unknown>).choices)
    ? (parsed as { choices: ReadonlyArray<{ message?: { content?: unknown } }> }).choices[0]?.message
    : undefined
  // An empty string is the legitimate "no speech was recognized" transcript.
  if (typeof message?.content !== 'string') {
    throw new Error(`Speech service ${name} answered without a "choices[0].message.content" text`)
  }
  return message.content
}

/** Operator-readable text for one thrown value. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
