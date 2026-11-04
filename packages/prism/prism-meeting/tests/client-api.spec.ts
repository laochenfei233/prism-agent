/** Browser meeting client: request shaping, response narrowing, and failures. */

import { describe, expect, it } from 'vitest'
import { createMeetingApi, MeetingRequestError } from '../src/client/api.ts'
import type { MeetingView } from '../src/view.ts'

/** One meeting projection as the host answers it. */
const stored: MeetingView = {
  id: 'm1',
  title: 'Weekly sync',
  participants: ['Ada'],
  status: 'summarized',
  summary: 'Decisions.',
  transcript: 'Notes.',
  segments: [],
  transcriptChars: 6,
  audioSeconds: 12,
  createdAt: '2026-09-26T02:30:00.000Z',
  updatedAt: '2026-09-26T02:30:00.000Z',
}

/** One recorded request. */
interface Call {
  readonly url: string
  readonly init: RequestInit
}

/** A fetch stub answering one body, with the requests it received. */
function fetchOf(body: unknown, status = 200): { readonly fetch: typeof fetch; readonly calls: Call[] } {
  const calls: Call[] = []
  return {
    fetch: async (input, init) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      calls.push({ url, init: init ?? {} })
      return Response.json(body, { status })
    },
    calls,
  }
}

/** Answer every request with one successful value. */
function okFetch(value: unknown) {
  return fetchOf({ ok: true, value })
}

