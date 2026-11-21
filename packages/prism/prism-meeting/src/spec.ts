/**
 * Meeting-minutes domain declaration: durable record schemas and the storage
 * domain opened by the service. Zod validation belongs at this durable boundary.
 * @module @prism/prism-meeting/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { MeetingAnswerId, MeetingAnswerRecord, MeetingMinutesId, MeetingMinutesRecord } from './types.ts'

/** Monotonic creation order within one domain generation. */
const recordSequence = z.number().int().min(1)

/** Meeting id schema at the durable boundary; branding has no runtime representation. */
const meetingMinutesId = z.string().transform(value => brandString<MeetingMinutesId>(value))

/** Answer id schema at the durable boundary; branding has no runtime representation. */
const meetingAnswerId = z.string().transform(value => brandString<MeetingAnswerId>(value))

/** Durable shape of one recognized span and its provider-assigned speaker. */
export const meetingTranscriptSegment = z.object({
  text: z.string().min(1),
  speaker: z.string().min(1).optional(),
})

/** Durable shape of one meeting record. Timestamps are ISO-8601 strings. */
export const meetingMinutesRecord = z.object({
  id: meetingMinutesId,
  title: z.string().min(1),
  participants: z.array(z.string().min(1)),
  /** Empty while the microphone is still open; complete once the recording ends. */
  transcript: z.string(),
  /**
   * Speaker-attributed spans of `transcript`. Optional because a text import and
   * a provider without speaker separation both store none, and because records
   * written before the field existed stay readable.
   */
  transcriptSegments: z.array(meetingTranscriptSegment).optional(),
  summary: z.string().min(1).nullable(),
  status: z.enum(['recording', 'transcribed', 'summarized']),
  audioSeconds: z.number().min(0),
  sequence: recordSequence,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

/** Durable shape of one question/answer exchange. */
export const meetingAnswerRecord = z.object({
  id: meetingAnswerId,
  meetingId: meetingMinutesId,
  question: z.string().min(1),
  answer: z.string().min(1),
  sequence: recordSequence,
  createdAt: z.string().min(1),
})

/** Durable meeting record with its persisted creation-order sequence. */
export interface StoredMeetingMinutesRecord extends MeetingMinutesRecord {
  readonly sequence: number
}

/** Durable answer record with its persisted creation-order sequence. */
export interface StoredMeetingAnswerRecord extends MeetingAnswerRecord {
  readonly sequence: number
}

/**
 * The meeting-minutes domain: one meeting table plus its dependent answer
 * table. Version 2 widens the version-1 record schema — a record may hold an
 * empty transcript while its microphone is open — which is why version 1
 * stays readable and why the layout is now `per-record`: a live recording
 * rewrites its own record repeatedly, and a growing transcript should not
 * republish every stored meeting on each slice. Version 2 also stays current
 * for the optional `transcriptSegments` field: both versions accept each
 * other's records, so no new generation is needed.
 */
export const meetingMinutesDomainSpec = defineDomain({
  name: 'meeting_minutes',
  version: 2,
  compatibleVersions: [1],
  layout: 'per-record',
  tables: {
    meetings: domainTable<MeetingMinutesId, StoredMeetingMinutesRecord>(meetingMinutesRecord),
    answers: domainTable<MeetingAnswerId, StoredMeetingAnswerRecord>(meetingAnswerRecord),
  },
})
