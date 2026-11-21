/**
 * The duplex session both DashScope entry points share: one WebSocket, the frames
 * decoded from it, and the ordered sends the batch transcription and the live
 * stream drive at different rates.
 * @module @deepseek-ai/dsh-experimental-speech-to-text-dashscope/session
 */

import { randomUUID } from 'node:crypto'
import {
  authorizedUrl,
  DASHSCOPE_SAMPLE_RATE,
  finishTaskFrame,
  parseRecognitionEvent,
  RecognitionProtocolError,
  runTaskFrame,
  type RecognitionEvent,
} from './protocol.ts'

/** Canonical WAV header length the batch transcription skips before the first PCM sample. */
export const WAV_HEADER_BYTES = 44

/** PCM16 bytes one second of the session's audio occupies. */
export const PCM_BYTES_PER_SECOND = DASHSCOPE_SAMPLE_RATE * 2

/** Upload granularity: one second of PCM per WebSocket message. */
export const UPLOAD_CHUNK_BYTES = PCM_BYTES_PER_SECOND

/** Audio the client may hold unsent before it waits for the socket to flush. */
export const MAX_BUFFERED_BYTES = 8 * UPLOAD_CHUNK_BYTES

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

/**
 * Wait until the socket has flushed enough of its buffered audio to accept more.
 * @param socket - the transport whose queued bytes bound the next send.
 * @param signal - session cancellation; it stops the wait.
 */
export async function waitForDrain(socket: { readonly bufferedAmount: number }, signal: AbortSignal): Promise<void> {
  while (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    signal.throwIfAborted()
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
  }
  signal.throwIfAborted()
}

/** Close a socket that may still be connecting. */
function closeSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
}

/** Deployment-selected facts one session connects and starts with. */
export interface RecognitionSessionOptions {
  /** Duplex recognition endpoint. */
  readonly url: string
  /** Realtime recognition model name. */
  readonly model: string
  /** Extra recognition parameters merged over the PCM16 defaults. */
  readonly parameters: Record<string, unknown>
}

/**
 * One started DashScope task. Audio goes out through {@link RecognitionSession.push},
 * decoded events come back through {@link RecognitionSession.events}, and
 * {@link RecognitionSession.close} releases the socket.
 */
export class RecognitionSession {
  private constructor(
    private readonly socket: WebSocket,
    private readonly frames: FrameQueue,
    private readonly taskId: string,
    private readonly detach: () => void,
  ) {}

  /**
   * Connect, send `run-task`, and wait until the service accepts audio.
   * @param options - endpoint, model, and recognition parameters.
   * @param apiKey - resolved bearer token.
   * @param signal - session cancellation; it closes the socket.
   * @returns the started session.
   * @throws {Error} The connection failed or the task never started.
   */
  static async open(
    options: RecognitionSessionOptions,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<RecognitionSession> {
    const taskId = randomUUID()
    const frames = new FrameQueue()
    const socket = new WebSocket(authorizedUrl(options.url, apiKey))
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
    const detach = (): void => { signal.removeEventListener('abort', cancel) }
    socket.addEventListener('open', () => { settleConnection() })
    socket.addEventListener('message', (message) => {
      try {
        frames.push({ kind: 'event', event: parseRecognitionEvent(String(message.data)) })
      } catch (error) {
        /* v8 ignore next -- parseRecognitionEvent raises RecognitionProtocolError only */
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
      try {
        await opened.promise
      } catch (error) {
        // Cancellation has already failed the connection, so the deadline reason
        // takes precedence over the resulting transport error.
        signal.throwIfAborted()
        /* v8 ignore next -- this promise rejects only with the Error the listeners above construct */
        throw new Error(`The recognition connection failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      socket.send(runTaskFrame(taskId, options.model, options.parameters))
      const session = new RecognitionSession(socket, frames, taskId, detach)
      await session.awaitStart(signal)
      return session
    } catch (error) {
      detach()
      closeSocket(socket)
      throw error
    }
  }

  /**
   * Send one chunk of PCM samples, waiting for the socket to flush when it is full.
   * @param chunk - PCM16 samples at the session's declared sample rate.
   * @param signal - session cancellation.
   */
  async push(chunk: Uint8Array, signal: AbortSignal): Promise<void> {
    await waitForDrain(this.socket, signal)
    this.socket.send(new Uint8Array(chunk))
  }

  /**
   * Declare that no further audio follows; the service answers with its remaining
   * results before `task-finished`.
   */
  finish(): void {
    if (this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(finishTaskFrame(this.taskId))
  }

  /**
   * Read decoded events until the service reports the task finished.
   * @param signal - active phase deadline.
   * @returns every event in service order, ending with `finished`.
   * @throws {Error} A transport fault, early closure, or service failure.
   */
  async *events(signal: AbortSignal): AsyncIterable<RecognitionEvent> {
    while (true) {
      const event = await this.nextEvent(signal, 'the final recognition results')
      yield event
      if (event.kind === 'finished') return
    }
  }

  /** Release the socket and stop observing the caller's signal. */
  close(): void {
    this.detach()
    closeSocket(this.socket)
  }

  /**
   * Read the next decoded event, turning transport faults and early closure into errors.
   * @param signal - active phase deadline.
   * @param described - the awaited step, named in the failure message.
   * @returns the next recognition event.
   */
  private async nextEvent(signal: AbortSignal, described: string): Promise<RecognitionEvent> {
    const delivery = await this.frames.next(signal)
    if (delivery.kind === 'event') {
      if (delivery.event.kind === 'failed') throw new Error(`DashScope recognition failed: ${delivery.event.message}`)
      return delivery.event
    }
    signal.throwIfAborted()
    if (delivery.kind === 'failure') throw delivery.error
    throw new Error(`Waiting for ${described} failed: the connection closed`)
  }

  /**
   * Wait until the service accepts audio for this task.
   * @param signal - session deadline.
   */
  private async awaitStart(signal: AbortSignal): Promise<void> {
    let started = false
    while (!started) {
      const event = await this.nextEvent(signal, 'the recognition task to start')
      if (event.kind === 'finished') {
        throw new RecognitionProtocolError('Recognition finished before the task started')
      }
      started = event.kind === 'started'
    }
  }
}
