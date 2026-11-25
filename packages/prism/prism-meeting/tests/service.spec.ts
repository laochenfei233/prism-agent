/** Behavior of durable meeting creation, retrieval, model updates, answers, deletion, audio, and disposal. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MeetingMinutesId } from '../src/types.ts'
import { disposeRoots, harness } from './harness.ts'

afterEach(disposeRoots)

/**
 * Complete model work, then cancel before the awaiting operation resumes.
 * @param text - Completed model response.
 * @param cancel - Caller cancellation callback.
 * @returns the model completion as a cancellation-aware awaitable.
 */
function completedThenCancel(text: string, cancel: () => void): PromiseLike<string> & { finally: () => PromiseLike<string> } {
  const completion = {
    then<TResult1 = string, TResult2 = never>(
      onFulfilled?: (value: string) => TResult1 | PromiseLike<TResult1>,
    ): PromiseLike<TResult1 | TResult2> {
      const settled = onFulfilled?.(text) ?? text
      cancel()
      return Promise.resolve(settled) as PromiseLike<TResult1 | TResult2>
    },
    finally(): PromiseLike<string> {
      return completion
    },
  }
  return completion
}

async function created(harnessOptions?: Parameters<typeof harness>[0]) {
  const suite = await harness(harnessOptions)
  const meeting = await suite.service.createFromTranscript({
    title: ' Planning ',
    participants: [' Alice ', '', 'Bob'],
    transcript: '  Delivery discussion.  ',
    audioSeconds: 3,
  })
  return { suite, meeting, ...suite }
}

describe('transcript meetings', () => {
  it('normalizes creation input, lists newest first, and returns detached records', async () => {
    const { suite, meeting } = await created()
    expect(meeting).toMatchObject({
      title: 'Planning',
      participants: ['Alice', 'Bob'],
      transcript: 'Delivery discussion.',
      summary: null,
      status: 'transcribed',
      audioSeconds: 3,
    })
    expect(Date.parse(meeting.createdAt)).not.toBeNaN()
    expect(meeting.updatedAt).toBe(meeting.createdAt)

    const newer = await suite.service.createFromTranscript({ title: 'Newer', transcript: 'Later.' })
    const listed = suite.service.list()
    expect(listed.map(record => record.title)).toEqual(['Newer', 'Planning'])
    expect(suite.service.list()).not.toBe(listed)
    expect(suite.service.get(meeting.id).title).toBe('Planning')
    expect(suite.service.get(newer.id)).toMatchObject({ status: 'transcribed', summary: null })
  })

  it('distinguishes persisted meetings and reports a missing id with the public error', async () => {
    const { suite } = await created()
    const missing = brandString<MeetingMinutesId>('missing')
    expect(suite.service.list()).toHaveLength(1)
    expect(() => suite.service.get(missing)).toThrow(`meeting meeting not found: ${missing}`)
  })

  it('persists records in the storage medium and reopens them in a later composition', async () => {
    const first = await created()
    const id = first.meeting.id
    await disposeRoots()
    const second = await harness({ pool: first.suite.pool })
    expect(second.service.get(id)).toMatchObject({ title: 'Planning', transcript: 'Delivery discussion.' })
  })
})

describe('meeting input validation', () => {
  it('rejects blank titles and transcripts before storage', async () => {
    const { suite } = await created()
    await expect(suite.service.createFromTranscript({ title: ' ', transcript: 'text' }))
      .rejects.toThrow('meeting title must be a nonempty string')
    await expect(suite.service.createFromTranscript({ title: 'title', transcript: ' ' }))
      .rejects.toThrow('meeting transcript must be a nonempty string')
    await expect(suite.service.ask(suite.service.list()[0]!.id, { question: ' ' }))
      .rejects.toThrow('meeting question must be a nonempty string')
    expect(suite.service.list()).toHaveLength(1)
  })

  it('rejects a negative audio duration before storage', async () => {
    const { suite } = await created()
    await expect(suite.service.createFromTranscript({ title: 'Negative', transcript: 'text', audioSeconds: -1 }))
      .rejects.toThrow('meeting audioSeconds must not be negative')
    expect(suite.service.list().map(record => record.title)).toEqual(['Planning'])
  })

  it('enforces the configured transcript bound after trimming', async () => {
    const suite = await harness({ maxTranscriptChars: 10 })
    await expect(suite.service.createFromTranscript({ title: 'too long', transcript: 'x'.repeat(11) }))
      .rejects.toThrow('meeting transcript exceeds 10 characters')
    await expect(suite.service.createFromTranscript({ title: 'exact', transcript: `  ${'x'.repeat(10)}  ` }))
      .resolves.toMatchObject({ transcript: 'x'.repeat(10) })
  })
})

