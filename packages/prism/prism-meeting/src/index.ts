/**
 * Durable meeting-minutes service (`ctx.meetingMinutes`): transcript/audio
 * ingestion, configured-model summaries, and persisted question/answer pairs.
 * @module @prism-ai/prism-meeting
 */

import { randomUUID } from 'node:crypto'
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type {
  SpeechPreparation, SpeechPreparationState, SpeechProvider, SpeechProviderId,
} from '@deepseek-ai/dsh-speech-to-text'
import { meetingMinutesDomainSpec } from './spec.ts'
import type { StoredMeetingAnswerRecord, StoredMeetingMinutesRecord } from './spec.ts'
import type {
  AskMeetingMinutesRequest, BeginMeetingRecordingRequest, CreateMeetingFromAudioRequest,
  CreateMeetingFromTranscriptRequest, FinishMeetingRecordingRequest,
  MeetingAnswerId, MeetingAnswerRecord, MeetingMinutesId, MeetingMinutesRecord, MeetingMinutesStatus,
  MeetingSpeechPreparation, MeetingSpeechProvider, MeetingSpeechStatus, MeetingTranscript,
  MeetingTranscriptSegment, ReviseMeetingMinutesRequest, UpdateMeetingRecordingRequest,
} from './types.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

export type * from './types.ts'
export { meetingAnswerRecord, meetingMinutesDomainSpec, meetingMinutesRecord, meetingTranscriptSegment } from './spec.ts'
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
  const { sequence: _sequence, transcriptSegments, ...meeting } = record
  return {
    ...meeting,
    participants: [...meeting.participants],
    ...transcriptSegments === undefined
      ? {}
      : { transcriptSegments: transcriptSegments.map(segment => ({ ...segment })) },
  }
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
 * Project the preparation facts a browser caller renders beyond the phase.
 * @param state - One provider's current preparation state.
 * @returns the projection, or undefined when the phase carries nothing extra.
 */
