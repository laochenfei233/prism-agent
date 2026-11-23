/** Quiet-boundary chunking and merged transcripts for capped recognizers. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { chunkWave, transcribeCapped } from '../src/chunk.ts'
import SpeechToText from '../src/index.ts'
import type { SpeechProviderId, SpeechSpec, Transcript } from '../src/types.ts'
import { parseWave, sliceWave } from '../src/wave.ts'

const signal = new AbortController().signal

/** Build one canonical 16 kHz mono PCM16 WAV carrying the given samples. */
function wave(samples: readonly number[]): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const header = Buffer.from(out.buffer, 0, 44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + samples.length * 2, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(samples.length * 2, 40)
  const view = new DataView(out.buffer)
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true))
  return out
}

/** PCM samples of one canonical WAV, excluding its header. */
function samples(audio: Uint8Array): number[] {
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  const out: number[] = []
  for (let offset = 44; offset < audio.byteLength; offset += 2) out.push(view.getInt16(offset, true))
  return out
}

describe('wave slicing', () => {
  it('rebuilds canonical bytes for any sample range', () => {
    const full = wave([1, 2, 3, 4, 5, 6, 7, 8])
    const piece = sliceWave(full, 2, 6)
    expect(parseWave(piece)).toBe(4 / 16000)
    expect(samples(piece)).toEqual([3, 4, 5, 6])
  })

  it('clips ranges beyond the recording instead of failing', () => {
    const full = wave([1, 2, 3, 4])
    expect(samples(sliceWave(full, 0, 99))).toEqual([1, 2, 3, 4])
    expect(samples(sliceWave(full, -5, 2))).toEqual([1, 2])
  })
})

describe('chunkWave', () => {
  it('yields the original bytes when the recording fits the cap', () => {
    const audio = wave(new Array(16000).fill(100))
    expect([...chunkWave(audio, 2)]).toEqual([{ audio, startSeconds: 0 }])
  })

  it('splits at cap boundaries when every window carries the same energy', () => {
    const audio = wave(new Array(5 * 16000).fill(1000))
    const chunks = [...chunkWave(audio, 2)]
    expect(chunks.map(chunk => chunk.startSeconds)).toEqual([0, 2, 4])
    expect(chunks.map(chunk => samples(chunk.audio).length)).toEqual([32000, 32000, 16000])
    expect(chunks.flatMap(chunk => samples(chunk.audio))).toEqual(samples(audio))
  })

  it('cuts inside a quiet valley before the cap boundary', () => {
    const recording = [
      ...new Array(19200).fill(8000), // 1.2 s of loud tone
      ...new Array(9600).fill(0), // 0.6 s of silence
      ...new Array(4 * 16000 - 19200 - 9600).fill(8000),
    ]
    const audio = wave(recording)
    const chunks = [...chunkWave(audio, 2)]
    // The valley pulls the first cut to 1.2 s; the remaining 2.8 s needs one more cap-sized piece.
    expect(chunks.map(chunk => chunk.startSeconds)).toEqual([0, 1.2, 3.2])
    expect(chunks.map(chunk => samples(chunk.audio).length)).toEqual([19200, 32000, 12800])
    expect(chunks.flatMap(chunk => samples(chunk.audio))).toEqual(recording)
    for (const chunk of chunks) expect(samples(chunk.audio).length).toBeLessThanOrEqual(32000)
  })
})

describe('transcribeCapped', () => {
  it('passes an uncapped recording through as one provider call', async () => {
    const audio = wave(new Array(16000).fill(1))
    const result: Transcript = { text: 'hi', audioSeconds: 1, inferenceSeconds: 2 }
    const calls: Uint8Array[] = []
    const spec: SpeechSpec = {
      provider: {
        info: { id: 'free' as SpeechProviderId, name: 'free', location: 'cloud', languages: ['auto'] },
        transcribe: async input => { calls.push(input.audio); return result },
      },
      audio, language: 'auto',
    }
    await expect(transcribeCapped(spec, signal)).resolves.toBe(result)
    expect(calls.map(bytes => bytes.length)).toEqual([audio.length])
  })

  it('splits, orders, and merges a recording beyond the declared cap', async () => {
    const audio = wave(new Array(3 * 16000).fill(1))
    const results: Transcript[] = [
      { text: 'first', audioSeconds: 2, inferenceSeconds: 1, segments: [{ text: 'first', start: 0.5, end: 2 }] },
      { text: 'second', audioSeconds: 1, inferenceSeconds: 0.5 },
    ]
    let call = 0
    const sizes: number[] = []
    const spec: SpeechSpec = {
      provider: {
        info: { id: 'capped' as SpeechProviderId, name: 'capped', location: 'cloud', languages: ['auto'], maxAudioSeconds: 2 },
        transcribe: async input => { sizes.push(input.audio.byteLength); return results[call++]! },
      },
      audio, language: 'zh', model: 'm',
    }
    const merged = await transcribeCapped(spec, signal)
    expect(merged.text).toBe('first\nsecond')
    expect(merged.audioSeconds).toBe(3)
    expect(merged.inferenceSeconds).toBe(1.5)
    expect(merged.segments).toEqual([{ text: 'first', start: 0.5, end: 2 }, { text: 'second', start: 2, end: 3 }])
    for (const size of sizes) expect(size).toBeLessThanOrEqual(2 * 16000 * 2 + 44)
    expect(sizes).toHaveLength(2)
  })

  it('joins silent pieces without inventing empty spans', async () => {
    const audio = wave(new Array(2 * 16000).fill(0))
    const spec: SpeechSpec = {
      provider: {
        info: { id: 'capped' as SpeechProviderId, name: 'capped', location: 'cloud', languages: ['auto'], maxAudioSeconds: 1 },
        transcribe: async () => ({ text: '', audioSeconds: 1, inferenceSeconds: 0 }),
      },
      audio, language: 'auto',
    }
    const merged = await transcribeCapped(spec, signal)
    expect(merged.text).toBe('')
    expect(merged.segments).toBeUndefined()
    expect(merged.audioSeconds).toBe(2)
  })
})

describe('registry chunking', () => {
  it('splits through transcribe exactly as the capped helper does', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SpeechToText, { defaultProvider: 'capped', language: 'auto' })
      const service = ctx.get('speechToText')!
      let calls = 0
      const remove = service.register({
        info: { id: 'capped' as SpeechProviderId, name: 'capped', location: 'cloud', languages: ['auto'], maxAudioSeconds: 2 },
        transcribe: async input => {
          calls++
          return { text: `piece ${calls}`, audioSeconds: parseWave(input.audio), inferenceSeconds: 0 }
        },
      })
      const spec = service.resolve({ audio: wave(new Array(3 * 16000).fill(1)) })
      const merged = await service.transcribe(spec, signal)
      expect(merged.text).toBe('piece 1\npiece 2')
      expect(merged.audioSeconds).toBe(3)
      expect(calls).toBe(2)
      await remove()
    } finally { await ctx.fiber.dispose() }
  })
})
