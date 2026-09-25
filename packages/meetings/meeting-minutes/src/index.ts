/**
 * Durable meeting-minutes service (`ctx.meetingMinutes`): transcript/audio
 * ingestion, configured-model summaries, and persisted question/answer pairs.
 * @module @deepseek-ai/dsh-meeting-minutes
 */

import { randomUUID } from 'node:crypto'
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SpeechProviderId } from '@deepseek-ai/dsh-speech-to-text'
import { meetingMinutesDomainSpec } from './spec.ts'
import type { StoredMeetingAnswerRecord, StoredMeetingMinutesRecord } from './spec.ts'
import type {
  AskMeetingMinutesRequest, CreateMeetingFromAudioRequest, CreateMeetingFromTranscriptRequest,
  MeetingAnswerId, MeetingAnswerRecord, MeetingMinutesId, MeetingMinutesRecord,
} from './types.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

export type * from './types.ts'
export { meetingAnswerRecord, meetingMinutesDomainSpec, meetingMinutesRecord } from './spec.ts'
export type { StoredMeetingAnswerRecord, StoredMeetingMinutesRecord } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable meeting records and configured-model meeting analysis. */
    meetingMinutes: MeetingMinutesService
  }
}

/** Deployment-owned model and bound choices; there are no service-level model defaults. */
export interface Config {
  /** Registered LLM provider used for summaries and meeting questions. */
  summaryProvider: Volatile<string>
  /** Registered model id used for summaries and meeting questions. */
  summaryModel: Volatile<string>
  /** System prompt that establishes summary behavior. */
  summarySystemPrompt: Volatile<string>
  /** System prompt that establishes meeting-question behavior. */
  answerSystemPrompt: Volatile<string>
  /** Maximum accepted transcript length in Unicode code units. */
  maxTranscriptChars: Volatile<number>
}

/** A meeting or answer operation named an id absent from durable storage. */
export class MeetingMinutesNotFoundError extends Error {
  /**
   * @param id - The unknown meeting id.
   * @param kind - The missing resource family.
   */
  constructor(readonly id: MeetingMinutesId | MeetingAnswerId, readonly kind: 'meeting' | 'answer') {
    super(`meeting ${kind} not found: ${id}`)
    this.name = 'MeetingMinutesNotFoundError'
  }
}

/**
 * Build a detached public record from its durable representation.
 * @param record - The stored record.
 * @returns the same fields with public readonly collection types.
 */
function toPublicMeeting(record: StoredMeetingMinutesRecord): MeetingMinutesRecord {
  const { sequence: _sequence, ...meeting } = record
  return { ...meeting, participants: [...meeting.participants] }
}

/**
 * Build a detached public answer from its durable representation.
 * @param record - The stored answer.
 * @returns the answer fields without the storage ordering sequence.
 */
function toPublicAnswer(record: StoredMeetingAnswerRecord): MeetingAnswerRecord {
  const { sequence: _sequence, ...answer } = record
  return answer
}

/**
 * Normalize an ordered participant list to nonempty display names.
 * @param participants - Caller-supplied names.
 * @returns normalized names in caller order.
 */
function normalizeParticipants(participants: readonly string[] | undefined): string[] {
  return (participants ?? []).map(name => name.trim()).filter(name => name.length > 0)
}

/**
 * Consume a model stream and concatenate its visible text deltas.
 * @param stream - The adapter-owned chunk stream.
 * @param signal - Operation cancellation.
 * @returns the complete nonempty text response.
 */
async function collectText(stream: AsyncIterable<StreamChunk>, signal: AbortSignal): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish' && (chunk.reason.kind === 'aborted' || chunk.reason.kind === 'error')) {
      throw new Error(chunk.reason.failure.message)
    }
  }
  signal.throwIfAborted()
  if (text.length === 0) throw new Error('the model returned no text for the meeting request')
  return text
}

/** Durable meeting service. Mutations serialize so dependent deletes and answers remain consistent. */
export default class MeetingMinutesService extends Service {
  /** Services required before durable or model-backed meeting work can activate. */
  static inject = ['storageDomain', 'speechToText', 'llm']

  /** Required deployment-owned model and transcript-bound choices. */
  static Config = z.object({
    summaryProvider: z.string().min(1).required().volatile(),
    summaryModel: z.string().min(1).required().volatile(),
    summarySystemPrompt: z.string().min(1).required().volatile(),
    answerSystemPrompt: z.string().min(1).required().volatile(),
    maxTranscriptChars: z.number().step(1).min(1).required().volatile(),
  })

  private meetings?: KvTable<MeetingMinutesId, StoredMeetingMinutesRecord>
  private answers?: KvTable<MeetingAnswerId, StoredMeetingAnswerRecord>
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private operationTail: Promise<void> = Promise.resolve()
  private nextSequence = 1

