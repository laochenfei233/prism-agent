/**
 * Meeting-minutes domain declaration: durable record schemas and the storage
 * domain opened by the service. Zod validation belongs at this durable boundary.
 * @module @deepseek-ai/dsh-meeting-minutes/src/spec
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

/** Durable shape of one meeting record. Timestamps are ISO-8601 strings. */
export const meetingMinutesRecord = z.object({
  id: meetingMinutesId,
  title: z.string().min(1),
  participants: z.array(z.string().min(1)),
  transcript: z.string().min(1),
  summary: z.string().min(1).nullable(),
  status: z.enum(['transcribed', 'summarized']),
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
 * table. Version 1 is the first committed generation.
 */
export const meetingMinutesDomainSpec = defineDomain({
  name: 'meeting_minutes',
  version: 1,
  tables: {
    meetings: domainTable<MeetingMinutesId, StoredMeetingMinutesRecord>(meetingMinutesRecord),
    answers: domainTable<MeetingAnswerId, StoredMeetingAnswerRecord>(meetingAnswerRecord),
  },
})