describe('recording lifecycle', () => {
  it('opens a durable record with no transcript and lists it immediately', async () => {
    const suite = await harness()
    const opened = await suite.service.beginRecording({ title: ' Standup ', participants: [' Ada ', ''] })
    expect(opened).toMatchObject({
      title: 'Standup',
      participants: ['Ada'],
      transcript: '',
      summary: null,
      status: 'recording',
      audioSeconds: 0,
    })
    expect(suite.service.list().map(record => record.id)).toEqual([opened.id])
    await expect(suite.service.beginRecording({ title: '  ' }))
      .rejects.toThrow('meeting title must be a nonempty string')
  })

  it('replaces the transcript of an open recording and keeps the record listable', async () => {
    const suite = await harness()
    const opened = await suite.service.beginRecording({ title: 'Standup' })
    const advanced = await suite.service.updateRecording(opened.id, {
      transcript: ' First slice. ',
      audioSeconds: 8,
    })
    expect(advanced).toMatchObject({ transcript: 'First slice.', audioSeconds: 8, status: 'recording' })
    expect(Date.parse(advanced.updatedAt)).not.toBeNaN()

    await expect(suite.service.updateRecording(opened.id, { transcript: 'late', audioSeconds: -1 }))
      .rejects.toThrow('meeting audioSeconds must not be negative')
    await expect(
      suite.service.updateRecording(brandString<MeetingMinutesId>('missing'), { transcript: 'x', audioSeconds: 0 }),
    ).rejects.toThrow('meeting meeting not found: missing')
  })

  it('closes a recording with its complete transcript and rejects later live writes', async () => {
    const suite = await harness()
    const opened = await suite.service.beginRecording({ title: 'Standup' })
    await suite.service.updateRecording(opened.id, { transcript: 'Partial.', audioSeconds: 8 })
    const closed = await suite.service.finishRecording(opened.id, {
      transcript: 'Complete transcript.',
      audioSeconds: 12.5,
    })
    expect(closed).toMatchObject({ transcript: 'Complete transcript.', audioSeconds: 12.5, status: 'transcribed' })

    await expect(suite.service.updateRecording(opened.id, { transcript: 'late', audioSeconds: 1 }))
      .rejects.toThrow(`meeting ${opened.id} is not recording`)
    await expect(suite.service.finishRecording(opened.id, { transcript: 'late', audioSeconds: 1 }))
      .rejects.toThrow(`meeting ${opened.id} is not recording`)
  })

  it('closes a recording that recognized nothing', async () => {
    const suite = await harness()
    const opened = await suite.service.beginRecording({ title: 'Silent' })
    const closed = await suite.service.finishRecording(opened.id, { transcript: '  ', audioSeconds: 30 })
    expect(closed).toMatchObject({ transcript: '', status: 'transcribed', audioSeconds: 30 })
  })

  it('applies the configured transcript bound to a live write', async () => {
    const suite = await harness({ maxTranscriptChars: 10 })
    const opened = await suite.service.beginRecording({ title: 'Standup' })
    await expect(suite.service.updateRecording(opened.id, { transcript: 'x'.repeat(11), audioSeconds: 1 }))
      .rejects.toThrow('meeting transcript exceeds 10 characters')
    await expect(suite.service.finishRecording(opened.id, { transcript: 'x'.repeat(11), audioSeconds: 1 }))
      .rejects.toThrow('meeting transcript exceeds 10 characters')
  })

  it('refuses model operations until the recording ends', async () => {
    const suite = await harness()
    const opened = await suite.service.beginRecording({ title: 'Standup' })
    await expect(suite.service.summarize(opened.id)).rejects.toThrow(`meeting ${opened.id} is still recording`)
    await expect(suite.service.ask(opened.id, { question: 'What happened?' }))
      .rejects.toThrow(`meeting ${opened.id} is still recording`)
    expect(suite.llm.requests).toHaveLength(0)

    await suite.service.finishRecording(opened.id, { transcript: 'Decisions.', audioSeconds: 4 })
    suite.llm.queueText('Key decisions.')
    await expect(suite.service.summarize(opened.id)).resolves.toMatchObject({ summary: 'Key decisions.' })
  })

  it('revises the editable fields of a stored meeting', async () => {
    const { suite, meeting } = await created()
    const revised = await suite.service.reviseMeeting(meeting.id, {
      title: ' Sprint retro ',
      participants: [' Ada ', ''],
    })
    expect(revised).toMatchObject({ title: 'Sprint retro', participants: ['Ada'] })
    expect(suite.service.get(meeting.id).title).toBe('Sprint retro')

    const retitled = await suite.service.reviseMeeting(meeting.id, { title: 'Renamed' })
    expect(retitled).toMatchObject({ title: 'Renamed', participants: ['Ada'] })
    await expect(suite.service.reviseMeeting(meeting.id, {}))
      .rejects.toThrow('meeting revision must change the title or the participants')
    await expect(suite.service.reviseMeeting(meeting.id, { title: '  ' }))
      .rejects.toThrow('meeting title must be a nonempty string')
  })
})

