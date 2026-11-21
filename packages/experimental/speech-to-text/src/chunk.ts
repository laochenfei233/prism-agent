/** Split oversized canonical WAV recordings at quiet boundaries for capped recognizers. */
import type { SpeechSpec, SpeechSegment, Transcript } from './types.ts'
import { parseWave, sliceWave } from './wave.ts'

/** Sample rate of the canonical 16 kHz mono PCM16 stream. */
const SAMPLES_PER_SECOND = 16000

/** Width of the energy window rated for a quiet cut, in samples (20 ms). */
const WINDOW_SAMPLES = 320

/** How far before the duration cap a cut point may search for silence, in samples (3 s). */
const SEARCH_SAMPLES = SAMPLES_PER_SECOND * 3

/** Smallest piece a quiet cut may produce, in samples (1 s); keeps one valley from shattering into slivers. */
const MIN_CHUNK_SAMPLES = SAMPLES_PER_SECOND

/** One piece of a split recording, in submission order. */
export interface WaveChunk {
  readonly audio: Uint8Array
  /** Offset of this piece from the start of the full recording, in seconds. */
  readonly startSeconds: number
}

/**
 * Split a canonical WAV into pieces no longer than the cap, cutting at the quietest
 * 20 ms window before each cap boundary when the recording holds one; a recording
 * already within the cap yields once with the original bytes.
 * @param audio - canonical 16 kHz mono PCM16 WAV.
 * @param maxSeconds - per-piece duration cap.
 * @yields pieces in submission order, each within the cap.
 * @returns the generator over the pieces.
 */
export function* chunkWave(audio: Uint8Array, maxSeconds: number): Generator<WaveChunk> {
  const seconds = parseWave(audio)
  const totalSamples = Math.round(seconds * SAMPLES_PER_SECOND)
  const maxSamples = Math.floor(maxSeconds * SAMPLES_PER_SECOND)
  if (totalSamples <= maxSamples || maxSamples < WINDOW_SAMPLES) {
    yield { audio, startSeconds: 0 }
    return
  }
  let start = 0
  while (start < totalSamples) {
    const target = start + maxSamples
    const end = target >= totalSamples ? totalSamples : quietBoundary(audio, start, target, totalSamples)
    yield { audio: sliceWave(audio, start, end), startSeconds: start / SAMPLES_PER_SECOND }
    start = end
  }
}

/**
 * Recognize one recording on a provider that declares a per-request cap: recordings
 * within the cap reach the provider whole; longer ones are split at quiet boundaries,
 * recognized in order, and merged — text joins with newlines, segment times shift by
 * the piece offset, and duration totals sum.
 * @param spec - resolved selection pinning the provider, recording, language, and model.
 * @param signal - caller or registration cancellation.
 * @returns the final merged transcript.
 */
export async function transcribeCapped(spec: SpeechSpec, signal: AbortSignal): Promise<Transcript> {
  const cap = spec.provider.info.maxAudioSeconds
  let seconds: number
  try {
    seconds = parseWave(spec.audio)
  } catch {
    // Non-canonical audio is the provider's to reject in its own words; the
    // registry only splits what it can measure.
    return callProvider(spec, spec.audio, signal)
  }
  if (cap === undefined || seconds <= cap) return callProvider(spec, spec.audio, signal)
  const text: string[] = []
  const segments: SpeechSegment[] = []
  let audioSeconds = 0
  let inferenceSeconds = 0
  for (const chunk of chunkWave(spec.audio, cap)) {
    signal.throwIfAborted()
    const piece = await callProvider(spec, chunk.audio, signal)
    audioSeconds += piece.audioSeconds
    inferenceSeconds += piece.inferenceSeconds
    if (piece.text !== '') text.push(piece.text)
    mergeSegments(segments, piece.segments, piece.text, chunk.startSeconds, piece.audioSeconds)
  }
  return { text: text.join('\n'), audioSeconds, inferenceSeconds,
    ...segments.length === 0 ? {} : { segments } }
}

/** @returns one recognizer call carrying the recording and the resolved language and model. */
function callProvider(spec: SpeechSpec, audio: Uint8Array, signal: AbortSignal): Promise<Transcript> {
  return spec.provider.transcribe({ audio, language: spec.language,
    ...spec.model === undefined ? {} : { model: spec.model } }, signal)
}

/**
 * Append one piece's spans to the merged list, shifting reported times by the piece
 * offset; a piece without spans contributes one synthesized span covering its text.
 */
function mergeSegments(
  merged: SpeechSegment[],
  reported: readonly SpeechSegment[] | undefined,
  text: string,
  startSeconds: number,
  audioSeconds: number,
): void {
  if (reported !== undefined) {
    for (const segment of reported) merged.push({
      text: segment.text,
      ...segment.speaker === undefined ? {} : { speaker: segment.speaker },
      ...segment.start === undefined ? {} : { start: segment.start + startSeconds },
      ...segment.end === undefined ? {} : { end: segment.end + startSeconds },
    })
    return
  }
  if (text !== '') merged.push({ text, start: startSeconds, end: startSeconds + audioSeconds })
}

/** @returns the sample offset of the quietest 20 ms window between the previous cut and the cap target. */
function quietBoundary(audio: Uint8Array, start: number, target: number, totalSamples: number): number {
  const from = Math.max(start + MIN_CHUNK_SAMPLES, target - SEARCH_SAMPLES)
  let best = target
  // The target window anchors the comparison, so a recording of uniform energy cuts
  // on schedule and only a strictly quieter window moves the cut earlier.
  let bestEnergy = target + WINDOW_SAMPLES <= totalSamples ? windowEnergy(audio, target) : Number.POSITIVE_INFINITY
  for (let window = from; window + WINDOW_SAMPLES <= totalSamples && window <= target; window += WINDOW_SAMPLES) {
    const energy = windowEnergy(audio, window)
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = window
    }
  }
  return best
}

/** @returns mean squared sample amplitude of one 20 ms window. */
function windowEnergy(audio: Uint8Array, window: number): number {
  const data = new DataView(audio.buffer, audio.byteOffset + 44 + window * 2, WINDOW_SAMPLES * 2)
  let energy = 0
  for (let i = 0; i < WINDOW_SAMPLES; i++) {
    const sample = data.getInt16(i * 2, true)
    energy += sample * sample
  }
  return energy / WINDOW_SAMPLES
}
