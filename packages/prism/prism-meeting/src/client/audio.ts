/**
 * Browser audio capture and normalization. Speech providers validate one
 * container exactly — canonical 16 kHz mono PCM16 WAV with a 44-byte header —
 * so live capture samples at that rate directly and imported files are decoded
 * and re-encoded before upload.
 * @module @prism/prism-meeting/src/client/audio
 */

/** Sample rate the speech providers read. */
export const TARGET_SAMPLE_RATE = 16_000

/** Longest recording this page sends; longer audio is truncated before upload. */
export const MAX_AUDIO_SECONDS = 3_600

/** Seconds of live audio one intermediate transcript covers. */
export const LIVE_SLICE_SECONDS = 8

/** One recording in progress, sampled at the provider rate. */
export interface LiveCapture {
  /**
   * Read every sample captured so far.
   * @returns the captured mono samples at {@link TARGET_SAMPLE_RATE}.
   */
  snapshot(): Float32Array
  /** Stop appending captured audio; the microphone stays open. */
  pause(): void
  /** Continue appending captured audio after {@link pause}. */
  resume(): void
  /** Stop the microphone and resolve the complete recording. */
  stop(): Promise<Float32Array>
}

/**
 * Encode mono 16 kHz samples as the canonical PCM16 WAV container.
 * @param samples - mono samples in the `-1..1` range.
 * @returns the complete WAV file, 44-byte header included.
 */
export function encodeWav(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, TARGET_SAMPLE_RATE, true)
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (const [index, sample] of samples.entries()) {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(44 + index * 2, Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff)), true)
  }
  return bytes
}

/**
 * Bundle mono samples as the WAV blob one request carries.
 * @param samples - mono samples at {@link TARGET_SAMPLE_RATE}.
 * @returns the canonical WAV blob.
 */
export function wavBlob(samples: Float32Array): Blob {
  return new Blob([encodeWav(samples)], { type: 'audio/wav' })
}

/**
 * Decode one browser-readable audio file and re-encode it for transcription.
 * @param audio - picked audio in any container the browser decodes.
 * @param maxSeconds - longest audio to keep; the rest is truncated.
 * @param createContext - decoding-context factory, injectable for tests.
 * @param createRenderer - resampling off-line context factory, injectable for tests.
 * @returns the canonical WAV blob.
 */
export async function toWavBlob(
  audio: Blob,
  maxSeconds: number = MAX_AUDIO_SECONDS,
  createContext: () => AudioContext = () => new AudioContext(),
  createRenderer: (channels: number, frames: number, sampleRate: number) => OfflineAudioContext =
    (channels, frames, sampleRate) => new OfflineAudioContext(channels, frames, sampleRate),
): Promise<Blob> {
  const context = createContext()
  try {
    const decoded = await context.decodeAudioData(await audio.arrayBuffer())
    const seconds = Math.min(decoded.duration, maxSeconds)
    // Off-line rendering resamples with the browser's own filter instead of a
    // linear approximation, which the speech providers read more accurately.
    const renderer = createRenderer(1, Math.max(1, Math.floor(seconds * TARGET_SAMPLE_RATE)), TARGET_SAMPLE_RATE)
    const source = renderer.createBufferSource()
    source.buffer = decoded
    source.connect(renderer.destination)
    source.start()
    const rendered = await renderer.startRendering()
    return wavBlob(rendered.getChannelData(0))
  } finally {
    void context.close()
  }
}

/** One open microphone whose captured blocks reach the caller. */
export interface CaptureSession {
  /** Register the listener that receives each captured block. */
  readonly onSamples: (listener: (samples: Float32Array) => void) => void
  /** The microphone tracks to release. */
  readonly tracks: readonly { stop(): void }[]
  /** Release the audio graph; the caller stops the tracks. */
  readonly release: () => void
}

/** Microphone and audio-graph access, injectable so capture is testable. */
export interface CaptureRuntime {
  /** Open one microphone at the provider sample rate. */
  readonly open: () => Promise<CaptureSession>
}

/** The browser's own capture runtime: a script processor fed by the microphone. */
const browserCapture: CaptureRuntime = {
  async open(): Promise<CaptureSession> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    const source = context.createMediaStreamSource(stream)
    // A script processor is the one capture node the shipped Chromium runtime
    // provides without loading a worklet module the bundled plugin cannot host.
    // oxlint-disable-next-line typescript/no-deprecated -- see the capture-node note above.
    const processor = context.createScriptProcessor(4096, 1, 1)
    source.connect(processor)
    // It only runs while it reaches the destination, and copies nothing into
    // its output, so the microphone is never played back.
    processor.connect(context.destination)
    return {
      tracks: stream.getTracks(),
      onSamples(listener) {
        // oxlint-disable-next-line typescript/no-deprecated -- see the capture-node note above.
        processor.onaudioprocess = (event) => {
          // oxlint-disable-next-line typescript/no-deprecated -- see the capture-node note above.
          listener(new Float32Array(event.inputBuffer.getChannelData(0)))
        }
      },
      release() {
        // oxlint-disable-next-line typescript/no-deprecated -- see the capture-node note above.
        processor.onaudioprocess = null
        processor.disconnect()
        source.disconnect()
        void context.close()
      },
    }
  },
}

/**
 * Start one microphone capture at the provider sample rate, so the caller can
 * read the recording so far and transcribe it while it is still running.
 * @param runtime - capture implementation, injectable for tests.
 * @returns the running capture; `stop` releases the microphone.
 */
export async function startCapture(runtime: CaptureRuntime = browserCapture): Promise<LiveCapture> {
  const session = await runtime.open()
  const chunks: Float32Array[] = []
  let paused = false
  session.onSamples((samples) => {
    if (paused) return
    chunks.push(samples)
  })
  return {
    snapshot(): Float32Array {
      return concatenate(chunks)
    },
    pause(): void {
      paused = true
    },
    resume(): void {
      paused = false
    },
    async stop(): Promise<Float32Array> {
      const samples = concatenate(chunks)
      session.release()
      for (const track of session.tracks) track.stop()
      return await Promise.resolve(samples)
    },
  }
}

/**
 * Concatenate captured blocks into one sample array.
 * @param chunks - captured blocks in arrival order.
 * @returns their samples in one array.
 */
function concatenate(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const joined = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return joined
}