describe('speaker spans', () => {
  it('stores the recognized speaker spans with their transcript', async () => {
    const suite = await harness()
    const meeting = await suite.service.createFromTranscript({
      title: 'Standup',
      transcript: 'Hi\nBye',
      segments: [{ text: 'Hi', speaker: '1' }, { text: 'Bye' }],
    })
    expect(meeting.transcriptSegments).toEqual([{ text: 'Hi', speaker: '1' }, { text: 'Bye' }])
    // The public record is detached, so a caller cannot mutate stored spans.
    expect(suite.service.get(meeting.id).transcriptSegments).not.toBe(meeting.transcriptSegments)
  })

  it('stores no spans for a caller that reports none', async () => {
    const { suite, meeting } = await created()
    expect(meeting.transcriptSegments).toBeUndefined()
    expect(suite.pool.media.get('meeting_minutes')!.tables.get('meetings')!.get(String(meeting.id)))
      .not.toHaveProperty('transcriptSegments')
  })

  it('rejects spans that do not reconstruct the transcript', async () => {
    const suite = await harness()
    await expect(suite.service.createFromTranscript({
      title: 'Broken',
      transcript: 'Hi\nBye',
      segments: [{ text: 'Hi' }],
    })).rejects.toThrow('meeting transcript segments must reconstruct the transcript')
    expect(suite.service.list()).toHaveLength(0)
  })

  it('carries spans through a live recording', async () => {
    const suite = await harness()
    const opened = await suite.service.beginRecording({ title: 'Standup' })
    await suite.service.updateRecording(opened.id, {
      transcript: 'First.',
      segments: [{ text: 'First.', speaker: '1' }],
      audioSeconds: 8,
    })
    const closed = await suite.service.finishRecording(opened.id, {
      transcript: 'First.\nSecond.',
      segments: [{ text: 'First.', speaker: '1' }, { text: 'Second.', speaker: '2' }],
      audioSeconds: 12,
    })
    expect(closed.transcriptSegments).toEqual([
      { text: 'First.', speaker: '1' },
      { text: 'Second.', speaker: '2' },
    ])
  })

  it('drops spans when a later write reports none', async () => {
    const suite = await harness()
    const opened = await suite.service.beginRecording({ title: 'Standup' })
    await suite.service.updateRecording(opened.id, {
      transcript: 'First.',
      segments: [{ text: 'First.', speaker: '1' }],
      audioSeconds: 8,
    })
    const closed = await suite.service.finishRecording(opened.id, {
      transcript: 'Complete transcript.',
      audioSeconds: 12,
    })
    expect(closed.transcriptSegments).toBeUndefined()
    expect(suite.service.get(opened.id).transcriptSegments).toBeUndefined()
  })
})

