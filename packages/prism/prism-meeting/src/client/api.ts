/**
 * Browser client for the meeting routes: one typed request per operation, with
 * every response narrowed at this wire boundary before the page renders it.
 * Requests are document-relative so a host mount prefix keeps working.
 * @module @prism-ai/prism-meeting/src/client/api
 */

import type { AnswerView, MeetingView } from '../view.ts'
import type { MeetingSpeechPreparation, MeetingSpeechStatus } from '../types.ts'
import type {
  MeetingCreateBody, MeetingBeginBody, MeetingRecordingBody, MeetingReviseBody, MeetingResponse,
  MeetingSegmentBody,
} from '../web-contract.ts'

/** Path prefix below `/api` every request of this client addresses. */
const BASE = 'api/prism-meeting'

/** One meeting operation failed; `code` names the failing layer. */
export class MeetingRequestError extends Error {
  /**
   * @param code - Host failure code, or the client-side validation code.
   * @param message - Operator-readable failure text.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'MeetingRequestError'
  }
}

/** Fields every meeting projection carries. */
const MEETING_KEYS = [
  'id', 'title', 'participants', 'status', 'summary',
  'transcript', 'segments', 'transcriptChars', 'audioSeconds', 'createdAt', 'updatedAt',
] as const

/** Whether one decoded value is a speaker-attributed span. */
function isSegment(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.text === 'string'
    && (record.speaker === undefined || typeof record.speaker === 'string')
}

/**
 * Whether one decoded value is a complete meeting projection.
 * @param value - decoded JSON value.
 * @returns true only for a value with every projected field at its declared type.
 */
function isMeeting(value: unknown): value is MeetingView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (!MEETING_KEYS.every(key => key in record)) return false
  return typeof record.id === 'string' && typeof record.title === 'string'
    && Array.isArray(record.participants) && record.participants.every(name => typeof name === 'string')
    && (record.status === 'recording' || record.status === 'transcribed' || record.status === 'summarized')
    && (record.summary === null || typeof record.summary === 'string')
    && typeof record.transcript === 'string'
    && Array.isArray(record.segments) && record.segments.every(isSegment)
    && typeof record.transcriptChars === 'number'
    && typeof record.audioSeconds === 'number'
    && typeof record.createdAt === 'string' && typeof record.updatedAt === 'string'
}

/** Build the failure for a host response this client cannot read. */
function invalidResponse(subject: string): MeetingRequestError {
  return new MeetingRequestError('prism-meeting/invalid-response', `the host answered with an invalid ${subject}`)
}

/**
 * Whether one decoded value is this plugin's response envelope.
 * @param value - decoded JSON value.
 * @returns true for either arm of the envelope.
 */
function isEnvelope(value: unknown): value is MeetingResponse<unknown> {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.ok === true) return 'value' in record
  if (record.ok !== false || typeof record.error !== 'object' || record.error === null) return false
  const error = record.error as Record<string, unknown>
  return typeof error.code === 'string' && typeof error.message === 'string'
}

/**
 * Read one named field from a decoded value.
 * @param value - decoded host value.
 * @param field - field the operation's value carries.
 * @returns the field value.
 */
function readField(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null || !(field in value)) throw invalidResponse(field)
  return (value as Record<string, unknown>)[field]
}

/**
 * Read one named field a response may legitimately omit.
 * @param value - decoded host value.
 * @param field - optional field the operation's value may carry.
 * @returns the field value, or undefined when the host omitted it.
 */
function readOptionalField(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null) throw invalidResponse(field)
  return (value as Record<string, unknown>)[field]
}

/** Read one optional string field from a decoded value. */
function readOptionalString(value: Record<string, unknown>, field: string): string | undefined {
  const item = value[field]
  if (item === undefined) return undefined
  if (typeof item !== 'string') throw invalidResponse(field)
  return item
}

/** Read one optional number field from a decoded value. */
function readOptionalNumber(value: Record<string, unknown>, field: string): number | undefined {
  const item = value[field]
  if (item === undefined) return undefined
  if (typeof item !== 'number') throw invalidResponse(field)
  return item
}

/** Narrow one decoded preparation projection. */
function readPreparation(value: unknown): MeetingSpeechPreparation {
  if (typeof value !== 'object' || value === null) throw invalidResponse('speech preparation')
  const record = value as Record<string, unknown>
  const phase = record.phase
  if (typeof phase !== 'string') throw invalidResponse('speech preparation')
  const message = readOptionalString(record, 'message')
  const resource = readOptionalString(record, 'resource')
  const completedBytes = readOptionalNumber(record, 'completedBytes')
  const totalBytes = readOptionalNumber(record, 'totalBytes')
  return {
    phase,
    ...(message === undefined ? {} : { message }),
    ...(resource === undefined ? {} : { resource }),
    ...(completedBytes === undefined ? {} : { completedBytes }),
    ...(totalBytes === undefined ? {} : { totalBytes }),
  }
}