describe('meeting api', () => {
  it('reads the list with one document-relative JSON request', async () => {
    const stub = okFetch({ meetings: [stored] })
    await expect(createMeetingApi(stub.fetch).list()).resolves.toEqual([stored])
    expect(stub.calls[0]?.url).toBe('api/prism-meeting/list')
    expect(stub.calls[0]?.init.method).toBe('POST')
    expect(stub.calls[0]?.init.body).toBe('{}')
  })

  it('reads one meeting from each single-meeting operation', async () => {
    const cases: readonly [string, (api: ReturnType<typeof createMeetingApi>) => Promise<MeetingView>, string][] = [
      ['get', async api => await api.get('m1'), '{"id":"m1"}'],
      ['create', async api => await api.create({ title: 'T', transcript: 'X' }), '{"title":"T","transcript":"X"}'],
      ['begin', async api => await api.begin({ title: 'T' }), '{"title":"T"}'],
      ['update', async api => await api.update({ id: 'm1', transcript: 'X', audioSeconds: 8 }), '{"id":"m1","transcript":"X","audioSeconds":8}'],
      ['finish', async api => await api.finish({ id: 'm1', transcript: 'X', audioSeconds: 8 }), '{"id":"m1","transcript":"X","audioSeconds":8}'],
      ['revise', async api => await api.revise({ id: 'm1', title: 'T' }), '{"id":"m1","title":"T"}'],
      ['summarize', async api => await api.summarize('m1'), '{"id":"m1"}'],
    ]
    for (const [endpoint, run, body] of cases) {
      const stub = okFetch({ meeting: stored })
      await expect(run(createMeetingApi(stub.fetch))).resolves.toEqual(stored)
      expect(stub.calls[0]?.url).toBe(`api/prism-meeting/${endpoint}`)
      expect(stub.calls[0]?.init.body).toBe(body)
    }
  })

  it('accepts a meeting whose microphone is still open', async () => {
    const recording: MeetingView = { ...stored, status: 'recording', transcript: '', transcriptChars: 0 }
    const stub = okFetch({ meetings: [recording] })
    await expect(createMeetingApi(stub.fetch).list()).resolves.toEqual([recording])
  })

  it('accepts speaker-attributed spans and rejects a malformed one', async () => {
    const spoken: MeetingView = {
      ...stored,
      transcript: 'Hi\nBye',
      segments: [{ text: 'Hi', speaker: '1' }, { text: 'Bye' }],
      transcriptChars: 6,
    }
    const ok = okFetch({ meetings: [spoken] })
    await expect(createMeetingApi(ok.fetch).list()).resolves.toEqual([spoken])

    const bad = okFetch({ meetings: [{ ...spoken, segments: [{ speaker: '1' }] }] })
    await expect(createMeetingApi(bad.fetch).list())
      .rejects.toMatchObject({ code: 'prism-meeting/invalid-response' })
  })

  it('passes the caller signal through', async () => {
    const stub = okFetch({ meeting: stored })
    const signal = new AbortController().signal
    await createMeetingApi(stub.fetch).get('m1', signal)
    expect(stub.calls[0]?.init.signal).toBe(signal)
  })

  it('reads the delete result as a boolean', async () => {
    const stub = okFetch({ deleted: true })
    await expect(createMeetingApi(stub.fetch).remove('m1')).resolves.toBe(true)
  })

  it('turns a host failure into a request error carrying its code', async () => {
    const stub = fetchOf({ ok: false, error: { code: 'prism-meeting/not-found', message: 'gone' } }, 400)
    await expect(createMeetingApi(stub.fetch).get('m1')).rejects.toMatchObject({
      name: 'MeetingRequestError',
      code: 'prism-meeting/not-found',
      message: 'gone',
    })
  })

  it.each([
    ['a meeting missing a field', { meeting: { id: 'm1' } }],
    ['a meeting of the wrong field type', { meeting: { ...stored, participants: 'Ada' } }],
    ['a meeting with an unknown status', { meeting: { ...stored, status: 'draft' } }],
    ['a list that is not an array', { meetings: 'none' }],
    ['a list with a malformed entry', { meetings: [{ id: 'm1' }] }],
    ['a delete result that is not a boolean', { deleted: 'yes' }],
    ['a result without the expected field', { other: true }],
  ])('rejects %s as an invalid response', async (_case, value) => {
    const stub = okFetch(value)
    const failure: unknown = await createMeetingApi(stub.fetch).list().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(MeetingRequestError)
    expect((failure as MeetingRequestError).code).toBe('prism-meeting/invalid-response')
  })

  it.each([
    ['an envelope that is not an object', 'nope'],
    ['a success envelope without a value', { ok: true }],
    ['a failure envelope without an error', { ok: false }],
    ['a failure envelope with a malformed error', { ok: false, error: { code: 7 } }],
  ])('rejects %s', async (_case, body) => {
    const stub = fetchOf(body)
    await expect(createMeetingApi(stub.fetch).list())
      .rejects.toMatchObject({ code: 'prism-meeting/invalid-response' })
  })

  it('recognizes a recorded segment through the audio route', async () => {
    const stub = okFetch({ text: 'hello', audioSeconds: 8 })
    const audio = new Blob([new Uint8Array(46)], { type: 'audio/wav' })
    await expect(createMeetingApi(stub.fetch).transcribe(audio)).resolves.toEqual({ text: 'hello', audioSeconds: 8 })
    expect(stub.calls[0]?.url).toBe('api/prism-meeting/transcribe')
    expect(stub.calls[0]?.init.body).toBe(audio)
  })

  it('reads the recognized speaker spans when the provider reports them', async () => {
    const stub = okFetch({
      text: 'Hi\nBye',
      segments: [{ text: 'Hi', speaker: '1' }, { text: 'Bye' }],
      audioSeconds: 8,
    })
    await expect(createMeetingApi(stub.fetch).transcribe(new Blob([new Uint8Array(46)])))
      .resolves.toEqual({
        text: 'Hi\nBye',
        segments: [{ text: 'Hi', speaker: '1' }, { text: 'Bye' }],
        audioSeconds: 8,
      })
  })

  it('rejects a malformed spoken span', async () => {
    const stub = okFetch({ text: 'Hi', segments: [{ speaker: '1' }], audioSeconds: 8 })
    await expect(createMeetingApi(stub.fetch).transcribe(new Blob([new Uint8Array(46)])))
      .rejects.toMatchObject({ code: 'prism-meeting/invalid-response' })
  })

  it('rejects a malformed transcript value', async () => {
    const stub = okFetch({ text: 7, audioSeconds: 8 })
    await expect(createMeetingApi(stub.fetch).transcribe(new Blob([new Uint8Array(2)])))
      .rejects.toMatchObject({ code: 'prism-meeting/invalid-response' })
  })

  it('reads the speech providers a recording would transcribe with', async () => {
    const stub = okFetch({ speech: { providers: [{ id: 'p', name: 'Provider', phase: 'ready' }], selected: 'p' } })
    await expect(createMeetingApi(stub.fetch).speech()).resolves.toEqual({
      providers: [{ id: 'p', name: 'Provider', phase: 'ready' }],
      selected: 'p',
    })
    expect(stub.calls[0]?.url).toBe('api/prism-meeting/speech')
  })

  it.each([
    ['a status that is not an object', { speech: 'none' }],
    ['a provider list that is not an array', { speech: { providers: 'none', selected: 'p' } }],
    ['a provider without its fields', { speech: { providers: [{ id: 'p' }], selected: 'p' } }],
    ['a selection that is not a string', { speech: { providers: [], selected: 7 } }],
    ['a preparation projection of the wrong field type', {
      speech: {
        providers: [{ id: 'p', name: 'Provider', phase: 'downloading', preparation: { phase: 7 } }],
        selected: 'p',
      },
    }],
  ])('rejects %s in the speech status', async (_case, value) => {
    const stub = okFetch(value)
    await expect(createMeetingApi(stub.fetch).speech())
      .rejects.toMatchObject({ code: 'prism-meeting/invalid-response' })
  })

  it('reads the preparation projection beside the provider phase', async () => {
    const stub = okFetch({
      speech: {
        providers: [{
          id: 'p', name: 'Provider', phase: 'downloading',
          preparation: { phase: 'downloading', resource: 'model', completedBytes: 8, totalBytes: 16 },
        }],
        selected: 'p',
      },
    })
    await expect(createMeetingApi(stub.fetch).speech()).resolves.toEqual({
      providers: [{
        id: 'p', name: 'Provider', phase: 'downloading',
        preparation: { phase: 'downloading', resource: 'model', completedBytes: 8, totalBytes: 16 },
      }],
      selected: 'p',
    })
  })

  it('sends the prepare and cancel requests, with and without a provider', async () => {
    const status = { providers: [{ id: 'p', name: 'Provider', phase: 'ready' }], selected: 'p' }
    const named = okFetch({ speech: status })
    await expect(createMeetingApi(named.fetch).prepare('p')).resolves.toEqual(status)
    expect(named.calls[0]?.url).toBe('api/prism-meeting/speech/prepare')
    expect(named.calls[0]?.init.body).toBe('{"providerId":"p"}')

    const selected = okFetch({ speech: status })
    await createMeetingApi(selected.fetch).prepare(undefined)
    expect(selected.calls[0]?.init.body).toBe('{}')

    const cancelled = okFetch({ speech: status })
    await createMeetingApi(cancelled.fetch).cancelPrepare(undefined)
    expect(cancelled.calls[0]?.url).toBe('api/prism-meeting/speech/cancel')
    expect(cancelled.calls[0]?.init.body).toBe('{}')
  })

  it('asks one meeting and lists its persisted answers', async () => {
    const answer = { id: 'a1', meetingId: 'm1', question: 'Q', answer: 'A', createdAt: '2026-11-04T00:00:00.000Z' }
    const asked = okFetch({ answer })
    await expect(createMeetingApi(asked.fetch).ask('m1', 'Q')).resolves.toEqual(answer)
    expect(asked.calls[0]?.url).toBe('api/prism-meeting/ask')
    expect(asked.calls[0]?.init.body).toBe('{"id":"m1","question":"Q"}')

    const listed = okFetch({ answers: [answer] })
    await expect(createMeetingApi(listed.fetch).answers('m1')).resolves.toEqual([answer])
    expect(listed.calls[0]?.url).toBe('api/prism-meeting/answers')
  })

  it('rejects a malformed answer list', async () => {
    const stub = okFetch({ answers: [{ id: 'a1' }] })
    await expect(createMeetingApi(stub.fetch).answers('m1'))
      .rejects.toMatchObject({ code: 'prism-meeting/invalid-response' })
  })

  it('imports a recording with its title, participants, and language', async () => {
    const stub = okFetch({ meeting: stored })
    const audio = new Blob([new Uint8Array(46)], { type: 'audio/wav' })
    await expect(createMeetingApi(stub.fetch).uploadAudio(
      audio,
      { title: 'Standup', participants: ['Ada', 'Lin'], language: 'zh' },
    )).resolves.toEqual(stored)
    expect(stub.calls[0]?.url)
      .toBe('api/prism-meeting/audio?title=Standup&participant=Ada&participant=Lin&language=zh')
  })

  it('omits an empty language from the import query', async () => {
    const stub = okFetch({ meeting: stored })
    await createMeetingApi(stub.fetch).uploadAudio(
      new Blob([new Uint8Array(46)]),
      { title: 'Standup', participants: [], language: '' },
    )
    expect(stub.calls[0]?.url).toBe('api/prism-meeting/audio?title=Standup')
  })
})