describe('summaries', () => {
  it('dispatches configured model routes and persists a successful summary', async () => {
    const { suite, meeting } = await created()
    suite.llm.queueText('Key decisions.')
    const summarized = await suite.service.summarize(meeting.id)
    expect(summarized).toMatchObject({ id: meeting.id, summary: 'Key decisions.', status: 'summarized' })
    expect(suite.llm.requests).toHaveLength(1)
    expect(suite.llm.requests[0]).toMatchObject({
      provider: 'meeting-provider',
      model: 'meeting-model',
      system: 'summarize meetings',
    })
    expect(suite.llm.requests[0]!.prompt).toContain(meeting.title)
    expect(suite.llm.requests[0]!.prompt).toContain(meeting.transcript)
    expect(suite.service.get(meeting.id)).toMatchObject({ summary: 'Key decisions.', status: 'summarized' })
  })

  it('leaves the meeting unchanged when the model finishes with an error', async () => {
    const { suite, meeting } = await created()
    suite.llm.queueFailure('model unavailable')
    await expect(suite.service.summarize(meeting.id)).rejects.toThrow('model unavailable')
    const stored = suite.pool.media.get('meeting_minutes')!.tables.get('meetings')!.get(String(meeting.id))
    expect(stored).toMatchObject({ summary: null, status: 'transcribed' })
    expect(suite.llm.requests).toHaveLength(1)
  })

  it('does not persist a summary cancelled after model completion', async () => {
    const { suite, meeting } = await created()
    const caller = new AbortController()
    Object.assign(suite.service, {
      completeText: () => completedThenCancel('Late summary.', () => {
        caller.abort(new Error('summary cancelled late'))
      }),
    })
    await expect(suite.service.summarize(meeting.id, caller.signal)).rejects.toThrow('summary cancelled late')
    const stored = suite.pool.media.get('meeting_minutes')!.tables.get('meetings')!.get(String(meeting.id))
    expect(stored).toMatchObject({ summary: null, status: 'transcribed' })
    expect(suite.llm.requests).toHaveLength(0)
  })

  it('rejects a missing meeting or already-cancelled call without dispatching', async () => {
    const { suite } = await created()
    const missing = brandString<MeetingMinutesId>('missing')
    await expect(suite.service.summarize(missing)).rejects.toThrow(`meeting meeting not found: ${missing}`)
    await expect(suite.service.summarize(suite.service.list()[0]!.id, AbortSignal.abort(new Error('caller cancelled'))))
      .rejects.toThrow('caller cancelled')
    expect(suite.llm.requests).toHaveLength(0)
  })
})

