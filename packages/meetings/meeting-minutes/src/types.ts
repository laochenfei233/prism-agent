/**
 * Public type vocabulary of the meeting-minutes capability. This module carries
 * types only; the service and zod schemas own runtime behavior.
 * @module @deepseek-ai/dsh-meeting-minutes/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one durable meeting record. */
export type MeetingMinutesId = Branded<'MeetingMinutesId'>

/** Identifies one durable question/answer exchange for one meeting. */
export type MeetingAnswerId = Branded<'MeetingAnswerId'>

/** Lifecycle of the AI summary; it does not track the transient in-flight model call. */
export type MeetingMinutesStatus = 'transcribed' | 'summarized'

/** One durable meeting record, including its source transcript and latest summary. */
export interface MeetingMinutesRecord {
  readonly id: MeetingMinutesId
  readonly title: string
  /** Ordered participant display names; names are normalized but not identities. */
  readonly participants: readonly string[]
  readonly transcript: string
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
  /** Recognized-audio duration; a text import may supply zero. */
  readonly audioSeconds?: number
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
