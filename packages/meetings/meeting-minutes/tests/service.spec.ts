/** Behavior of durable meeting creation, retrieval, model updates, answers, deletion, audio, and disposal. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MeetingMinutesId } from '../src/types.ts'
import { disposeRoots, harness } from './harness.ts'

afterEach(disposeRoots)

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

  it('enforces the configured transcript bound after trimming', async () => {
    const suite = await harness({ maxTranscriptChars: 10 })
    await expect(suite.service.createFromTranscript({ title: 'too long', transcript: 'x'.repeat(11) }))
      .rejects.toThrow('meeting transcript exceeds 10 characters')
    await expect(suite.service.createFromTranscript({ title: 'exact', transcript: `  ${'x'.repeat(10)}  ` }))
      .resolves.toMatchObject({ transcript: 'x'.repeat(10) })
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
