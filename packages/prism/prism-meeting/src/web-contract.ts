/**
 * Wire vocabulary of the browser meeting routes: the JSON bodies the page
 * sends and the values it renders. Types only; the host entry validates every
 * body at the HTTP boundary.
 * @module @prism-ai/prism-meeting/src/web-contract
 */

import type { AnswerView, MeetingView } from './view.ts'
import type { MeetingSpeechStatus } from './types.ts'

/** One browser-facing failure, shaped like the Connection RPC failure. */
export interface MeetingFailure {
  readonly code: string
  readonly message: string
}

/** Envelope every meeting route answers with. */
export type MeetingResponse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: MeetingFailure }

/** Body of the routes that address one stored meeting. */
export interface MeetingIdBody {
  readonly id: string
}

/** One recognized span in a browser request body; the service owns the rules. */
export interface MeetingSegmentBody {
  readonly text: string
  readonly speaker?: string | undefined
}

/** Body of a text import; the service owns title, participant, and transcript rules. */
export interface MeetingCreateBody {
  readonly title: string
  readonly participants?: readonly string[]
  readonly transcript: string
  readonly segments?: readonly MeetingSegmentBody[]
  readonly audioSeconds?: number
}

/** Body opening one durable recording; the service owns the title and participant rules. */
export interface MeetingBeginBody {
  readonly title: string
  readonly participants?: readonly string[]
}

/** Body of the live writes against one open recording. */
export interface MeetingRecordingBody {
  readonly id: string
  readonly transcript: string
  readonly segments?: readonly MeetingSegmentBody[]
  readonly audioSeconds: number
}

/** Body revising the operator-editable fields of one stored meeting. */
export interface MeetingReviseBody {
  readonly id: string
  readonly title?: string
  readonly participants?: readonly string[]
}

/** Value of `list`; transcripts stay out of the list projection. */
export interface MeetingListValue {
  readonly meetings: readonly MeetingView[]
}

/** Value of the routes that answer with one complete meeting. */
export interface MeetingValue {
  readonly meeting: MeetingView
}

/** Value of `delete`. */
export interface MeetingDeletedValue {
  readonly deleted: boolean
}

/** Value of `transcribe`: recognized text without a stored meeting. */
export interface MeetingTranscriptValue {
  readonly text: string
  readonly segments?: readonly MeetingSegmentBody[]
  readonly audioSeconds: number
}

/** Value of `speech`: the providers this deployment can transcribe with. */
export interface MeetingSpeechValue {
  readonly speech: MeetingSpeechStatus
}

/** Body of the routes that address one provider's preparation; omission targets the selection. */
export interface MeetingSpeechTargetBody {
  readonly providerId?: string
}

/** Body selecting one recognizer as the deployment's speech selection. */
export interface MeetingSpeechSelectBody {
  readonly providerId: string
  readonly language?: string
}

/** Value of `ask`: one persisted answer. */
export interface MeetingAnswerValue {
  readonly answer: AnswerView
}

/** Value of `answers`: one meeting's persisted exchanges, newest first. */
export interface MeetingAnswersValue {
  readonly answers: readonly AnswerView[]
}

/** Body asking one stored meeting a question. */
export interface MeetingAskBody {
  readonly id: string
  readonly question: string
}