/** Read one provider entry of the speech status. */
function readProvider(value: unknown): MeetingSpeechStatus['providers'][number] {
  const id = readField(value, 'id')
  const name = readField(value, 'name')
  const phase = readField(value, 'phase')
  const preparation = readOptionalField(value, 'preparation')
  if (typeof id !== 'string' || typeof name !== 'string' || typeof phase !== 'string') {
    throw invalidResponse('speech provider')
  }
  return {
    id,
    name,
    phase,
    ...(preparation === undefined ? {} : { preparation: readPreparation(preparation) }),
  }
}

/** Whether one decoded value is a complete persisted answer. */
function isAnswer(value: unknown): value is AnswerView {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.meetingId === 'string'
    && typeof record.question === 'string' && typeof record.answer === 'string'
    && typeof record.createdAt === 'string'
}

/** Narrow one decoded speech status value. */
function readSpeech(value: unknown): MeetingSpeechStatus {
  if (typeof value !== 'object' || value === null) throw invalidResponse('speech status')
  const listed = readField(value, 'providers')
  const selected = readField(value, 'selected')
  if (!Array.isArray(listed) || typeof selected !== 'string') throw invalidResponse('speech status')
  return { providers: listed.map(readProvider), selected }
}

/** Recognized text of one recording, without a stored meeting. */
export interface MeetingTranscript {
  readonly text: string
  /** Speaker-attributed spans of `text`; absent when the provider reports no speakers. */
  readonly segments?: readonly MeetingSegmentBody[]
  readonly audioSeconds: number
}

/** Meeting operations the page calls, each resolving to a narrowed value. */
export interface MeetingApi {
  /** Read every stored meeting, newest first, without transcripts. */
  readonly list: (signal?: AbortSignal) => Promise<MeetingView[]>
  /** Read one meeting including its transcript. */
  readonly get: (id: string, signal?: AbortSignal) => Promise<MeetingView>
  /** Store one meeting from already-available transcript text. */
  readonly create: (body: MeetingCreateBody, signal?: AbortSignal) => Promise<MeetingView>
  /** Open one durable recording before any transcript exists. */
  readonly begin: (body: MeetingBeginBody, signal?: AbortSignal) => Promise<MeetingView>
  /** Replace the transcript one open recording has produced so far. */
  readonly update: (body: MeetingRecordingBody, signal?: AbortSignal) => Promise<MeetingView>
  /** Close one open recording with the transcript of its complete recording. */
  readonly finish: (body: MeetingRecordingBody, signal?: AbortSignal) => Promise<MeetingView>
  /** Replace the operator-editable fields of one stored meeting. */
  readonly revise: (body: MeetingReviseBody, signal?: AbortSignal) => Promise<MeetingView>
  /** Generate and persist the configured-model summary. */
  readonly summarize: (id: string, signal?: AbortSignal) => Promise<MeetingView>
  /** Delete one meeting and its stored answers. */
  readonly remove: (id: string, signal?: AbortSignal) => Promise<boolean>
  /** Recognize one recording without storing anything. */
  readonly transcribe: (audio: Blob, signal?: AbortSignal) => Promise<MeetingTranscript>
  /** Read the speech providers this deployment can transcribe with. */
  readonly speech: (signal?: AbortSignal) => Promise<MeetingSpeechStatus>
  /** Start or join one speech provider's preparation; omission targets the selection. */
  readonly prepare: (providerId: string | undefined, signal?: AbortSignal) => Promise<MeetingSpeechStatus>
  /** Cancel one speech provider's preparation; omission targets the selection. */
  readonly cancelPrepare: (providerId: string | undefined, signal?: AbortSignal) => Promise<MeetingSpeechStatus>
  /** Ask one meeting a question and store the exchange. */
  readonly ask: (id: string, question: string, signal?: AbortSignal) => Promise<AnswerView>
  /** Read one meeting's persisted answers, newest first. */
  readonly answers: (id: string, signal?: AbortSignal) => Promise<AnswerView[]>
  /** Transcribe one complete recording and store the resulting meeting. */
  readonly uploadAudio: (
    audio: Blob,
    request: { readonly title: string; readonly participants: readonly string[]; readonly language?: string },
    signal?: AbortSignal,
  ) => Promise<MeetingView>
}