describe('answers', () => {
  it('persists questions and answers and returns them with their meeting', async () => {
    const { suite, meeting } = await created()
    suite.llm.queueText('Alice owns delivery.')
    const answer = await suite.service.ask(meeting.id, { question: ' Who owns delivery? ' })
    expect(answer).toMatchObject({
      meetingId: meeting.id,
      question: 'Who owns delivery?',
      answer: 'Alice owns delivery.',
    })
    expect(suite.llm.requests[0]).toMatchObject({ system: 'answer meeting questions' })
    expect(suite.llm.requests[0]!.prompt).toContain('Who owns delivery?')
    expect(suite.service.listAnswers(meeting.id)).toEqual([answer])
  })

  it('does not persist a failed answer or an answer for another meeting', async () => {
    const { suite, meeting } = await created()
    const other = await suite.service.createFromTranscript({ title: 'Other', transcript: 'Other discussion.' })
    suite.llm.queueFailure('answer failed')
    await expect(suite.service.ask(meeting.id, { question: 'What happened?' })).rejects.toThrow('answer failed')
    expect(suite.service.listAnswers(meeting.id)).toHaveLength(0)

    suite.llm.queueText('Other answer.')
    await suite.service.ask(other.id, { question: 'What happened?' })
    expect(suite.service.listAnswers(meeting.id)).toHaveLength(0)
    expect(suite.service.listAnswers(other.id)).toHaveLength(1)
  })

  it('does not persist an answer cancelled after model completion', async () => {
    const { suite, meeting } = await created()
    const caller = new AbortController()
    Object.assign(suite.service, {
      completeText: () => completedThenCancel('Late answer.', () => {
        caller.abort(new Error('answer cancelled late'))
      }),
    })
    await expect(suite.service.ask(meeting.id, { question: 'What happened?' }, caller.signal))
      .rejects.toThrow('answer cancelled late')
    expect(suite.service.listAnswers(meeting.id)).toHaveLength(0)
    expect(suite.llm.requests).toHaveLength(0)
  })

  it('rejects missing meetings and unknown answer reads', async () => {
    const { suite, meeting } = await created()
    const missingMeeting = brandString<MeetingMinutesId>('missing')
    expect(() => suite.service.listAnswers(missingMeeting)).toThrow(`meeting meeting not found: ${missingMeeting}`)
    await expect(suite.service.ask(missingMeeting, { question: 'question' }))
      .rejects.toThrow(`meeting meeting not found: ${missingMeeting}`)
    await suite.service.delete(meeting.id)
    expect(() => suite.service.listAnswers(meeting.id)).toThrow(`meeting meeting not found: ${meeting.id}`)
  })
})

describe('deletion', () => {
  it('deletes answers with the meeting and reports a second delete as absent', async () => {
    const { suite, meeting } = await created()
    suite.llm.queueText('answer')
    const answer = await suite.service.ask(meeting.id, { question: 'question' })
    await expect(suite.service.delete(meeting.id)).resolves.toBe(true)
    expect(() => suite.service.get(meeting.id)).toThrow(`meeting meeting not found: ${meeting.id}`)
    expect(suite.pool.media.get('meeting_minutes')!.tables.get('answers')!.has(String(answer.id))).toBe(false)
    await expect(suite.service.delete(meeting.id)).resolves.toBe(false)
  })

  it('keeps unrelated meetings and answers', async () => {
    const { suite, meeting } = await created()
    const kept = await suite.service.createFromTranscript({ title: 'Kept', transcript: 'Keep this.' })
    suite.llm.queueText('kept answer')
    await suite.service.ask(kept.id, { question: 'kept question' })
    await suite.service.delete(meeting.id)
    expect(suite.service.list().map(record => record.title)).toEqual(['Kept'])
    expect(suite.service.listAnswers(kept.id)).toHaveLength(1)
  })
})

