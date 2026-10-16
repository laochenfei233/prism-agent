/**
 * The DashScope recognizer: one duplex session per recording, PCM16 upload with
 * bounded client buffering, and sentence assembly that keeps the last text the
 * service sent for each sentence. It also publishes the duplex live session the
 * seam's streaming capability opens.
 * @module @deepseek-ai/dsh-experimental-speech-to-text-dashscope/provider
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
import { RecognitionSession, UPLOAD_CHUNK_BYTES, WAV_HEADER_BYTES, type RecognitionSessionOptions } from './session.ts'
import { DASHSCOPE_API_KEY_ERROR, DashScopeStreaming } from './stream.ts'

/** Timeout code for the deadline covering connect, upload, and result accumulation. */
export const DASHSCOPE_TIMEOUT_CODE = 'DASHSCOPE_RECOGNITION_TIMEOUT'

/** Timeout code for the deadline covering the results sent after `finish-task`. */
export const DASHSCOPE_DRAIN_TIMEOUT_CODE = 'DASHSCOPE_RESULT_DRAIN_TIMEOUT'

/** Language hint asking the recognizer to detect the language itself. */
const AUTO_LANGUAGE = 'auto'

/** Which deadline a recognition session outlived. */
export type DashScopeTimeoutPhase = 'recognition' | 'results'

/** Raised when one recognition session outlives its configured deadline. */
export class DashScopeTimeoutError extends Error {
  /**
   * @param phase - the deadline that elapsed.
   * @param timeoutMs - that deadline's configured duration.
   */
  constructor(readonly phase: DashScopeTimeoutPhase, readonly timeoutMs: number) {
    super(`DashScope ${phase === 'recognition' ? 'recognition' : 'result drain'} exceeded its ${timeoutMs}ms deadline`)
    this.name = 'DashScopeTimeoutError'
  }
}

/** Deployment-selected DashScope recognizer settings. */
export interface DashScopeProviderOptions {
  /** Registration identity this provider occupies in the registry. */
  readonly id: SpeechProviderId
  /** Display name shown by speech surfaces. */
  readonly name: string
  /** Duplex recognition endpoint. */
  readonly url: string
  /** Realtime recognition model name a session declares when none is selected. */
  readonly model: string
  /** Models this deployment offers for selection, in order; omitted or empty offers no choice. */
  readonly models?: readonly string[]
  /** Language hints this recognizer accepts. */
  readonly languages: readonly string[]
  /** Whether the model separates speakers in its results. */
  readonly speakerDiarization: boolean
  /** Maximum accepted recording duration in seconds. */
  readonly maxDurationSeconds: number
  /** Deadline, in milliseconds, covering connect, upload, and result accumulation. */
  readonly timeoutMs: number
  /** Deadline, in milliseconds, for the results the service sends after `finish-task`. */
  readonly drainTimeoutMs: number
  /** Read the bearer token; `undefined` fails the call with a configuration error. */
  readonly resolveApiKey: () => Promise<string | undefined>
}

/** The DashScope recognizer registered into `ctx.speechToText`. */
export class DashScopeSpeechProvider implements SpeechProvider {
  readonly info: SpeechProviderInfo
  readonly streaming: SpeechStreaming

  /**
   * @param options - deployment-selected endpoint, model, limits, and key resolution.
   */
  constructor(private readonly options: DashScopeProviderOptions) {
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
    this.streaming = new DashScopeStreaming(
      (language, model) => this.sessionOptions(language, model),
      options.resolveApiKey,
    )
  }

  /**
   * Recognize one canonical WAV recording through one duplex session.
   * @param input - 16 kHz mono PCM16 WAV bytes and the language hint.
   * @param signal - caller cancellation; the socket closes before rejection.
   * @returns the concatenated closed sentences and measured durations.
   */
  async transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript> {
    const audioSeconds = validateWave(input.audio, this.options.maxDurationSeconds)
    const apiKey = await this.options.resolveApiKey()
    if (apiKey === undefined || apiKey.length === 0) throw new Error(DASHSCOPE_API_KEY_ERROR)
    signal.throwIfAborted()
    using callDeadline = deadline(signal, this.options.timeoutMs, DASHSCOPE_TIMEOUT_CODE)
    const startedAt = performance.now()
    let sentences: string[]
    try {
      sentences = await this.recognize(input.audio, input.language, input.model, apiKey, callDeadline.signal)
    } catch (error) {
      // A deadline only notifies; the session translates its own reason here.
      const elapsed = timeoutOf(callDeadline.signal, DASHSCOPE_TIMEOUT_CODE)
      if (elapsed !== undefined) throw new DashScopeTimeoutError('recognition', elapsed.timeoutMs)
      throw error
    }
    return {
      text: sentences.join('\n'),
      audioSeconds,
      inferenceSeconds: (performance.now() - startedAt) / 1000,
    }
  }

  /** The facts one session connects and starts with for a resolved language and model. */
  private sessionOptions(language: string, model: string | undefined): RecognitionSessionOptions {
    return {
      url: this.options.url,
      model: model ?? this.options.model,
      parameters: {
        speaker_diarization_enabled: this.options.speakerDiarization,
        ...language === AUTO_LANGUAGE ? {} : { language_hints: [language] },
      },
    }
  }

  /**
   * Run one session to completion, collecting closed sentences.
   * @param audio - complete canonical WAV bytes.
   * @param language - resolved language hint the task declares.
   * @param model - resolved model, or `undefined` for this deployment's default.
   * @param apiKey - resolved bearer token.
   * @param signal - session deadline; its firing closes the socket.
   * @returns closed sentence texts in service order.
   */
  private async recognize(
    audio: Uint8Array,
    language: string,
    model: string | undefined,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    const session = await RecognitionSession.open(this.sessionOptions(language, model), apiKey, signal)
    try {
      await this.upload(session, audio, signal)
      session.finish()
      using drainDeadline = deadline(signal, this.options.drainTimeoutMs, DASHSCOPE_DRAIN_TIMEOUT_CODE)
      try {
        return await this.collect(session, drainDeadline.signal)
      } catch (error) {
        const drained = timeoutOf(drainDeadline.signal, DASHSCOPE_DRAIN_TIMEOUT_CODE)
        if (drained === undefined) throw error
        throw new DashScopeTimeoutError('results', drained.timeoutMs)
      }
    } finally {
      session.close()
    }
  }

  /**
   * Send the recording's PCM samples, waiting whenever the socket buffer is full.
   * @param session - the started session.
   * @param audio - complete canonical WAV bytes, including the header this step skips.
   * @param signal - session deadline.
   */
  private async upload(session: RecognitionSession, audio: Uint8Array, signal: AbortSignal): Promise<void> {
    const pcm = audio.subarray(WAV_HEADER_BYTES)
    for (let offset = 0; offset < pcm.length; offset += UPLOAD_CHUNK_BYTES) {
      signal.throwIfAborted()
      await session.push(pcm.subarray(offset, offset + UPLOAD_CHUNK_BYTES), signal)
    }
  }

  /**
   * Accumulate sentence results until the service reports the task finished. A later
   * frame for an unfinished sentence replaces the earlier text of the same sentence.
   * @param session - the started session, already sent `finish-task`.
   * @param signal - drain deadline.
   * @returns closed sentence texts in service order.
   */
  private async collect(session: RecognitionSession, signal: AbortSignal): Promise<string[]> {
    const closed: string[] = []
    for await (const event of session.events(signal)) {
      if (event.kind !== 'sentence' || !event.sentence.final) continue
      closed.push(event.sentence.text)
    }
    return closed
  }
}
