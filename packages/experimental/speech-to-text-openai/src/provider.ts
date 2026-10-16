/**
 * The OpenAI-compatible recognizer: one multipart HTTP request per recording, so
 * the caller's audio leaves the host as a single upload the deployment's endpoint
 * bounds by bytes and by duration.
 * @module @deepseek-ai/dsh-experimental-speech-to-text-openai/provider
 */

import type {
  SpeechInput,
  SpeechProvider,
  SpeechProviderId,
  SpeechProviderInfo,
  SpeechStreaming,
  Transcript,
} from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { OPENAI_API_KEY_ERROR, OPENAI_TIMEOUT_CODE, OpenAiTimeoutError } from './errors.ts'
import { AUTO_LANGUAGE, decodeJson, failureDetail, transcriptText, transcriptionUrl } from './protocol.ts'
import { OpenAiStreaming } from './stream.ts'

export { OPENAI_API_KEY_ERROR, OPENAI_TIMEOUT_CODE, OpenAiTimeoutError } from './errors.ts'

/** Deployment-selected OpenAI-compatible recognizer settings. */
export interface OpenAiProviderOptions {
  /** Registration identity this provider occupies in the registry. */
  readonly id: SpeechProviderId
  /** Display name shown by speech surfaces. */
  readonly name: string
  /** API root the transcription path is joined to. */
  readonly baseUrl: string
  /** Transcription model name the endpoint serves when a call names none. */
  readonly model: string
  /** Models this deployment offers for selection, in order; omitted or empty offers no choice. */
  readonly models?: readonly string[]
  /** Language hints this recognizer accepts. */
  readonly languages: readonly string[]
  /** Maximum accepted recording duration in seconds. */
  readonly maxDurationSeconds: number
  /** Maximum accepted upload size in bytes. */
  readonly maxUploadBytes: number
  /** Deadline, in milliseconds, covering one request end to end. */
  readonly timeoutMs: number
  /** Read the bearer token; `undefined` fails the call with a configuration error. */
  readonly resolveApiKey: () => Promise<string | undefined>
}

/** The OpenAI-compatible recognizer registered into `ctx.speechToText`. */
export class OpenAiSpeechProvider implements SpeechProvider {
  readonly info: SpeechProviderInfo
  readonly streaming: SpeechStreaming

  /**
   * @param options - deployment-selected endpoint, model, limits, and key resolution.
   */
  constructor(private readonly options: OpenAiProviderOptions) {
    const models = options.models ?? []
    if (models.length > 0 && !models.includes(options.model)) {
      throw new Error(`The default model ${options.model} is not among the offered models`)
    }
    this.info = {
      id: options.id,
      name: options.name,
      location: 'cloud',
      languages: options.languages,
      model: options.model,
      ...models.length === 0 ? {} : { models },
    }
    this.streaming = new OpenAiStreaming(options)
  }

  /**
   * Recognize one canonical WAV recording through one HTTP request.
   * @param input - 16 kHz mono PCM16 WAV bytes and the language hint.
   * @param signal - caller cancellation; the request is aborted before rejection.
   * @returns The recognized text and measured durations.
   */
  async transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript> {
    const audioSeconds = validateWave(input.audio, this.options.maxDurationSeconds)
    if (input.audio.byteLength > this.options.maxUploadBytes) {
      throw new Error(`Audio exceeds the ${this.options.maxUploadBytes}-byte upload limit`)
    }
    const apiKey = await this.options.resolveApiKey()
    if (apiKey === undefined || apiKey.length === 0) throw new Error(OPENAI_API_KEY_ERROR)
    signal.throwIfAborted()
    using callDeadline = deadline(signal, this.options.timeoutMs, OPENAI_TIMEOUT_CODE)
    const startedAt = performance.now()
    let text: string
    try {
      text = await this.request(input.audio, input.language, input.model ?? this.options.model, apiKey, callDeadline.signal)
    } catch (error) {
      // A deadline only notifies; the request translates its own reason here.
      const elapsed = timeoutOf(callDeadline.signal, OPENAI_TIMEOUT_CODE)
      if (elapsed !== undefined) throw new OpenAiTimeoutError(elapsed.timeoutMs)
      throw error
    }
    return { text, audioSeconds, inferenceSeconds: (performance.now() - startedAt) / 1000 }
  }

  /**
   * Send one request and read its recognized text.
   * @param audio - complete canonical WAV bytes.
   * @param language - resolved language hint, or the detection sentinel.
   * @param model - resolved model this call runs.
   * @param apiKey - resolved bearer token.
   * @param signal - request deadline; its firing aborts the fetch.
   * @returns The recognized text.
   * @throws {Error} The endpoint answered with a failure status or an unusable body.
   */
  private async request(
    audio: Uint8Array,
    language: string,
    model: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await fetch(transcriptionUrl(this.options.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: this.form(audio, language, model),
      signal,
    })
    const body = await response.text()
    if (!response.ok) {
      throw new Error(`The transcription request failed with HTTP ${response.status}${failureDetail(body)}`)
    }
    return transcriptText(decodeJson(body))
  }

  /**
   * Build the multipart body one request carries.
   * @param audio - complete canonical WAV bytes.
   * @param language - resolved language hint, or the detection sentinel.
   * @param model - resolved model this call runs.
   * @returns The form whose file part holds the recording.
   */
  private form(audio: Uint8Array, language: string, model: string): FormData {
    const form = new FormData()
    // A discrete ArrayBuffer is what BlobPart accepts; the caller's view may sit
    // on a shared or oversized buffer.
    form.append('file', new Blob([Uint8Array.from(audio).buffer], { type: 'audio/wav' }), 'recording.wav')
    form.append('model', model)
    form.append('response_format', 'json')
    if (language !== AUTO_LANGUAGE) form.append('language', language)
    return form
  }
}