describe('audio ingestion', () => {
  it('uses the resolved provider and preserves recognized text and duration', async () => {
    const { suite, recognize } = await created()
    const audio = new Uint8Array([1, 2, 3, 4])
    const meeting = await suite.service.createFromAudio({ title: 'Recording', audio })
    expect(recognize).toHaveBeenCalledOnce()
    expect(recognize.mock.calls[0]?.[0]).toMatchObject({ audio, language: 'auto' })
    expect(recognize.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
    expect(meeting).toMatchObject({
      title: 'Recording',
      transcript: 'recognized auto 4',
      audioSeconds: 12.5,
      status: 'transcribed',
    })
  })

  it('honors explicit speech provider and language selection', async () => {
    const { suite, recognize } = await created()
    await suite.service.createFromAudio({
      title: 'Chinese recording',
      audio: new Uint8Array([9]),
      language: 'zh',
      providerId: 'meeting-test',
    })
    expect(recognize.mock.calls[0]?.[0]).toMatchObject({ language: 'zh' })
  })

  it('rejects empty audio and pre-cancelled recognition without invoking speech', async () => {
    const { suite, recognize } = await created()
    await expect(suite.service.createFromAudio(
      { title: 'Cancelled empty', audio: new Uint8Array() },
      AbortSignal.abort(new Error('audio cancelled')),
    )).rejects.toThrow('audio cancelled')
    await expect(suite.service.createFromAudio({ title: 'Empty', audio: new Uint8Array() }))
      .rejects.toThrow('meeting audio must not be empty')
    await expect(suite.service.createFromAudio(
      { title: 'Cancelled', audio: new Uint8Array([1]) },
      AbortSignal.abort(new Error('audio cancelled')),
    )).rejects.toThrow('audio cancelled')
    expect(recognize).not.toHaveBeenCalled()
  })

  it('does not create a meeting when recognition fails', async () => {
    const { suite, recognize } = await created()
    recognize.mockRejectedValueOnce(new Error('offline'))
    await expect(suite.service.createFromAudio({ title: 'Offline', audio: new Uint8Array([1]) }))
      .rejects.toThrow('offline')
    expect(suite.service.list().map(record => record.title)).toEqual(['Planning'])
  })

  it('cancels an in-flight recognizer and does not create a meeting', async () => {
    const { suite, recognize } = await created()
    const caller = new AbortController()
    recognize.mockImplementationOnce((_input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('recognition cancelled')) }, { once: true })
    }))
    const pending = suite.service.createFromAudio(
      { title: 'Pending', audio: new Uint8Array([1]) },
      caller.signal,
    )
    await vi.waitFor(() => { expect(recognize).toHaveBeenCalledOnce() })
    caller.abort()
    await expect(pending).rejects.toThrow('recognition cancelled')
    expect(suite.service.list().map(record => record.title)).toEqual(['Planning'])
  })
})