/**
 * Build the page's meeting client over the page's own fetch.
 * @param doFetch - page fetch, injectable for tests.
 * @returns typed meeting operations.
 */
export function createMeetingApi(doFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)): MeetingApi {
  /** Read one envelope, turning its failure arm into a request error. */
  const readEnvelope = async (response: Response, endpoint: string): Promise<unknown> => {
    const body: unknown = await response.json()
    if (!isEnvelope(body)) throw invalidResponse(endpoint)
    if (!body.ok) throw new MeetingRequestError(body.error.code, body.error.message)
    return body.value
  }

  /** Send one JSON request and return its envelope value. */
  const postJson = async (endpoint: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
    const response = await doFetch(`${BASE}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    })
    return await readEnvelope(response, endpoint)
  }

  /** Send one raw-audio request and return its envelope value. */
  const postAudio = async (
    endpoint: string,
    audio: Blob,
    query: URLSearchParams | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const search = query === undefined ? '' : `?${query.toString()}`
    const response = await doFetch(`${BASE}/${endpoint}${search}`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: audio,
      ...(signal === undefined ? {} : { signal }),
    })
    return await readEnvelope(response, endpoint)
  }

  /** Read the meeting of one operation result. */
  const readMeeting = (value: unknown): MeetingView => {
    const meeting = readField(value, 'meeting')
    if (!isMeeting(meeting)) throw invalidResponse('meeting')
    return meeting
  }

  return {
    async list(signal) {
      const listed = readField(await postJson('list', {}, signal), 'meetings')
      if (!Array.isArray(listed) || !listed.every(isMeeting)) throw invalidResponse('meeting list')
      return listed
    },
    async get(id, signal) {
      return readMeeting(await postJson('get', { id }, signal))
    },
    async create(body, signal) {
      return readMeeting(await postJson('create', body, signal))
    },
    async begin(body, signal) {
      return readMeeting(await postJson('begin', body, signal))
    },
    async update(body, signal) {
      return readMeeting(await postJson('update', body, signal))
    },
    async finish(body, signal) {
      return readMeeting(await postJson('finish', body, signal))
    },
    async revise(body, signal) {
      return readMeeting(await postJson('revise', body, signal))
    },
    async summarize(id, signal) {
      return readMeeting(await postJson('summarize', { id }, signal))
    },
    async remove(id, signal) {
      const deleted = readField(await postJson('delete', { id }, signal), 'deleted')
      if (typeof deleted !== 'boolean') throw invalidResponse('delete result')
      return deleted
    },
    async transcribe(audio, signal) {
      const value = await postAudio('transcribe', audio, undefined, signal)
      const text = readField(value, 'text')
      const segments = readOptionalField(value, 'segments')
      const audioSeconds = readField(value, 'audioSeconds')
      if (typeof text !== 'string' || typeof audioSeconds !== 'number') throw invalidResponse('transcript')
      if (segments !== undefined && (!Array.isArray(segments) || !segments.every(isSegment))) {
        throw invalidResponse('transcript segments')
      }
      return {
        text,
        ...(segments === undefined ? {} : { segments: segments as MeetingSegmentBody[] }),
        audioSeconds,
      }
    },
    async speech(signal) {
      return readSpeech(readField(await postJson('speech', {}, signal), 'speech'))
    },
    async prepare(providerId, signal) {
      return readSpeech(readField(
        await postJson('speech/prepare', providerId === undefined ? {} : { providerId }, signal),
        'speech',
      ))
    },
    async cancelPrepare(providerId, signal) {
      return readSpeech(readField(
        await postJson('speech/cancel', providerId === undefined ? {} : { providerId }, signal),
        'speech',
      ))
    },
    async ask(id, question, signal) {
      const answer = readField(await postJson('ask', { id, question }, signal), 'answer')
      if (!isAnswer(answer)) throw invalidResponse('answer')
      return answer
    },
    async answers(id, signal) {
      const listed = readField(await postJson('answers', { id }, signal), 'answers')
      if (!Array.isArray(listed) || !listed.every(isAnswer)) throw invalidResponse('answer list')
      return listed
    },
    async uploadAudio(audio, request, signal) {
      const query = new URLSearchParams({ title: request.title })
      for (const participant of request.participants) query.append('participant', participant)
      if (request.language !== undefined && request.language.length > 0) query.set('language', request.language)
      return readMeeting(await postAudio('audio', audio, query, signal))
    },
  }
}
