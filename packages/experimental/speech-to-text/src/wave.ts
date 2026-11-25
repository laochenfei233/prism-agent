/** Validate browser PCM WAV headers before retaining or forwarding audio. */

/** Byte length of the canonical WAV header the capture pipeline emits. */
const HEADER_BYTES = 44

/** Byte rate of the canonical 16 kHz mono PCM16 stream. */
const BYTE_RATE = 32000

/**
 * Validate the canonical 16 kHz mono PCM16 WAV header and read the recording length.
 * @param audio - decoded wire bytes.
 * @returns complete recording duration in seconds.
 */
export function parseWave(audio: Uint8Array): number {
  const data = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
  if (data.length < 46 || data.toString('ascii', 0, 4) !== 'RIFF'
    || data.toString('ascii', 8, 12) !== 'WAVE' || data.toString('ascii', 12, 16) !== 'fmt '
    || data.readUInt32LE(16) !== 16 || data.readUInt16LE(20) !== 1 || data.readUInt16LE(22) !== 1
    || data.readUInt32LE(24) !== 16000 || data.readUInt32LE(28) !== 32000
    || data.readUInt16LE(32) !== 2 || data.readUInt16LE(34) !== 16
    || data.toString('ascii', 36, 40) !== 'data' || data.readUInt32LE(4) !== data.length - 8
    || data.readUInt32LE(40) !== data.length - 44 || (data.length - 44) % 2 !== 0) {
    throw new Error('Audio must be a canonical 16 kHz mono PCM16 WAV recording')
  }
  return (data.length - HEADER_BYTES) / BYTE_RATE
}

/**
 * Validate the canonical WAV header and admit the recording only within a duration cap.
 * @param audio - decoded wire bytes.
 * @param maxDurationSeconds - maximum admitted recording duration.
 * @returns complete recording duration in seconds.
 */
export function validateWave(audio: Uint8Array, maxDurationSeconds: number): number {
  const seconds = parseWave(audio)
  if (seconds > maxDurationSeconds) throw new Error(`Audio exceeds ${maxDurationSeconds} seconds`)
  return seconds
}

/**
 * Copy one sample range of a canonical WAV into a fresh canonical WAV, so chunked
 * recognizers receive recordings that pass the same header validation as whole ones.
 * @param audio - canonical WAV the samples come from.
 * @param startSample - first sample, inclusive.
 * @param endSample - last sample, exclusive; clipped to the recording length.
 * @returns WAV bytes covering the requested samples, header included.
 */
export function sliceWave(audio: Uint8Array, startSample: number, endSample: number): Uint8Array {
  const totalSamples = Math.floor((audio.byteLength - HEADER_BYTES) / 2)
  const start = Math.max(0, Math.min(Math.floor(startSample), totalSamples))
  const end = Math.max(start, Math.min(Math.floor(endSample), totalSamples))
  const pcm = audio.subarray(HEADER_BYTES + start * 2, HEADER_BYTES + end * 2)
  const out = new Uint8Array(HEADER_BYTES + pcm.byteLength)
  const header = Buffer.from(out.buffer, 0, HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.byteLength, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(BYTE_RATE, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.byteLength, 40)
  out.set(pcm, HEADER_BYTES)
  return out
}