function preparationView(state: SpeechPreparationState): MeetingSpeechPreparation | undefined {
  if (state.phase === 'failed') return { phase: state.phase, message: state.message }
  if (state.phase === 'downloading') {
    return {
      phase: state.phase,
      resource: state.resource,
      completedBytes: state.completedBytes,
      ...(state.totalBytes === undefined ? {} : { totalBytes: state.totalBytes }),
    }
  }
  return undefined
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
      if (request.audioSeconds !== undefined) this.requireAudioSeconds(request.audioSeconds)
      const transcript = this.requireTranscript(request.transcript)
      const segments = this.normalizeSegments(request.segments, transcript)
      operationSignal.throwIfAborted()
      const now = new Date().toISOString()
      const record: StoredMeetingMinutesRecord = {
        id: brandString<MeetingMinutesId>(randomUUID()),
        title: request.title.trim(),
        participants: normalizeParticipants(request.participants),
        transcript,
        ...(segments === undefined ? {} : { transcriptSegments: segments }),
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
   * Open one durable recording before any transcript exists, so a caller can
   * list and follow the meeting while its microphone is still open.
   * @param request - Title and optional participants known when recording starts.
   * @param signal - Caller cancellation before the durable write.
   * @returns the durable record after storage settles.
   */
  beginRecording(
    request: BeginMeetingRecordingRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<MeetingMinutesRecord> {
    return this.enqueueOperation(async (serviceSignal) => {
      const operationSignal = AbortSignal.any([serviceSignal, signal])
      operationSignal.throwIfAborted()
      const title = request.title.trim()
      if (title.length === 0) throw new Error('meeting title must be a nonempty string')
      const now = new Date().toISOString()
      const record: StoredMeetingMinutesRecord = {
        id: brandString<MeetingMinutesId>(randomUUID()),
        title,
        participants: normalizeParticipants(request.participants),
        transcript: '',
        summary: null,
        status: 'recording',
        audioSeconds: 0,
        sequence: this.nextSequence++,
        createdAt: now,
        updatedAt: now,
      }
      await this.requireTables().meetings.put(record.id, record)
      return toPublicMeeting(record)
    })
  }

  /**
   * Replace the transcript one open recording has produced so far, so a reload
   * or a second reader follows the meeting without the caller's live buffer.
   * @param id - The meeting id.
   * @param request - Complete recognized text so far and its audio duration.
   * @param signal - Caller cancellation before the durable write.
   * @returns the durable record after storage settles.
   * @throws when the meeting is absent or is no longer recording.
   */
  updateRecording(
    id: MeetingMinutesId,
    request: UpdateMeetingRecordingRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<MeetingMinutesRecord> {
    return this.writeRecording(id, request, undefined, signal)
  }

  /**
   * Close one open recording with the transcript of its complete recording, so
   * the record becomes readable by the summary and question operations.
   * @param id - The meeting id.
   * @param request - Complete transcript and recognized-audio duration.
   * @param signal - Caller cancellation before the durable write.
   * @returns the durable record after storage settles.
   * @throws when the meeting is absent or is no longer recording.
   */
  finishRecording(
    id: MeetingMinutesId,
    request: FinishMeetingRecordingRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<MeetingMinutesRecord> {
    return this.writeRecording(id, request, 'transcribed', signal)
  }

  /**
   * Write one open recording's recognized text and duration, optionally closing it.
   * @param id - The meeting id.
   * @param request - Complete recognized text and its audio duration.
   * @param status - The status a closing write sets; omission keeps the recording open.
   * @param signal - Caller cancellation before the durable write.
   * @returns the durable record after storage settles.
   */
  private writeRecording(
    id: MeetingMinutesId,
    request: UpdateMeetingRecordingRequest,
    status: MeetingMinutesStatus | undefined,
    signal: AbortSignal,
  ): Promise<MeetingMinutesRecord> {
    return this.enqueueOperation(async (serviceSignal) => {
      const operationSignal = AbortSignal.any([serviceSignal, signal])
      operationSignal.throwIfAborted()
      this.requireRecording(id)
      const audioSeconds = this.requireAudioSeconds(request.audioSeconds)
      // A recording that recognized nothing is still a meeting the operator held.
      const transcript = this.boundTranscript(request.transcript)
      const segments = this.normalizeSegments(request.segments, transcript)
      operationSignal.throwIfAborted()
      const next = await this.requireTables().meetings.update(id, record => ({
        ...record,
        transcript,
        ...(segments === undefined ? { transcriptSegments: undefined } : { transcriptSegments: segments }),
        ...(status === undefined ? {} : { status }),
        audioSeconds,
        updatedAt: new Date().toISOString(),
      }))
      return toPublicMeeting(next)
    })
  }

  /**
   * Revise the operator-editable fields of any stored meeting, so a title the
   * recorder generated can be replaced once the meeting is known.
   * @param id - The meeting id.
   * @param request - Title and participant names to replace; each omission keeps the stored value.
   * @param signal - Caller cancellation before the durable write.
   * @returns the durable record after storage settles.
   */
  reviseMeeting(
    id: MeetingMinutesId,
    request: ReviseMeetingMinutesRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<MeetingMinutesRecord> {
    return this.enqueueOperation(async (serviceSignal) => {
      const operationSignal = AbortSignal.any([serviceSignal, signal])
      operationSignal.throwIfAborted()
      if (request.title === undefined && request.participants === undefined) {
        throw new Error('meeting revision must change the title or the participants')
      }
      this.requireMeeting(id)
      const title = request.title?.trim()
      if (title !== undefined && title.length === 0) throw new Error('meeting title must be a nonempty string')
      const participants = request.participants === undefined
        ? undefined
        : normalizeParticipants(request.participants)
      operationSignal.throwIfAborted()
      const next = await this.requireTables().meetings.update(id, record => ({
        ...record,
        ...(title === undefined ? {} : { title }),
        ...(participants === undefined ? {} : { participants }),
        updatedAt: new Date().toISOString(),
      }))
      return toPublicMeeting(next)
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
    const transcript = await this.transcribe(request.audio, signal, request.providerId, request.language)
    return this.createFromTranscript({
      title: request.title,
      ...(request.participants === undefined ? {} : { participants: request.participants }),
      transcript: transcript.text,
      ...(transcript.segments === undefined ? {} : { segments: transcript.segments }),
      audioSeconds: transcript.audioSeconds,
    }, signal)
  }

  /**
   * Transcribe one complete recording with the explicitly resolved speech
   * provider without storing a meeting, so a caller can show recognized text
   * while it is still capturing audio.
   * @param audio - Complete canonical WAV recording.
   * @param signal - Caller cancellation for recognition.
   * @param providerId - Speech provider id; omission uses the speech plugin's selection.
   * @param language - Speech language hint; omission uses the speech plugin's selection.
   * @returns the recognized text and its audio duration.
   */
  async transcribe(
    audio: Uint8Array,
    signal: AbortSignal = new AbortController().signal,
    providerId?: string,
    language?: string,
  ): Promise<MeetingTranscript> {
    this.lifetime.signal.throwIfAborted()
    signal.throwIfAborted()
    if (audio.byteLength === 0) throw new Error('meeting audio must not be empty')
    const spec = this.ctx.speechToText.resolve({
      audio,
      ...(providerId === undefined ? {} : { providerId: brandString<SpeechProviderId>(providerId) }),
      ...(language === undefined ? {} : { language }),
    })
    const operationSignal = AbortSignal.any([this.lifetime.signal, signal])
    await this.awaitSpeechReady(spec.provider, operationSignal)
    const transcript = await this.track(this.ctx.speechToText.transcribe(spec, operationSignal))
    signal.throwIfAborted()
    return {
      text: transcript.text,
      ...(transcript.segments === undefined
        ? {}
        : { segments: transcript.segments.map(segment => ({ ...segment })) }),
      audioSeconds: transcript.audioSeconds,
    }
  }

  /**
   * Report the speech providers this deployment can transcribe with, so a
   * caller can tell an operator that recording needs a speech plugin before it
   * asks for a microphone.
   * @returns the registered providers, the default selection, and preparation progress.
   */
  speech(): MeetingSpeechStatus {
    const snapshot = this.ctx.speechToText.snapshot()
    return {
      providers: snapshot.providers.map((view): MeetingSpeechProvider => {
        const preparation = preparationView(view.preparation)
        return {
          id: view.id,
          name: view.name,
          phase: view.preparation.phase,
          languages: [...view.languages],
          ...(preparation === undefined ? {} : { preparation }),
        }
      }),
      selected: snapshot.selection.providerId,
      language: snapshot.selection.language,
    }
  }

  /**
   * Start or join preparation of one speech provider, so an operator readies a
   * local model from the meeting page instead of another surface.
   * @param providerId - provider to prepare; omission prepares the selection.
   * @returns fresh speech status after the request.
   */
  prepareSpeech(providerId?: string): MeetingSpeechStatus {
    this.ctx.speechToText.prepare(this.speechProviderId(providerId))
    return this.speech()
  }

  /**
   * Cancel one provider's in-flight preparation.
   * @param providerId - provider to cancel; omission cancels the selection.
   * @returns fresh speech status after cancellation settles.
   */
  async cancelSpeechPreparation(providerId?: string): Promise<MeetingSpeechStatus> {
    await this.ctx.speechToText.cancelPreparation(this.speechProviderId(providerId))
    return this.speech()
  }

  /**
   * Persist one recognizer as the deployment's speech selection, so the
   * operator picks a cloud or HTTP provider from the meeting page instead of
   * being steered at the local model.
   * @param providerId - registered provider to select.
   * @param language - language hint to persist; omission keeps the stored one.
   * @returns fresh speech status after the selection settles.
   */
  async selectSpeech(providerId: string, language?: string): Promise<MeetingSpeechStatus> {
    await this.ctx.speechToText.configure({
      providerId: brandString<SpeechProviderId>(providerId),
      ...(language === undefined ? {} : { language }),
    })
    return this.speech()
  }

  /** Resolve a speech-status request's provider id against the default selection. */
  private speechProviderId(providerId: string | undefined): SpeechProviderId {
    const id = providerId ?? this.ctx.speechToText.snapshot().selection.providerId
    return brandString<SpeechProviderId>(id)
  }

  /**
   * Hold one transcription until its provider can recognize audio. Providers
   * without preparation control are immediately usable; an unprepared, failed,
   * or cancelled provider starts its preparation first, and every other phase
   * joins the in-flight task.
   * @param provider - the resolved transcription provider.
   * @param signal - operation cancellation.
   */
  private async awaitSpeechReady(provider: SpeechProvider, signal: AbortSignal): Promise<void> {
    const preparation = provider.preparation
    if (preparation === undefined) return
    const phase = preparation.snapshot().phase
    if (phase === 'ready' || phase === 'standby') return
    if (phase === 'unprepared' || phase === 'failed' || phase === 'cancelled') preparation.prepare()
    await this.waitForSpeechPreparation(preparation, signal)
  }

  /**
   * Wait until one provider's preparation reaches a transcribable state.
   * @param preparation - the provider's preparation control.
   * @param signal - operation cancellation.
   * @throws the provider's failure message on a failed preparation, and on cancellation.
   */
  private waitForSpeechPreparation(preparation: SpeechPreparation, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const detach = (): void => {
        unsubscribe()
        signal.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        detach()
        reject(signal.reason instanceof Error ? signal.reason : new Error('Speech preparation wait cancelled'))
      }
      const check = (): void => {
        const state = preparation.snapshot()
        if (state.phase === 'ready' || state.phase === 'standby') {
          detach()
          resolve()
          return
        }
        if (state.phase === 'failed') {
          detach()
          reject(new Error(state.message))
          return
        }
        if (state.phase === 'cancelled') {
          detach()
          reject(new Error('Speech preparation was cancelled'))
        }
      }
      const unsubscribe = preparation.subscribe(check)
      signal.addEventListener('abort', onAbort, { once: true })
      check()
    })
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
   * @throws when the meeting is still recording, because a leading fragment is not a meeting to summarize.
   */
  summarize(id: MeetingMinutesId, signal: AbortSignal = new AbortController().signal): Promise<MeetingMinutesRecord> {
    return this.enqueueOperation(async (serviceSignal) => {
      const operationSignal = AbortSignal.any([serviceSignal, signal])
      operationSignal.throwIfAborted()
      const current = this.requireFinished(id)
      const summary = await this.track(this.completeText(
        `Meeting title: ${current.title}\n\nMeeting transcript:\n${current.transcript}`,
        operationSignal,
        this.config.summarySystemPrompt.get(),
      ))
      operationSignal.throwIfAborted()
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
   * @throws when the meeting is still recording, because a leading fragment is not a meeting to question.
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
      const meeting = this.requireFinished(id)
      const answerText = await this.track(this.completeText(
        `Meeting title: ${meeting.title}\n\nMeeting transcript:\n${meeting.transcript}\n\nQuestion: ${question}`,
        operationSignal,
        this.config.answerSystemPrompt.get(),
      ))
      operationSignal.throwIfAborted()
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

  /** Read one meeting whose microphone is still open, so only a recording accepts its own writes. */
  private requireRecording(id: MeetingMinutesId): StoredMeetingMinutesRecord {
    const record = this.requireMeeting(id)
    if (record.status !== 'recording') throw new Error(`meeting ${id} is not recording`)
    return record
  }

  /** Read one meeting with a complete transcript, which the model operations require. */
  private requireFinished(id: MeetingMinutesId): StoredMeetingMinutesRecord {
    const record = this.requireMeeting(id)
    if (record.status === 'recording') throw new Error(`meeting ${id} is still recording`)
    return record
  }

  /** Apply the configured transcript bound at the owning operation. */
  private boundTranscript(transcript: string): string {
    const normalized = transcript.trim()
    const maxChars = this.config.maxTranscriptChars.get()
    if (normalized.length > maxChars) {
      throw new Error(`meeting transcript exceeds ${maxChars} characters`)
    }
    return normalized
  }

  /** Apply the configured transcript bound, then require the text a complete import cannot lack. */
  private requireTranscript(transcript: string): string {
    const normalized = this.boundTranscript(transcript)
    if (normalized.length === 0) throw new Error('meeting transcript must be a nonempty string')
    return normalized
  }

  /**
   * Validate and detach the speaker spans of one transcript. The spans must
   * reconstruct the transcript, so the record never holds two disagreeing forms
   * of the same recognition.
   * @param segments - caller spans in recognition order, or undefined for a caller with no speaker information.
   * @param transcript - the bounded transcript those spans must rebuild.
   * @returns detached spans, or undefined when the caller reported none.
   */
  private normalizeSegments(
    segments: readonly MeetingTranscriptSegment[] | undefined,
    transcript: string,
  ): MeetingTranscriptSegment[] | undefined {
    if (segments === undefined || segments.length === 0) return undefined
    const detached = segments.map(segment => ({
      text: segment.text,
      ...(segment.speaker === undefined ? {} : { speaker: segment.speaker }),
    }))
    if (detached.map(segment => segment.text).join('\n') !== transcript) {
      throw new Error('meeting transcript segments must reconstruct the transcript')
    }
    return detached
  }

  /** Reject a negative recorded duration before it reaches storage. */
  private requireAudioSeconds(audioSeconds: number): number {
    if (audioSeconds < 0) throw new Error('meeting audioSeconds must not be negative')
    return audioSeconds
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
