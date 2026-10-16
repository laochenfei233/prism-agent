/**
 * The OpenAI-compatible incremental-output session: the caller submits one complete
 * recording, and the endpoint streams the transcript it produces from it. This is
 * not a duplex session — audio is buffered until `close()`, because the endpoint
 * accepts a single upload.
 * @module @deepseek-ai/dsh-experimental-speech-to-text-openai/stream
 */

import type {
  SpeechSegment,
  SpeechStream,
  SpeechStreamInput,
  SpeechStreamUpdate,
  SpeechStreaming,
} from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { failureOf, OPENAI_API_KEY_ERROR, OPENAI_TIMEOUT_CODE, OpenAiTimeoutError } from './errors.ts'
import {
  AUTO_LANGUAGE,
  failureDetail,
  PCM_BYTES_PER_SECOND,
  transcriptEvent,
  transcriptionUrl,
  wavOf,
} from './protocol.ts'
import { sseData } from './sse.ts'
import type { OpenAiProviderOptions } from './provider.ts'

/** Span id every non-diarized transcript's running text is reported under. */
const RUNNING_SPAN_ID = 's0'

/** One queued delivery: an update, or the settlement that ends the sequence. */
type Delivery = { readonly kind: 'update'; readonly update: SpeechStreamUpdate } | { readonly kind: 'end' }

/** Ordered updates with the failure that ends them, held until an observer asks. */
class UpdateQueue {
  private readonly delivered: Delivery[] = []
  private waiting: (() => void) | undefined
  private failure: Error | undefined
  private ended = false

  /** @param update - one update to hold for the observer. */
  push(update: SpeechStreamUpdate): void {
    this.delivered.push({ kind: 'update', update })
    this.wake()
  }

  /**
   * End the sequence once, whichever of completion, failure, or cancellation reaches it first.
   * @param failure - the failure to raise after the buffered updates.
   */
  end(failure?: Error): void {
    if (this.ended) return
    this.ended = true
    this.failure = failure
    this.delivered.push({ kind: 'end' })
    this.wake()
  }

  /** @returns the failure the producing request ended with, if any. */
  endedWith(): Error | undefined {
    return this.failure
  }

  /**
   * Read the next delivery, waiting until one arrives.
   * @param signal - observer cancellation.
   * @returns the next update or the end of the sequence.
   */
  async next(signal: AbortSignal): Promise<Delivery> {
    while (true) {
      signal.throwIfAborted()
      const queued = this.delivered.shift()
      if (queued !== undefined) return queued
      const arrived = Promise.withResolvers<undefined>()
      this.waiting = () => { arrived.resolve(undefined) }
      const aborted = (): void => { arrived.resolve(undefined) }
      signal.addEventListener('abort', aborted, { once: true })
      await arrived.promise
      signal.removeEventListener('abort', aborted)
      this.waiting = undefined
    }
  }

  private wake(): void {
    this.waiting?.()
    this.waiting = undefined
  }
}

/** Incremental transcription over an OpenAI-compatible endpoint. */
export class OpenAiStreaming implements SpeechStreaming {
  readonly mode = 'incremental-output'

  /** @param options - the recognizer settings every session submits with. */
  constructor(private readonly options: OpenAiProviderOptions) {}

  /**
   * Open one session. The token is resolved here, so a deployment without one fails
   * at open rather than after the caller has recorded a meeting.
   * @param input - language the session recognizes.
   * @param signal - session cancellation; it aborts the eventual request.
   * @returns the open session, accepting audio until `close()`.
   */
  async open(input: SpeechStreamInput, signal: AbortSignal): Promise<SpeechStream> {
    signal.throwIfAborted()
    const apiKey = await this.options.resolveApiKey()
    if (apiKey === undefined || apiKey.length === 0) throw new Error(OPENAI_API_KEY_ERROR)
    return new OpenAiLiveSession(this.options, input.language, input.model ?? this.options.model, apiKey, signal)
  }
}

/** One incremental-output session: buffered audio in, progressive text out. */
class OpenAiLiveSession implements SpeechStream {
  private readonly owner = new AbortController()
  private readonly queue = new UpdateQueue()
  private readonly chunks: Uint8Array[] = []
  private bytes = 0
  private closed = false
  private cancelled = false
  private observing = false
  private running: Promise<void> | undefined

  /**
   * @param options - the recognizer settings this session submits with.
   * @param language - resolved language hint, or the detection sentinel.
   * @param model - resolved model this session runs.
   * @param apiKey - resolved bearer token.
   * @param caller - the caller's session lifetime, fused with this session's own cancellation.
   */
  constructor(
    private readonly options: OpenAiProviderOptions,
    private readonly language: string,
    private readonly model: string,
    private readonly apiKey: string,
    private readonly caller: AbortSignal,
  ) {}