describe('speech preparation', () => {
  it('prepares an unprepared provider before recognizing', async () => {
    const suite = await harness({ preparation: { initial: { phase: 'unprepared' } } })
    const stub = suite.preparation!
    stub.onPrepare = () => {
      stub.publish({ phase: 'checking', step: 'check', startedAt: Date.now() })
      queueMicrotask(() => { stub.publish({ phase: 'ready' }) })
    }
    const meeting = await suite.service.createFromAudio({ title: 'First run', audio: new Uint8Array([1]) })
    expect(stub.prepareCalls).toBe(1)
    expect(suite.recognize).toHaveBeenCalledOnce()
    expect(meeting).toMatchObject({ transcript: 'recognized auto 1', status: 'transcribed' })
  })

  it('joins an in-flight preparation without starting another', async () => {
    const suite = await harness({ preparation: { initial: { phase: 'checking', step: 'check', startedAt: 1 } } })
    const stub = suite.preparation!
    setTimeout(() => { stub.publish({ phase: 'ready' }) }, 5)
    const meeting = await suite.service.createFromAudio({ title: 'Joining', audio: new Uint8Array([1]) })
    expect(stub.prepareCalls).toBe(0)
    expect(suite.recognize).toHaveBeenCalledOnce()
    expect(meeting.transcript).toBe('recognized auto 1')
  })

  it('recognizes without preparing a ready provider', async () => {
    const suite = await harness({ preparation: { initial: { phase: 'ready' } } })
    await suite.service.createFromAudio({ title: 'Ready', audio: new Uint8Array([1]) })
    expect(suite.preparation!.prepareCalls).toBe(0)
    expect(suite.recognize).toHaveBeenCalledOnce()
  })

  it('rejects with the provider failure when preparation fails', async () => {
    const suite = await harness({ preparation: { initial: { phase: 'unprepared' } } })
    const stub = suite.preparation!
    stub.onPrepare = () => { stub.publish({ phase: 'failed', message: 'model download failed' }) }
    await expect(suite.service.createFromAudio({ title: 'Broken', audio: new Uint8Array([1]) }))
      .rejects.toThrow('model download failed')
    expect(suite.recognize).not.toHaveBeenCalled()
    expect(suite.service.list()).toEqual([])
  })

  it('rejects when the caller cancels while preparation runs', async () => {
    const suite = await harness({
      preparation: { initial: { phase: 'downloading', resource: 'model', completedBytes: 1 } },
    })
    const caller = new AbortController()
    const pending = suite.service.createFromAudio({ title: 'Waiting', audio: new Uint8Array([1]) }, caller.signal)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    caller.abort(new Error('stop waiting'))
    await expect(pending).rejects.toThrow('stop waiting')
    expect(suite.recognize).not.toHaveBeenCalled()
  })

  it('starts and cancels preparation through the service operations', async () => {
    const suite = await harness({ preparation: { initial: { phase: 'unprepared' } } })
    const stub = suite.preparation!
    stub.onPrepare = () => { stub.publish({ phase: 'downloading', resource: 'model', completedBytes: 5 }) }
    const started = suite.service.prepareSpeech()
    expect(stub.prepareCalls).toBe(1)
    expect(started.providers[0]).toMatchObject({
      id: 'meeting-test',
      phase: 'downloading',
      preparation: { phase: 'downloading', resource: 'model', completedBytes: 5 },
    })
    await suite.service.cancelSpeechPreparation('meeting-test')
    expect(stub.cancelCalls).toBe(1)
  })

  it('refuses a selection the speech seam cannot persist', async () => {
    const suite = await harness({ preparation: { initial: { phase: 'ready' } } })
    // The harness composes no settings entry, so the persisted write is the
    // refusal path; the delegate itself is one configure call away.
    await expect(suite.service.selectSpeech('meeting-test')).rejects.toThrow('Speech selection requires')
    expect(suite.service.speech().selected).toBe('meeting-test')
  })

  it('projects a failed preparation with its message', async () => {
    const suite = await harness({ preparation: { initial: { phase: 'failed', message: 'disk full' } } })
    expect(suite.service.speech().providers[0]).toMatchObject({
      phase: 'failed',
      preparation: { phase: 'failed', message: 'disk full' },
    })
  })
})

describe('disposal', () => {
  it('drains an in-flight summary, rejects its durable update, and leaves stored fields unchanged', async () => {
    const { suite, meeting } = await created()
    const gate = suite.llm.queueGate()
    const pending = suite.service.summarize(meeting.id)
    await vi.waitFor(() => { expect(suite.llm.requests).toHaveLength(1) })
    await suite.ctx.fiber.dispose()
    await expect(pending).rejects.toThrow('Meeting-minutes service disposed')
    const stored = suite.pool.media.get('meeting_minutes')!.tables.get('meetings')!.get(String(meeting.id))
    expect(stored).toMatchObject({ summary: null, status: 'transcribed' })
    gate.open()
  })

  it('cancels in-flight audio recognition and rejects the queued durable create', async () => {
    const { suite, recognize } = await created()
    recognize.mockImplementationOnce((_input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('service disposed')) }, { once: true })
    }))
    const pending = suite.service.createFromAudio({ title: 'Disposing', audio: new Uint8Array([1]) })
    await vi.waitFor(() => { expect(recognize).toHaveBeenCalledOnce() })
    await suite.ctx.fiber.dispose()
    await expect(pending).rejects.toThrow('service disposed')
    const stored = [...suite.pool.media.get('meeting_minutes')!.tables.get('meetings')!.values()]
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ title: 'Planning' })
  })

  it('rejects a mutation enqueued after disposal', async () => {
    const { suite } = await created()
    await suite.ctx.fiber.dispose()
    await expect(suite.service.createFromTranscript({ title: 'After disposal', transcript: 'No.' }))
      .rejects.toThrow('Meeting-minutes service disposed')
  })
})
