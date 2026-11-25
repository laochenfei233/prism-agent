/**
 * Public type vocabulary of the meeting-minutes capability. This module carries
 * types only; the service and zod schemas own runtime behavior.
 * @module @prism/prism-meeting/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one durable meeting record. */
export type MeetingMinutesId = Branded<'MeetingMinutesId'>

/** Identifies one durable question/answer exchange for one meeting. */
export type MeetingAnswerId = Branded<'MeetingAnswerId'>

/**
 * Lifecycle of one durable meeting record. `recording` is a microphone the
 * caller still holds open, so its transcript is a leading fragment; everything
 * else reads a complete transcript. It does not track the transient in-flight
 * summary model call.
 */
export type MeetingMinutesStatus = 'recording' | 'transcribed' | 'summarized'

/** One recognized span of a meeting recording, with the speaker its provider attributed it to. */
export interface MeetingTranscriptSegment {
  /** Verbatim recognized text of this span, without any speaker prefix. */
  readonly text: string
  /**
   * Provider-assigned speaker label, meaningful only within this one recording.
   * Absent when the provider recognizes no speakers.
   */
  readonly speaker?: string | undefined
}

/** One durable meeting record, including its source transcript and latest summary. */
export interface MeetingMinutesRecord {
  readonly id: MeetingMinutesId
  readonly title: string
  /** Ordered participant display names; names are normalized but not identities. */
  readonly participants: readonly string[]
  readonly transcript: string
  /**
   * Speaker-attributed spans of `transcript`, in recognition order. Absent for
   * a text import and for any meeting whose recognition reported no speakers.
   */
  readonly transcriptSegments?: readonly MeetingTranscriptSegment[] | undefined
  readonly summary: string | null
  readonly status: MeetingMinutesStatus
  readonly audioSeconds: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** One durable answer to a question about one meeting. */
export interface MeetingAnswerRecord {
  readonly id: MeetingAnswerId
  readonly meetingId: MeetingMinutesId
  readonly question: string
  readonly answer: string
  readonly createdAt: string
}

/** Caller input for creating a meeting from already-available text. */
export interface CreateMeetingFromTranscriptRequest {
  readonly title: string
  readonly participants?: readonly string[]
  readonly transcript: string
  /** Speaker-attributed spans of `transcript`; omission stores no speaker labels. */
  readonly segments?: readonly MeetingTranscriptSegment[]
  /** Recognized-audio duration; a text import may supply zero. */
  readonly audioSeconds?: number
}

/** Caller input for opening one durable recording before any transcript exists. */
export interface BeginMeetingRecordingRequest {
  readonly title: string
  readonly participants?: readonly string[]
}

/**
 * Caller input replacing the transcript one open recording has produced so far.
 * The caller owns recognition and sends the complete text, so no append ordering
 * survives a dropped request.
 */
export interface UpdateMeetingRecordingRequest {
  /** Complete transcript recognized from the recording so far; empty before the first slice. */
  readonly transcript: string
  /** Speaker-attributed spans of `transcript`; omission stores no speaker labels. */
  readonly segments?: readonly MeetingTranscriptSegment[]
  /** Recognized-audio duration of that recording. */
  readonly audioSeconds: number
}

/** Caller input closing one open recording with the transcript of its complete recording. */
export interface FinishMeetingRecordingRequest {
  /** Complete transcript of the whole recording; empty when recognition produced none. */
  readonly transcript: string
  /** Speaker-attributed spans of `transcript`; omission stores no speaker labels. */
  readonly segments?: readonly MeetingTranscriptSegment[]
  /** Complete recognized-audio duration, or the recorded elapsed seconds when recognition failed. */
  readonly audioSeconds: number
}

/** Caller input revising the operator-editable fields of any stored meeting. */
export interface ReviseMeetingMinutesRequest {
  readonly title?: string
  readonly participants?: readonly string[]
}

/** Caller input for creating a meeting by running one complete recording through speech recognition. */
export interface CreateMeetingFromAudioRequest {
  readonly title: string
  readonly participants?: readonly string[]
  readonly audio: Uint8Array
  /** Speech-provider language hint; omission uses the speech plugin's selection. */
  readonly language?: string
  /** Speech-provider id; omission uses the speech plugin's selection. */
  readonly providerId?: string
}

/** Caller input for one persisted question/answer exchange. */
export interface AskMeetingMinutesRequest {
  readonly question: string
}

/** Recognized text of one complete recording, before any durable write. */
export interface MeetingTranscript {
  readonly text: string
  /** Speaker-attributed spans of `text`; absent when the provider reports no speakers. */
  readonly segments?: readonly MeetingTranscriptSegment[]
  /** Recognized-audio duration reported by the speech provider. */
  readonly audioSeconds: number
}

/** JSON-safe preparation progress a browser caller renders. */
export interface MeetingSpeechPreparation {
  /** Preparation phase as the provider reports it. */
  readonly phase: string
  /** Failure message; present when the phase is `failed`. */
  readonly message?: string
  /** Name of the resource being downloaded; present while the phase is `downloading`. */
  readonly resource?: string
  /** Byte count already downloaded of `resource`. */
  readonly completedBytes?: number
  /** Known total byte count of `resource`; absent while unknown. */
  readonly totalBytes?: number
}

/** One speech provider this deployment can transcribe with. */
export interface MeetingSpeechProvider {
  readonly id: string
  readonly name: string
  /** Provider resource readiness; a provider that needs no download transcribes while unprepared. */
  readonly phase: string
  /** Language hints the provider accepts, including `auto` when it detects language. */
  readonly languages: readonly string[]
  /** Preparation progress beyond the phase; absent when the provider has no preparation control or reports nothing extra. */
  readonly preparation?: MeetingSpeechPreparation
}

/** Speech availability a browser caller reads before it offers recording. */
export interface MeetingSpeechStatus {
  readonly providers: readonly MeetingSpeechProvider[]
  /** Provider a transcription without an explicit selection uses. */
  readonly selected: string
  /** Language hint a transcription without an explicit selection uses. */
  readonly language: string
}
