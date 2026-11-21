/**
 * The DashScope live recognizer: it holds one duplex session open while the caller
 * pushes audio, reports each sentence as the service firms it up, and settles with
 * the speaker-attributed transcript.
 * @module @deepseek-ai/dsh-experimental-speech-to-text-dashscope/stream
 */

import type {
  SpeechSegment,
  SpeechStream,
  SpeechStreamInput,
  SpeechStreamUpdate,
  SpeechStreaming,
  Transcript,
} from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { PCM_BYTES_PER_SECOND, RecognitionSession, type RecognitionSessionOptions } from './session.ts'

/** Message every entry point uses when no usable key reached the session. */
export const DASHSCOPE_API_KEY_ERROR =
  'DashScope recognition requires an API key: set the plugin apiKey or its credential reference'

/** Live recognition over the DashScope duplex endpoint. */
export class DashScopeStreaming implements SpeechStreaming {
  readonly mode = 'duplex'

  /**
   * @param sessionFor - the facts one session connects and starts with, resolved per selection.
   * @param resolveApiKey - read the bearer token; `undefined` fails the call before connecting.
   */
  constructor(
    private readonly sessionFor: (language: string, model: string | undefined) => RecognitionSessionOptions,
    private readonly resolveApiKey: () => Promise<string | undefined>,
  ) {}

  /**
   * Open one live session.
   * @param input - language and model the session recognizes.
   * @param signal - session cancellation; it closes the socket.
   * @returns the open session.
   */
  async open(input: SpeechStreamInput, signal: AbortSignal): Promise<SpeechStream> {
    signal.throwIfAborted()
    const apiKey = await this.resolveApiKey()
    if (apiKey === undefined || apiKey.length === 0) throw new Error(DASHSCOPE_API_KEY_ERROR)
    const session = await RecognitionSession.open(this.sessionFor(input.language, input.model), apiKey, signal)
    return new DashScopeLiveSession(session, signal)
  }
}

/** One live session: pushed PCM goes out, attributed updates come back. */
class DashScopeLiveSession implements SpeechStream {
  private readonly owner = new AbortController()
  private readonly session: RecognitionSession
  private readonly signal: AbortSignal
  private readonly closedSegments: SpeechSegment[] = []
  private readonly settled = Promise.withResolvers<void>()
  private startedAt = 0
  private bytes = 0
  private pumping = false
  private closed = false
  private cancelled = false
  private failure: Error | undefined

  /**
   * @param session - the started duplex session.
   * @param caller - the caller's session lifetime, fused with this session's own cancellation.
   */
  constructor(session: RecognitionSession, caller: AbortSignal) {
    this.session = session
    this.signal = AbortSignal.any([caller, this.owner.signal])
  }

  /**
   * Send one chunk of PCM samples.
   * @param chunk - PCM16 samples without a container header.
   */
  async push(chunk: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('The live session no longer accepts audio')
    this.bytes += chunk.byteLength
    await this.session.push(chunk, this.signal)
  }

  /**
   * Declare that no further audio follows and wait for the service's remaining results.
   * A session nobody observed settles as soon as it is released.
   */
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.session.finish()
    }
    if (this.pumping) await this.settled.promise
    this.session.close()
    if (this.failure !== undefined) throw this.failure
  }

  /** Abandon the session; observed updates stop without a final one. */
  async cancel(): Promise<void> {
    this.closed = true
    this.cancelled = true
    this.session.close()
    this.owner.abort(new Error('The live session was cancelled'))
    if (!this.pumping) this.settled.resolve()
    await this.settled.promise
  }

  /**
   * Observe updates while the caller pushes audio.
   * @param observer - observer cancellation, which does not end the session.
   * @returns partials and closed segments in service order, ending with one final update.
   */
  async *events(observer: AbortSignal): AsyncIterable<SpeechStreamUpdate> {
    if (this.pumping) throw new Error('A live session serves one observer')
    this.pumping = true
    this.startedAt = performance.now()
    let open = 's0'
    let sequence = 0
    try {
      for await (const event of this.session.events(this.ownerSignal(observer))) {
        if (event.kind === 'sentence') {
          const { text, speaker, final } = event.sentence
          const attribution = speaker === undefined ? {} : { speaker }
          if (!final) {
            yield { kind: 'partial', id: open, text, ...attribution }
            continue
          }
          const segment: SpeechSegment = { text, ...attribution }
          this.closedSegments.push(segment)
          yield { kind: 'segment', id: open, segment }
          open = `s${++sequence}`
          continue
        }
        if (event.kind === 'finished') {
          yield { kind: 'final', transcript: this.transcript() }
          return
        }
      }
    } catch (error) {
      if (this.cancelled) return
      /* v8 ignore next -- every failure the recognition session raises is an Error */
      this.failure = error instanceof Error ? error : new Error(String(error))
      throw this.failure
    } finally {
      this.session.close()
      this.settled.resolve()
    }
  }

  /** Fuse one observer's lifetime with this session's own cancellation. */
  private ownerSignal(observer: AbortSignal): AbortSignal {
    return AbortSignal.any([observer, this.owner.signal])
  }

  /** The transcript every closed segment so far composes. */
  private transcript(): Transcript {
    return {
      text: this.closedSegments.map(segment => segment.text).join('\n'),
      audioSeconds: this.bytes / PCM_BYTES_PER_SECOND,
      inferenceSeconds: (performance.now() - this.startedAt) / 1000,
      ...this.closedSegments.length === 0 ? {} : { segments: [...this.closedSegments] },
    }
  }
}
