/**
 * The DashScope realtime recognizer: one duplex WebSocket session per recording,
 * PCM16 upload with bounded client buffering, and sentence assembly that keeps the
 * last text the service sent for each sentence.
 * @module @deepseek-ai/dsh-speech-to-text-dashscope/provider
 */

import { randomUUID } from 'node:crypto'
import type {
  SpeechInput,
  SpeechProvider,
  SpeechProviderId,
  SpeechProviderInfo,
  Transcript,
} from '@deepseek-ai/dsh-speech-to-text/types'
import { validateWave } from '@deepseek-ai/dsh-speech-to-text/wave'
import { deadline } from '@deepseek-ai/dsh-timeout'
import {
  authorizedUrl,
  DASHSCOPE_SAMPLE_RATE,
  finishTaskFrame,
  parseRecognitionEvent,
  RecognitionProtocolError,
  runTaskFrame,
  type RecognitionEvent,
} from './protocol.ts'

/** Failure code attached when a recognition session outlives its configured deadline. */
export const DASHSCOPE_TIMEOUT_CODE = 'DASHSCOPE_RECOGNITION_TIMEOUT'

/** Canonical WAV header length the upload skips before the first PCM sample. */
const WAV_HEADER_BYTES = 44

/** PCM16 bytes one second of 16 kHz mono audio occupies. */
const PCM_BYTES_PER_SECOND = DASHSCOPE_SAMPLE_RATE * 2

/** Upload granularity: one second of PCM per WebSocket message. */
const UPLOAD_CHUNK_BYTES = PCM_BYTES_PER_SECOND

/** Audio the client may hold unsent before it waits for the socket to flush. */
const MAX_BUFFERED_BYTES = 8 * UPLOAD_CHUNK_BYTES

/** Deployment-selected DashScope recognizer settings. */
export interface DashScopeProviderOptions {
  /** Registration identity this provider occupies in the registry. */
  readonly id: SpeechProviderId
  /** Display name shown by speech surfaces. */
  readonly name: string
  /** Duplex recognition endpoint. */
  readonly url: string
  /** Realtime recognition model name. */
  readonly model: string
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

/** Ordered service frames with the faults and closure that end the sequence. */
type Delivery =
  | { readonly kind: 'event'; readonly event: RecognitionEvent }
  | { readonly kind: 'failure'; readonly error: Error }
  | { readonly kind: 'closed' }

/** Buffers service frames until the session asks for the next one. */
class FrameQueue {
  private readonly delivered: Delivery[] = []
  private waiting: (() => void) | undefined

  /** @param delivery - one decoded frame, transport failure, or socket closure. */
  push(delivery: Delivery): void {
    this.delivered.push(delivery)
    this.waiting?.()
  }

  /**
   * Read the next delivery, waiting until one arrives.
   * @param signal - cancellation covering the wait and the following work.
   * @returns the next delivery in arrival order.
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
}

/** Wait until the socket has flushed enough of its buffered audio to accept more. */
async function waitForDrain(socket: WebSocket, signal: AbortSignal): Promise<void> {
  while (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    signal.throwIfAborted()
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
  }
  signal.throwIfAborted()
}

/** The DashScope realtime recognizer registered into `ctx.speechToText`. */
export class DashScopeSpeechProvider implements SpeechProvider {
  readonly info: SpeechProviderInfo

  /**
   * @param options - deployment-selected endpoint, model, limits, and key resolution.
   */
  constructor(private readonly options: DashScopeProviderOptions) {
    this.info = {
      id: options.id,
      name: options.name,
      location: 'cloud',
      languages: options.languages,
    }
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
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('DashScope recognition requires an API key: set the plugin apiKey or its credential reference')
    }
    signal.throwIfAborted()
    using callDeadline = deadline(signal, this.options.timeoutMs, DASHSCOPE_TIMEOUT_CODE)
    const startedAt = performance.now()
    const sentences = await this.recognize(input.audio, apiKey, callDeadline.signal)
    return {
      text: sentences.join('\n'),
      audioSeconds,
      inferenceSeconds: (performance.now() - startedAt) / 1000,
    }
  }

