/** Browser audio normalization: canonical WAV encoding, decoding, and live capture. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  encodeWav, startCapture, TARGET_SAMPLE_RATE, toWavBlob, wavBlob, type CaptureRuntime,
} from '../src/client/audio.ts'

/** Read the ASCII field of one WAV header. */
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

/** One decoded buffer double; the test supplies its samples. */
class FakeDecoded {
  constructor(
    readonly duration: number,
    private readonly samples: Float32Array,
  ) {}

  getChannelData(): Float32Array {
    return this.samples
  }
}

/** Decode-context double recording construction and closure. */
class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = []
  static decoded = new FakeDecoded(1, new Float32Array(TARGET_SAMPLE_RATE))
  static readonly closes: number[] = []

  constructor() {
    FakeAudioContext.instances.push(this)
  }

  decodeAudioData(): Promise<FakeDecoded> {
    return Promise.resolve(FakeAudioContext.decoded)
  }

  close(): Promise<void> {
    FakeAudioContext.closes.push(1)
    return Promise.resolve()
  }
}

/** Off-line render-context double: records the render request and answers one channel. */
class FakeOfflineAudioContext {
  static readonly rendered: { channels: number; frames: number; sampleRate: number }[] = []
  static samples = new Float32Array(4)

  constructor(
    private readonly channels: number,
    private readonly frames: number,
    private readonly sampleRate: number,
  ) {}

  readonly destination = {}

  createBufferSource(): { buffer: unknown; connect: () => void; start: () => void } {
    return { buffer: undefined, connect: () => {}, start: () => {} }
  }

  startRendering(): Promise<{ getChannelData: () => Float32Array }> {
    FakeOfflineAudioContext.rendered.push({
      channels: this.channels,
      frames: this.frames,
      sampleRate: this.sampleRate,
    })
    return Promise.resolve({ getChannelData: () => FakeOfflineAudioContext.samples })
  }
}

/** One capture-runtime double the test drives directly. */
interface CaptureStub {
  readonly runtime: CaptureRuntime
  readonly emit: (samples: Float32Array) => void
  readonly released: () => boolean
  readonly tracks: { stop: () => void }[]
}

/** Build one capture runtime that hands samples to whoever is listening. */
function captureStub(): CaptureStub {
  let listener: ((samples: Float32Array) => void) | undefined
  let released = false
  const tracks = [{ stop: vi.fn() }]
  return {
    runtime: {
      open: () => Promise.resolve({
        tracks,
        onSamples(next) { listener = next },
        release() { released = true },
      }),
    },
    emit: (samples) => { listener?.(samples) },
    released: () => released,
    tracks,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeAudioContext.instances.length = 0
  FakeAudioContext.closes.length = 0
  FakeOfflineAudioContext.rendered.length = 0
})

describe('encodeWav', () => {
  it('writes the canonical 16 kHz mono PCM16 header', () => {
    const bytes = encodeWav(new Float32Array([0, 0]))
    expect(bytes).toHaveLength(48)
    const view = new DataView(bytes.buffer)
    expect(ascii(bytes, 0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(bytes.length - 8)
    expect(ascii(bytes, 8, 4)).toBe('WAVE')
    expect(ascii(bytes, 12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(TARGET_SAMPLE_RATE)
    expect(view.getUint32(28, true)).toBe(TARGET_SAMPLE_RATE * 2)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(bytes, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(bytes.length - 44)
  })

  it('clamps and rounds each sample to signed 16-bit', () => {
    const view = new DataView(encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5])).buffer)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(32767)
    expect(view.getInt16(48, true)).toBe(-32768)
    expect(view.getInt16(50, true)).toBe(32767)
    expect(view.getInt16(52, true)).toBe(-32768)
    expect(view.getInt16(54, true)).toBe(16384)
  })

  it('bundles samples as a WAV blob', () => {
    expect(wavBlob(new Float32Array(2)).type).toBe('audio/wav')
  })
})

describe('toWavBlob', () => {
  it('decodes and re-encodes the recording at the provider sample rate', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
    FakeAudioContext.decoded = new FakeDecoded(2, new Float32Array(TARGET_SAMPLE_RATE * 2))
    FakeOfflineAudioContext.samples = new Float32Array([0, 0])

    const wav = await toWavBlob(new Blob([new Uint8Array(8)], { type: 'audio/webm' }))

    expect(wav.type).toBe('audio/wav')
    expect(await wav.arrayBuffer()).toHaveProperty('byteLength', 44 + 4)
    expect(FakeOfflineAudioContext.rendered).toEqual([
      { channels: 1, frames: TARGET_SAMPLE_RATE * 2, sampleRate: TARGET_SAMPLE_RATE },
    ])
    expect(FakeAudioContext.closes).toHaveLength(1)
  })

  it('truncates audio longer than the requested bound', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
    FakeAudioContext.decoded = new FakeDecoded(30, new Float32Array(TARGET_SAMPLE_RATE * 30))

    await toWavBlob(new Blob([new Uint8Array(8)]), 2)

    expect(FakeOfflineAudioContext.rendered[0]).toEqual({
      channels: 1, frames: TARGET_SAMPLE_RATE * 2, sampleRate: TARGET_SAMPLE_RATE,
    })
  })

  it('renders at least one frame for an empty recording', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
    FakeAudioContext.decoded = new FakeDecoded(0, new Float32Array(0))
    FakeOfflineAudioContext.samples = new Float32Array(1)

    const wav = await toWavBlob(new Blob([new Uint8Array(2)]))

    expect(FakeOfflineAudioContext.rendered[0]?.frames).toBe(1)
    expect(await wav.arrayBuffer()).toHaveProperty('byteLength', 46)
  })
})

describe('startCapture', () => {
  it('collects captured blocks and releases the microphone on stop', async () => {
    const stub = captureStub()
    const capture = await startCapture(stub.runtime)
    stub.emit(new Float32Array([1, 2]))
    stub.emit(new Float32Array([3]))

    expect(capture.snapshot()).toEqual(new Float32Array([1, 2, 3]))
    expect(await capture.stop()).toEqual(new Float32Array([1, 2, 3]))
    expect(stub.released()).toBe(true)
    expect(stub.tracks[0]?.stop).toHaveBeenCalledTimes(1)
  })

  it('drops the audio captured while paused and keeps it after resuming', async () => {
    const stub = captureStub()
    const capture = await startCapture(stub.runtime)
    stub.emit(new Float32Array([1]))
    capture.pause()
    stub.emit(new Float32Array([2]))
    expect(capture.snapshot()).toEqual(new Float32Array([1]))

    capture.resume()
    stub.emit(new Float32Array([3]))
    expect(await capture.stop()).toEqual(new Float32Array([1, 3]))
  })

  it('propagates a refused microphone request', async () => {
    await expect(startCapture({ open: () => Promise.reject(new Error('permission denied')) }))
      .rejects.toThrow('permission denied')
  })
})
