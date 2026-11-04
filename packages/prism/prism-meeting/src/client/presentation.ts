/**
 * Pure folds and formatters the meeting page renders; nothing here touches a
 * service, so the presentation stays testable without a Client runtime.
 * @module @prism-ai/prism-meeting/src/client/presentation
 */

import type { MeetingSpeechStatus } from '../types.ts'
import type { MeetingView } from '../view.ts'
import type { MeetingLocaleKey } from './locales.ts'

/** Translator bound to this plugin's dictionary. */
export type Translate = (key: MeetingLocaleKey, params?: Record<string, string>) => string

/**
 * Keep the meetings a free-text query matches, in the given order.
 * @param meetings - stored meetings in list order.
 * @param query - raw query text; blank keeps every meeting.
 * @returns the matching subset.
 */
export function filterMeetings(meetings: readonly MeetingView[], query: string): MeetingView[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle.length === 0) return [...meetings]
  return meetings.filter((meeting) => {
    const haystack = [meeting.title, meeting.participants.join(' '), meeting.summary ?? '']
      .join(' ')
      .toLocaleLowerCase()
    return haystack.includes(needle)
  })
}

/**
 * Format a stored ISO-8601 timestamp in local time.
 * @param iso - durable timestamp.
 * @returns `YYYY-MM-DD HH:mm`, or the raw value when it is not a date.
 */
export function timestampText(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Format a recognized-audio duration.
 * @param seconds - stored duration.
 * @returns `m:ss` or `h:mm:ss`, or null for an unknown or absent duration.
 */
export function durationText(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const total = Math.round(seconds)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`
}

/**
 * Split the comma-separated participant field, dropping blank entries.
 * @param input - raw field text; commas may be half- or full-width.
 * @returns normalized display names.
 */
export function parseParticipants(input: string): string[] {
  return input
    .split(/[,，]/u)
    .map(name => name.trim())
    .filter(name => name.length > 0)
}

/**
 * Render one stored transcript as display lines, naming each speaker.
 * @param transcript - plain transcript used when the record holds no spans.
 * @param segments - speaker-attributed spans of that transcript.
 * @param t - bound translator.
 * @returns the lines to render, in recognition order.
 */
export function transcriptLines(
  transcript: string,
  segments: MeetingView['segments'],
  t: Translate,
): string {
  if (segments.length === 0) return transcript
  return segments
    .map(segment => (segment.speaker === undefined
      ? segment.text
      : t('speakerLine', {
        speaker: t('speakerLabel', { speaker: segment.speaker }),
        text: segment.text,
      })))
    .join('\n')
}

/**
 * Format one byte count for a progress line.
 * @param count - byte count.
 * @returns a compact `B`/`KB`/`MB`/`GB` rendering.
 */
export function bytesText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB'] as const
  let value = count
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1)
  return `${rounded} ${units[unit]}`
}

/**
 * Format one download's progress.
 * @param completedBytes - byte count already downloaded.
 * @param totalBytes - known total, or undefined while unknown.
 * @returns the `done / total` or bare `done` progress text.
 */
export function downloadProgress(completedBytes: number, totalBytes: number | undefined): string {
  const done = bytesText(completedBytes)
  return totalBytes === undefined ? done : `${done} / ${bytesText(totalBytes)}`
}

/**
 * Read the provider a speech notice and its actions address.
 * @param status - speech availability reported by the deployment.
 * @returns the selected provider, or the first one, or null with no providers.
 */
export function selectedSpeechProvider(status: MeetingSpeechStatus): MeetingSpeechStatus['providers'][number] | null {
  if (status.providers.length === 0) return null
  return status.providers.find(provider => provider.id === status.selected) ?? status.providers[0] ?? null
}

/** Action the page offers for one provider's preparation state. */
export type SpeechPhaseAction = 'prepare' | 'cancel'

/**
 * Decide the preparation action one provider's phase calls for.
 * @param provider - the provider the page would act on.
 * @returns `prepare` while the operator can start it, `cancel` while preparation runs, null when ready.
 */
export function speechPhaseAction(provider: MeetingSpeechStatus['providers'][number]): SpeechPhaseAction | null {
  if (provider.phase === 'ready' || provider.phase === 'standby') return null
  return provider.phase === 'downloading' || provider.phase === 'checking'
    || provider.phase === 'loading' || provider.phase === 'waking' || provider.phase === 'cancelling'
    ? 'cancel'
    : 'prepare'
}

/**
 * Name the speech provider state that stops a recording from producing a transcript.
 * @param status - speech availability reported by the deployment.
 * @param t - bound translator.
 * @returns the notice text, or null when a recording would transcribe.
 */
export function speechNotice(status: MeetingSpeechStatus, t: Translate): string | null {
  if (status.providers.length === 0) return t('speechMissing')
  const selected = selectedSpeechProvider(status)
  if (selected === null) return t('speechMissing')
  // `standby` is a prepared provider's normal steady state, not a gap to warn about.
  if (selected.phase === 'ready' || selected.phase === 'standby') return null
  if (selected.phase === 'failed') {
    return t('speechPrepareFailed', {
      provider: selected.name,
      reason: selected.preparation?.message ?? selected.phase,
    })
  }
  if (selected.phase === 'downloading') {
    const preparation = selected.preparation
    return t('speechDownloading', {
      provider: selected.name,
      resource: preparation?.resource ?? '',
      progress: downloadProgress(preparation?.completedBytes ?? 0, preparation?.totalBytes),
    })
  }
  return t('speechNotReady', { provider: selected.name, phase: selected.phase })
}

/**
 * Name one meeting status for display.
 * @param status - durable meeting status.
 * @param t - bound translator.
 * @returns the operator-facing status label.
 */
export function statusLabel(status: MeetingView['status'], t: Translate): string {
  if (status === 'recording') return t('statusRecording')
  return status === 'summarized' ? t('statusSummarized') : t('statusTranscribed')
}

/**
 * One list row's secondary line: status, transcript length, and participants.
 * @param meeting - the stored meeting.
 * @param t - bound translator.
 * @returns the row's meta parts in render order.
 */
export function rowMeta(meeting: MeetingView, t: Translate): string[] {
  const duration = durationText(meeting.audioSeconds)
  return [
    statusLabel(meeting.status, t),
    t('transcriptCharsValue', { count: String(meeting.transcriptChars) }),
    duration === null ? t('noAudio') : `${t('duration')} ${duration}`,
    meeting.participants.length === 0 ? t('noParticipants') : meeting.participants.join(', '),
  ]
}