  /**
   * Run one session to completion, collecting closed sentences.
   * @param audio - complete canonical WAV bytes.
   * @param apiKey - resolved bearer token.
   * @param signal - session deadline; its firing closes the socket.
   * @returns closed sentence texts in service order.
   */
  private async recognize(audio: Uint8Array, apiKey: string, signal: AbortSignal): Promise<string[]> {
    const taskId = randomUUID()
    const frames = new FrameQueue()
    const socket = new WebSocket(authorizedUrl(this.options.url, apiKey))
    const opened = Promise.withResolvers<undefined>()
    let connectionSettled = false
    const settleConnection = (error?: Error): void => {
      if (connectionSettled) return
      connectionSettled = true
      if (error === undefined) opened.resolve(undefined)
      else opened.reject(error)
    }
    // Cancellation reaches the pending wait by failing the connection it waits on.
    const cancel = (): void => { socket.close() }
    signal.addEventListener('abort', cancel, { once: true })
    socket.addEventListener('open', () => { settleConnection() })
    socket.addEventListener('message', (message) => {
      try {
        const event = parseRecognitionEvent(String(message.data))
        frames.push({ kind: 'event', event })
      } catch (error) {
        frames.push({ kind: 'failure', error: error instanceof Error ? error : new Error(String(error)) })
      }
    })
    socket.addEventListener('error', () => {
      const error = new Error('DashScope recognition connection failed')
      settleConnection(error)
      frames.push({ kind: 'failure', error })
    })
    socket.addEventListener('close', () => {
      const error = new Error('DashScope recognition connection closed early')
      settleConnection(error)
      frames.push({ kind: 'closed' })
    })
    try {
      await this.open(opened.promise, signal)
      socket.send(runTaskFrame(taskId, this.options.model, this.recognitionParameters()))
      await this.awaitStart(frames, signal)
      await this.upload(socket, audio, signal)
      socket.send(finishTaskFrame(taskId))
      using drainDeadline = deadline(signal, this.options.drainTimeoutMs, DASHSCOPE_TIMEOUT_CODE)
      return await this.collect(frames, drainDeadline.signal)
    } finally {
      signal.removeEventListener('abort', cancel)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
    }
  }

  /** Recognition parameters every session declares. */
  private recognitionParameters(): Record<string, unknown> {
    return { speaker_diarization_enabled: this.options.speakerDiarization }
  }

  /**
   * Await the connection outcome. Cancellation has already failed the connection, so
   * the deadline reason takes precedence over the resulting transport error.
   * @param pending - the connection promise settled by the socket's lifecycle events.
   * @param signal - session deadline.
   * @throws {Error} The connection failed before the task started.
   */
  private async open(pending: Promise<undefined>, signal: AbortSignal): Promise<void> {
    try {
      await pending
    } catch (error) {
      signal.throwIfAborted()
      throw new Error(`The recognition connection failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Wait until the service accepts audio for this task.
   * @param frames - decoded frames for this session.
   * @param signal - session deadline.
   */
  private async awaitStart(frames: FrameQueue, signal: AbortSignal): Promise<void> {
    while (true) {
      const event = await this.nextEvent(frames, signal, 'the recognition task to start')
      if (event.kind === 'started') return
      if (event.kind === 'finished') {
        throw new RecognitionProtocolError('Recognition finished before the task started')
      }
    }
  }

  /**
   * Send the recording's PCM samples, waiting whenever the socket buffer is full.
   * @param socket - the open session socket.
   * @param audio - complete canonical WAV bytes, including the header this step skips.
   * @param signal - session deadline.
   */
  private async upload(socket: WebSocket, audio: Uint8Array, signal: AbortSignal): Promise<void> {
    const pcm = audio.subarray(WAV_HEADER_BYTES)
    for (let offset = 0; offset < pcm.length; offset += UPLOAD_CHUNK_BYTES) {
      signal.throwIfAborted()
      await waitForDrain(socket, signal)
      const size = Math.min(UPLOAD_CHUNK_BYTES, pcm.length - offset)
      const chunk = new ArrayBuffer(size)
      new Uint8Array(chunk).set(pcm.subarray(offset, offset + size))
      socket.send(chunk)
    }
  }

  /**
   * Accumulate sentence results until the service reports the task finished. A later
   * frame for an unfinished sentence replaces the earlier text of the same sentence.
   * @param frames - decoded frames for this session.
   * @param signal - drain deadline.
   * @returns closed sentence texts in service order.
   */
  private async collect(frames: FrameQueue, signal: AbortSignal): Promise<string[]> {
    const closed: string[] = []
    let pending = ''
    while (true) {
      const event = await this.nextEvent(frames, signal, 'the final recognition results')
      if (event.kind === 'finished') return closed
      if (event.kind !== 'sentence') continue
      pending = event.sentence.text
      if (!event.sentence.final) continue
      closed.push(pending)
      pending = ''
    }
  }

  /**
   * Read the next decoded frame, turning transport faults and early closure into errors.
   * @param frames - decoded frames for this session.
   * @param signal - active phase deadline.
   * @param described - the awaited step, named in the failure message.
   * @returns the next recognition event.
   */
  private async nextEvent(frames: FrameQueue, signal: AbortSignal, described: string): Promise<RecognitionEvent> {
    const delivery = await frames.next(signal)
    if (delivery.kind === 'event') {
      if (delivery.event.kind === 'failed') throw new Error(`DashScope recognition failed: ${delivery.event.message}`)
      return delivery.event
    }
    signal.throwIfAborted()
    if (delivery.kind === 'failure') throw delivery.error
    throw new Error(`Waiting for ${described} failed: the connection closed`)
  }
}