  /**
   * Hold one chunk of the recording until the session submits it.
   * @param chunk - PCM16 samples without a container header.
   */
  async push(chunk: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('The streaming session no longer accepts audio')
    this.bytes += chunk.byteLength
    if (this.bytes > this.options.maxUploadBytes) {
      throw new Error(`Audio exceeds the ${this.options.maxUploadBytes}-byte upload limit`)
    }
    this.chunks.push(Uint8Array.from(chunk))
  }

  /**
   * Submit the recording and wait for the transcript the endpoint streams back.
   * @returns after every update was delivered and the sequence ended.
   * @throws {Error} The request failed, timed out, or the endpoint refused it.
   */
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.running = this.run()
    }
    await this.running
    const failure = this.queue.endedWith()
    if (failure !== undefined) throw failure
  }

  /** Abandon the session; buffered audio is dropped and no further update arrives. */
  async cancel(): Promise<void> {
    this.closed = true
    this.cancelled = true
    this.queue.end()
    this.owner.abort(new Error('The streaming session was cancelled'))
    await this.running
  }

  /**
   * Observe updates; they are held until an observer asks, so attaching before or
   * after `close()` delivers the same sequence.
   * @param observer - observer cancellation, which does not end the session.
   * @returns partials and closed segments, ending with one final transcript.
   */
  async *events(observer: AbortSignal): AsyncIterable<SpeechStreamUpdate> {
    if (this.observing) throw new Error('A streaming session serves one observer')
    this.observing = true
    const signal = AbortSignal.any([observer, this.owner.signal])
    try {
      while (true) {
        const delivery = await this.queue.next(signal)
        if (delivery.kind === 'end') break
        yield delivery.update
      }
    } catch (error) {
      if (this.cancelled) return
      throw error
    }
    const failure = this.queue.endedWith()
    if (failure !== undefined) throw failure
  }

  /** Submit the whole recording once and translate whatever ends it. */
  private async run(): Promise<void> {
    const signal = AbortSignal.any([this.caller, this.owner.signal])
    using callDeadline = deadline(signal, this.options.timeoutMs, OPENAI_TIMEOUT_CODE)
    const startedAt = performance.now()
    try {
      const response = await fetch(transcriptionUrl(this.options.baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: this.form(),
        signal: callDeadline.signal,
      })
      await this.deliver(response, callDeadline.signal, startedAt)
      this.queue.end()
    } catch (error) {
      // A deadline only notifies; the session translates its own reason here.
      const elapsed = timeoutOf(callDeadline.signal, OPENAI_TIMEOUT_CODE)
      const failure = elapsed === undefined ? failureOf(error) : new OpenAiTimeoutError(elapsed.timeoutMs)
      this.queue.end(this.cancelled ? undefined : failure)
    }
  }

  /**
   * Read the streamed events and hold each update for the observer.
   * @param response - the endpoint's answer.
   * @param signal - request deadline.
   * @param startedAt - when the request started, for the reported inference duration.
   */
  private async deliver(response: Response, signal: AbortSignal, startedAt: number): Promise<void> {
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`The transcription request failed with HTTP ${response.status}${failureDetail(body)}`)
    }
    if (response.body === null) throw new Error('The transcription response carried no body')
    const segments: SpeechSegment[] = []
    let accumulated = ''
    let complete: string | undefined
    for await (const payload of sseData(response.body, signal)) {
      const event = transcriptEvent(payload)
      if (event === undefined) continue
      if (event.type === 'transcript.text.delta') {
        accumulated += event.delta
        this.queue.push({ kind: 'partial', id: RUNNING_SPAN_ID, text: accumulated })
        continue
      }
      if (event.type === 'transcript.text.segment') {
        const segment: SpeechSegment = {
          text: event.text, speaker: event.speaker, start: event.start, end: event.end,
        }
        segments.push(segment)
        this.queue.push({ kind: 'segment', id: event.id, segment })
        continue
      }
      complete = event.text
    }
    this.queue.push({
      kind: 'final',
      transcript: {
        text: complete ?? accumulated,
        audioSeconds: this.bytes / PCM_BYTES_PER_SECOND,
        inferenceSeconds: (performance.now() - startedAt) / 1000,
        ...segments.length === 0 ? {} : { segments },
      },
    })
  }

  /**
   * Build the multipart body one submission carries.
   * @returns The form whose file part holds the buffered recording.
   */
  private form(): FormData {
    const form = new FormData()
    const recording = wavOf(this.chunks, this.bytes)
    form.append('file', new Blob([recording.buffer], { type: 'audio/wav' }), 'recording.wav')
    form.append('model', this.model)
    form.append('response_format', 'json')
    form.append('stream', 'true')
    if (this.language !== AUTO_LANGUAGE) form.append('language', this.language)
    return form
  }
}