  /**
   * @param ctx - Registrant context carrying storage, speech, and LLM services.
   * @param config - Validated deployment-owned model and bound choices.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'meetingMinutes')
  }

  /** Open the durable domain and register ordered service teardown. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(meetingMinutesDomainSpec)
    this.meetings = domain.table('meetings')
    this.answers = domain.table('answers')
    this.nextSequence = Math.max(0, ...[...domain.table('meetings').entries(), ...domain.table('answers').entries()]
      .map(([, record]) => record.sequence)) + 1
    this.ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Meeting-minutes service disposed'))
      await this.operationTail
      await Promise.allSettled([...this.pending])
      await domain.close()
    }, 'meetingMinutes.domainClose')
  }

  /**
   * Create a meeting from text without invoking speech recognition.
   * @param request - Title, optional participants, transcript, and audio duration.
   * @param signal - Caller cancellation before the durable write.
   * @returns the durable record after storage settles.
   */
  createFromTranscript(
    request: CreateMeetingFromTranscriptRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<MeetingMinutesRecord> {
    return this.enqueueOperation(async (serviceSignal) => {
      const operationSignal = AbortSignal.any([serviceSignal, signal])
      operationSignal.throwIfAborted()
      const transcript = this.normalizeTranscript(request.transcript)
      const now = new Date().toISOString()
      const record: StoredMeetingMinutesRecord = {
        id: brandString<MeetingMinutesId>(randomUUID()),
        title: request.title.trim(),
        participants: normalizeParticipants(request.participants),
        transcript,
        summary: null,
        status: 'transcribed',
        audioSeconds: request.audioSeconds ?? 0,
        sequence: this.nextSequence++,
        createdAt: now,
        updatedAt: now,
      }
      if (record.title.length === 0) throw new Error('meeting title must be a nonempty string')
      await this.requireTables().meetings.put(record.id, record)
      return toPublicMeeting(record)
    })
  }

  /**
   * Transcribe one complete recording with the explicitly resolved speech provider,
   * then persist its text as a new meeting.
   * @param request - Title, optional participants, complete WAV audio, and optional speech selection.
   * @param signal - Caller cancellation for recognition and the durable write.
   * @returns the durable record after transcription and storage settle.
   */
  async createFromAudio(
    request: CreateMeetingFromAudioRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<MeetingMinutesRecord> {
    this.lifetime.signal.throwIfAborted()
    if (request.audio.byteLength === 0) throw new Error('meeting audio must not be empty')
    const speechRequest = {
      audio: request.audio,
      ...(request.providerId === undefined ? {} : { providerId: brandString<SpeechProviderId>(request.providerId) }),
      ...(request.language === undefined ? {} : { language: request.language }),
    }
    const spec = this.ctx.speechToText.resolve(speechRequest)
    const operationSignal = AbortSignal.any([this.lifetime.signal, signal])
    const transcript = await this.track(this.ctx.speechToText.transcribe(spec, operationSignal))
    return this.createFromTranscript({
      title: request.title,
      ...(request.participants === undefined ? {} : { participants: request.participants }),
      transcript: transcript.text,
      audioSeconds: transcript.audioSeconds,
    }, signal)
  }

  /**
   * Read meetings in newest-first creation order.
   * @returns a fresh array of public records.
   */
  list(): MeetingMinutesRecord[] {
    return [...this.requireTables().meetings.entries()]
      .map(([, record]) => record)
      .sort((left, right) => right.sequence - left.sequence)
      .map(toPublicMeeting)
  }

  /**
   * Read one meeting.
   * @param id - The meeting id.
   * @returns the public record.
   */
  get(id: MeetingMinutesId): MeetingMinutesRecord {
    const record = this.requireTables().meetings.get(id)
    if (record === undefined) throw new MeetingMinutesNotFoundError(id, 'meeting')
    return toPublicMeeting(record)
  }

  /**
   * Generate and persist the meeting summary. A model or cancellation failure leaves
   * the existing record unchanged.
   * @param id - The meeting id.
   * @param signal - Caller cancellation for the model call and durable write.
   * @returns the summarized record.
   */
  summarize(id: MeetingMinutesId, signal: AbortSignal = new AbortController().signal): Promise<MeetingMinutesRecord> {
    return this.enqueueOperation(async (serviceSignal) => {
      const operationSignal = AbortSignal.any([serviceSignal, signal])
      operationSignal.throwIfAborted()
      const current = this.requireMeeting(id)
      const summary = await this.track(this.completeText(
        `Meeting title: ${current.title}\n\nMeeting transcript:\n${current.transcript}`,
        operationSignal,
        this.config.summarySystemPrompt.get(),
      ))
      const next = await this.requireTables().meetings.update(id, record => ({
        ...record,
        summary,
        status: 'summarized',
        updatedAt: new Date().toISOString(),
      }))
      return toPublicMeeting(next)
    })
  }

  /**
   * Ask one question about a meeting, return its answer, and persist the exchange.
   * @param id - The meeting id.
   * @param request - The nonempty question.
   * @param signal - Caller cancellation for the model call and durable write.
   * @returns the durable answer record.
   */
  ask(
    id: MeetingMinutesId,
    request: AskMeetingMinutesRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<MeetingAnswerRecord> {
    return this.enqueueOperation(async (serviceSignal) => {
      const operationSignal = AbortSignal.any([serviceSignal, signal])
      operationSignal.throwIfAborted()
      const question = request.question.trim()
      if (question.length === 0) throw new Error('meeting question must be a nonempty string')
      const meeting = this.requireMeeting(id)
      const answerText = await this.track(this.completeText(
        `Meeting title: ${meeting.title}\n\nMeeting transcript:\n${meeting.transcript}\n\nQuestion: ${question}`,
        operationSignal,
        this.config.answerSystemPrompt.get(),
      ))
      const record: StoredMeetingAnswerRecord = {
        id: brandString<MeetingAnswerId>(randomUUID()),
        meetingId: id,
        question,
        answer: answerText,
        sequence: this.nextSequence++,
        createdAt: new Date().toISOString(),
      }
      await this.requireTables().answers.put(record.id, record)
      return toPublicAnswer(record)
    })
  }

  /**
   * Read answers for one meeting in newest-first creation order.
   * @param id - The meeting id.
   * @returns a fresh array of answer records.
   */
  listAnswers(id: MeetingMinutesId): MeetingAnswerRecord[] {
    this.requireMeeting(id)
    return [...this.requireTables().answers.entries()]
      .map(([, record]) => record)
      .filter(record => record.meetingId === id)
      .sort((left, right) => right.sequence - left.sequence)
      .map(toPublicAnswer)
  }

  /**
   * Delete one meeting and all of its answers. Answer deletion precedes meeting deletion,
   * so a failed answer write cannot orphan a missing meeting.
   * @param id - The meeting id.
   * @returns `true` when the meeting existed, or `false` when it was already absent.
   */
  delete(id: MeetingMinutesId): Promise<boolean> {
    return this.enqueueOperation(async () => {
      const tables = this.requireTables()
      if (tables.meetings.get(id) === undefined) return false
      for (const [answerId, answer] of [...tables.answers.entries()]) {
        if (answer.meetingId === id) await tables.answers.delete(answerId)
      }
      return await tables.meetings.delete(id)
    })
  }

  /** Serialize one mutation behind prior operations and include it in disposal settlement. */
  private enqueueOperation<T>(operation: (serviceSignal: AbortSignal) => Promise<T>): Promise<T> {
    const serviceSignal = this.lifetime.signal
    const job = async (): Promise<T> => {
      serviceSignal.throwIfAborted()
      return await operation(serviceSignal)
    }
    const result = this.operationTail.then(job, job)
    this.operationTail = result.then(() => undefined, () => undefined)
    return this.track(result)
  }

  /** Track an operation so disposal can wait for its settlement. */
  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => { this.pending.delete(tracked) })
    this.pending.add(tracked)
    return tracked
  }

  /** Resolve the typed tables opened at activation. */
  private requireTables(): {
    meetings: KvTable<MeetingMinutesId, StoredMeetingMinutesRecord>
    answers: KvTable<MeetingAnswerId, StoredMeetingAnswerRecord>
  } {
    if (this.meetings === undefined || this.answers === undefined) {
      throw new Error('meeting-minutes storage is not open')
    }
    return { meetings: this.meetings, answers: this.answers }
  }

  /** Read one meeting or fail with the public not-found error. */
  private requireMeeting(id: MeetingMinutesId): StoredMeetingMinutesRecord {
    const record = this.requireTables().meetings.get(id)
    if (record === undefined) throw new MeetingMinutesNotFoundError(id, 'meeting')
    return record
  }

  /** Apply the configured transcript bound at the owning operation. */
  private normalizeTranscript(transcript: string): string {
    const normalized = transcript.trim()
    if (normalized.length === 0) throw new Error('meeting transcript must be a nonempty string')
    const maxChars = this.config.maxTranscriptChars.get()
    if (normalized.length > maxChars) {
      throw new Error(`meeting transcript exceeds ${maxChars} characters`)
    }
    return normalized
  }

  /** Dispatch one configured one-shot model request and collect its text response. */
  private async completeText(userText: string, signal: AbortSignal, system: string): Promise<string> {
    const provider = this.config.summaryProvider.get()
    const model = this.config.summaryModel.get()
    const prepared = await this.ctx.llm.prepareCall({ provider, model }, signal)
    return await collectText(prepared.stream({
      provider,
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      signal,
    }), signal)
  }
}

export { MeetingMinutesService }
