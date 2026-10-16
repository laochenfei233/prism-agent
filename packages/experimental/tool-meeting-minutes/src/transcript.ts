/**
 * Composition of the transcript document written beside a recording, plus the bounded
 * preview returned to the model.
 * @module @deepseek-ai/dsh-experimental-tool-meeting-minutes/transcript
 */

/** Facts recorded in the transcript document's header. */
export interface TranscriptDocument {
  /** Title the caller gave the meeting, or the recording's own name. */
  readonly title: string
  /** Participants the caller named; the recognizer does not identify them. */
  readonly participants: readonly string[]
  /** Instant the transcription ran. */
  readonly transcribedAt: Date
  /** Measured recording duration in seconds. */
  readonly audioSeconds: number
  /** Workspace path of the recording the transcript came from. */
  readonly recordingPath: string
  /** Text the recognizer produced. */
  readonly text: string
}

/**
 * Format a duration the way a meeting header reads it.
 * @param seconds - duration in seconds.
 * @returns `H:MM:SS` from one hour, else `M:SS`.
 */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(whole / 60)
  const remainder = String(whole % 60).padStart(2, '0')
  if (minutes < 60) return `${minutes}:${remainder}`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${remainder}`
}

/**
 * Render the transcript as the Markdown document stored beside the recording.
 * @param document - meeting facts and the recognized text.
 * @returns one complete Markdown document.
 */
export function renderTranscriptDocument(document: TranscriptDocument): string {
  const header = [`# Transcript: ${document.title}`, '']
  header.push(`- Recorded: ${document.transcribedAt.toISOString()}`)
  header.push(`- Duration: ${formatDuration(document.audioSeconds)}`)
  if (document.participants.length > 0) header.push(`- Participants: ${document.participants.join(', ')}`)
  header.push(`- Recording: ${document.recordingPath}`)
  return `${[...header, '', '---', '', document.text].join('\n')}\n`
}

/**
 * Bound the transcript text carried into the model-visible result.
 * @param text - the complete transcript.
 * @param maxCharacters - the largest prefix the result may carry.
 * @returns the prefix to return and whether text was withheld.
 */
export function previewTranscript(text: string, maxCharacters: number): { preview: string; truncated: boolean } {
  if (text.length <= maxCharacters) return { preview: text, truncated: false }
  return { preview: text.slice(0, maxCharacters), truncated: true }
}
