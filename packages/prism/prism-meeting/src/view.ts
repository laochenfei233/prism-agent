/**
 * One projection per durable meeting record for the consumers that read it:
 * the model-facing tools include the transcript only when the operation asks
 * for it, the browser list reads a transcript length instead.
 * @module @prism/prism-meeting/src/view
 */

import type { MeetingAnswerRecord, MeetingMinutesRecord } from './types.ts'

/** One recognized span as a consumer reads it; an absent speaker is omitted, never null. */
export interface MeetingSegmentView {
  readonly text: string
  readonly speaker?: string
}

/** Serializable meeting fields shared by the tool and browser consumers. */
export interface MeetingView {
  id: string
  title: string
  participants: string[]
  status: MeetingMinutesRecord['status']
  summary: string | null
  transcript: string
  /** Speaker-attributed spans of `transcript`; empty when the record holds none. */
  segments: MeetingSegmentView[]
  transcriptChars: number
  audioSeconds: number
  createdAt: string
  updatedAt: string
}

/** Serializable answer fields shared by the tool and browser consumers. */
export interface AnswerView {
  id: string
  meetingId: string
  question: string
  answer: string
  createdAt: string
}

/**
 * Build one stable meeting view.
 * @param record - The durable record.
 * @param includeTranscript - Whether the potentially long transcript is included.
 * @returns the consumer-facing meeting view.
 */
export function meetingView(record: MeetingMinutesRecord, includeTranscript: boolean): MeetingView {
  return {
    id: record.id,
    title: record.title,
    participants: [...record.participants],
    status: record.status,
    summary: record.summary,
    transcript: includeTranscript ? record.transcript : '',
    // Spans stay out of a projection that omits the transcript they reconstruct.
    segments: includeTranscript
      ? (record.transcriptSegments ?? []).map(segment => (segment.speaker === undefined
        ? { text: segment.text }
        : { text: segment.text, speaker: segment.speaker }))
      : [],
    transcriptChars: record.transcript.length,
    audioSeconds: record.audioSeconds,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * Build one stable answer view.
 * @param record - The durable answer.
 * @returns the consumer-facing answer view.
 */
export function answerView(record: MeetingAnswerRecord): AnswerView {
  return { ...record }
}
