/** `./web` behavior: the browser routes, their validation, and their answers. */

import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MeetingMinutesId } from '../src/types.ts'
import * as web from '../src/web.ts'
import { disposeRoots, harness, type MeetingHarness } from './harness.ts'

/** One route answer as the page receives it. */
interface Answer {
  readonly status: number
  readonly body: Record<string, unknown>
}

/** The registered browser surface plus the meeting service behind it. */
interface WebHarness {
  readonly meetings: MeetingHarness
  readonly paths: string[]
  readonly post: (endpoint: string, init?: RequestInit) => Promise<Answer>
}

/** Activate the meeting service, then the browser entry over a recording Connection stub. */
async function webHarness(meetingsOptions?: Parameters<typeof harness>[0]): Promise<WebHarness> {
  const meetings = await harness(meetingsOptions)
  const routes = new Map<string, ConnectionFetchRoute>()
  meetings.ctx.provide('connection', {
    fetch: {
      register: (route: ConnectionFetchRoute) => {
        routes.set(route.path, route)
        return async () => { routes.delete(route.path) }
      },
    },
  })
  // The row declares `webServer` because Connection's registries resolve
  // services through the caller's context; the stub only has to exist.
  meetings.ctx.provide('webServer', { register: () => async () => {} })
  await meetings.ctx.plugin(web.default)
  return {
    meetings,
    paths: [...routes.keys()],
    async post(endpoint, init = {}) {
      const [name = '', query] = endpoint.split('?')
      const route = routes.get(`/api/prism-meeting/${name}`)
      if (route === undefined) throw new Error(`route ${name} is not registered`)
      if (!route.methods.includes('POST')) throw new Error(`route ${name} does not accept POST`)
      const search = query === undefined ? '' : `?${query}`
      const response = await route.fetch(new Request(`http://127.0.0.1/api/prism-meeting/${name}${search}`, {
        method: 'POST',
        ...init,
      }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    },
  }
}

/** Send one JSON body to a route. */
function json(body: unknown): RequestInit {
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

/** Read the value of a successful answer. */
function value(answer: Answer): Record<string, unknown> {
  expect(answer.status).toBe(200)
  expect(answer.body.ok).toBe(true)
  return answer.body.value as Record<string, unknown>
}

/** Read the failure code of a refused answer. */
function failure(answer: Answer): string {
  expect(answer.status).toBe(400)
  expect(answer.body.ok).toBe(false)
  return (answer.body.error as { code: string }).code
}

afterEach(async () => { await disposeRoots() })

describe('meeting browser routes', () => {
  it('registers one POST route per operation under the plugin prefix', async () => {
    const h = await webHarness()
    expect(web.name).toBe('prism-meeting-web')
    expect(web.inject).toEqual(['meetingMinutes', 'connection', 'webServer'])
    expect(h.paths.sort()).toEqual([
      '/api/prism-meeting/answers',
      '/api/prism-meeting/ask',
      '/api/prism-meeting/audio',
      '/api/prism-meeting/begin',
      '/api/prism-meeting/create',
      '/api/prism-meeting/delete',
      '/api/prism-meeting/finish',
      '/api/prism-meeting/get',
      '/api/prism-meeting/list',
      '/api/prism-meeting/revise',
      '/api/prism-meeting/speech',
      '/api/prism-meeting/speech/cancel',
      '/api/prism-meeting/speech/prepare',
      '/api/prism-meeting/summarize',
      '/api/prism-meeting/transcribe',
      '/api/prism-meeting/update',
    ])
  })

  it('reports the speech providers a recording would transcribe with', async () => {
    const h = await webHarness()
    const speech = value(await h.post('speech', json({}))).speech as {
      providers: { id: string; name: string; phase: string }[]
      selected: string
    }
    expect(speech.providers.map(provider => provider.id)).toEqual(['meeting-test'])
    expect(speech.providers[0]?.name).toBe('Meeting test')
    expect(speech.selected).toBe('meeting-test')
  })

  it('starts and cancels the selected provider preparation', async () => {
    const h = await webHarness({ preparation: { initial: { phase: 'unprepared' } } })
    const stub = h.meetings.preparation!
    stub.onPrepare = () => { stub.publish({ phase: 'downloading', resource: 'model', completedBytes: 8 }) }
    const prepared = value(await h.post('speech/prepare', json({}))).speech as {
      providers: { phase: string; preparation?: { phase: string; resource: string; completedBytes: number } }[]
      selected: string
    }
    expect(stub.prepareCalls).toBe(1)
    expect(prepared.providers[0])
      .toMatchObject({ phase: 'downloading', preparation: { phase: 'downloading', resource: 'model', completedBytes: 8 } })
    await h.post('speech/cancel', json({}))
    expect(stub.cancelCalls).toBe(1)
  })

  it('asks a stored meeting and lists its persisted answers', async () => {
    const h = await webHarness()
    const created = value(await h.post('create', json({ title: 'Retro', transcript: 'Notes.' })))
    const id = (created.meeting as { id: string }).id
    h.meetings.llm.queueText('The team ships on Friday.')
    const asked = value(await h.post('ask', json({ id, question: 'When do we ship?' })))
    expect(asked.answer).toMatchObject({
      meetingId: id, question: 'When do we ship?', answer: 'The team ships on Friday.',
    })
    const listed = value(await h.post('answers', json({ id })))
    expect(listed.answers).toHaveLength(1)
    expect(failure(await h.post('ask', json({ id: 'missing', question: 'Hi' })))).toBe('prism-meeting/not-found')
    expect(failure(await h.post('answers', json({ id: 'missing' })))).toBe('prism-meeting/not-found')
  })

  it('lists stored meetings without their transcripts', async () => {
    const h = await webHarness()
    await h.post('create', json({ title: 'Retro', transcript: 'Long transcript text.' }))
    const listed = value(await h.post('list', json({})))
    const meetings = listed.meetings as { title: string; transcript: string; transcriptChars: number }[]
    expect(meetings).toHaveLength(1)
    expect(meetings[0]?.title).toBe('Retro')
    expect(meetings[0]?.transcript).toBe('')
    expect(meetings[0]?.transcriptChars).toBe('Long transcript text.'.length)
  })

  it('reads one meeting including its transcript and reports an unknown id', async () => {
    const h = await webHarness()
    const created = value(await h.post('create', json({ title: 'Retro', transcript: 'Full transcript.' })))
    const id = (created.meeting as { id: string }).id
    const read = value(await h.post('get', json({ id })))
    expect((read.meeting as { transcript: string }).transcript).toBe('Full transcript.')
    expect(failure(await h.post('get', json({ id: 'missing' })))).toBe('prism-meeting/not-found')
  })

  it('stores a text import with its participants and duration', async () => {
    const h = await webHarness()
    const created = value(await h.post('create', json({
      title: '  Planning  ', participants: ['Ada', ' '], transcript: 'Notes.', audioSeconds: 90,
    })))
    const meeting = created.meeting as { title: string; participants: string[]; audioSeconds: number }
    expect(meeting.title).toBe('Planning')
    expect(meeting.participants).toEqual(['Ada'])
    expect(meeting.audioSeconds).toBe(90)
  })

  it('refuses a body that is not JSON and one that fails the route schema', async () => {
    const h = await webHarness()
    expect(failure(await h.post('get', { body: 'not json' }))).toBe('prism-meeting/invalid-request')
    expect(failure(await h.post('get', json({ id: 7 })))).toBe('prism-meeting/invalid-request')
  })

  it('preserves a service rule failure as a route failure', async () => {
    const h = await webHarness()
    expect(failure(await h.post('create', json({ title: '   ', transcript: 'Notes.' }))))
      .toBe('prism-meeting/failure')
  })

  it('summarizes through the configured model route and preserves a model failure', async () => {
    const h = await webHarness()
    const created = value(await h.post('create', json({ title: 'Retro', transcript: 'Notes.' })))
    const id = (created.meeting as { id: string }).id
    h.meetings.llm.queueText('Decisions: ship the page.')
    const summarized = value(await h.post('summarize', json({ id })))
    expect((summarized.meeting as { summary: string }).summary).toBe('Decisions: ship the page.')
    expect(h.meetings.llm.requests[0]?.model).toBe('meeting-model')

    h.meetings.llm.queueFailure('provider unavailable')
    expect(failure(await h.post('summarize', json({ id })))).toBe('prism-meeting/failure')
    expect(h.meetings.service.get(brandString<MeetingMinutesId>(id)).summary).toBe('Decisions: ship the page.')
  })

  it('opens a recording, replaces its transcript, and closes it', async () => {
    const h = await webHarness()
    const opened = value(await h.post('begin', json({ title: 'Standup' })))
    const started = opened.meeting as { id: string; status: string; transcript: string; audioSeconds: number }
    expect(started.status).toBe('recording')
    expect(started.transcript).toBe('')
    expect(started.audioSeconds).toBe(0)

    const advanced = value(await h.post('update', json({
      id: started.id, transcript: 'First slice.', audioSeconds: 8,
    })))
    expect(advanced.meeting).toMatchObject({
      status: 'recording', transcript: 'First slice.', audioSeconds: 8,
    })

    const closed = value(await h.post('finish', json({
      id: started.id, transcript: 'Complete transcript.', audioSeconds: 12.5,
    })))
    expect(closed.meeting).toMatchObject({
      status: 'transcribed', transcript: 'Complete transcript.', audioSeconds: 12.5,
    })

    h.meetings.llm.queueText('Decisions: ship it.')
    const summarized = value(await h.post('summarize', json({ id: started.id })))
    expect((summarized.meeting as { summary: string }).summary).toBe('Decisions: ship it.')
  })

  it('refuses a live write against a meeting that is no longer recording', async () => {
    const h = await webHarness()
    const created = value(await h.post('create', json({ title: 'Retro', transcript: 'Notes.' })))
    const id = (created.meeting as { id: string }).id
    expect(failure(await h.post('update', json({ id, transcript: 'late', audioSeconds: 1 }))))
      .toBe('prism-meeting/failure')
    expect(failure(await h.post('finish', json({ id, transcript: 'late', audioSeconds: 1 }))))
      .toBe('prism-meeting/failure')
    expect(failure(await h.post('update', json({ id: 'missing', transcript: 'late', audioSeconds: 1 }))))
      .toBe('prism-meeting/not-found')
  })

  it('revises the title and participants of a stored meeting', async () => {
    const h = await webHarness()
    const created = value(await h.post('create', json({ title: 'Retro', transcript: 'Notes.' })))
    const id = (created.meeting as { id: string }).id
    const revised = value(await h.post('revise', json({
      id, title: ' Sprint retro ', participants: ['Ada', ' '],
    })))
    expect(revised.meeting).toMatchObject({ title: 'Sprint retro', participants: ['Ada'] })
    expect(failure(await h.post('revise', json({ id })))).toBe('prism-meeting/failure')
    expect(failure(await h.post('revise', json({ id, title: '   ' })))).toBe('prism-meeting/failure')
  })

  it('stores speaker spans sent with a live write and rejects mismatched ones', async () => {
    const h = await webHarness()
    const opened = value(await h.post('begin', json({ title: 'Standup' })))
    const id = (opened.meeting as { id: string }).id
    const advanced = value(await h.post('update', json({
      id,
      transcript: 'Hi\nBye',
      segments: [{ text: 'Hi', speaker: '1' }, { text: 'Bye' }],
      audioSeconds: 8,
    })))
    expect((advanced.meeting as { segments: unknown[] }).segments)
      .toEqual([{ text: 'Hi', speaker: '1' }, { text: 'Bye' }])

    expect(failure(await h.post('update', json({
      id, transcript: 'Hi\nBye', segments: [{ text: 'Hi' }], audioSeconds: 9,
    })))).toBe('prism-meeting/failure')
    expect(failure(await h.post('update', json({
      id, transcript: 'Hi', segments: [{ text: '' }], audioSeconds: 9,
    })))).toBe('prism-meeting/invalid-request')
  })

  it('omits the segments field when a stored meeting has no speaker spans', async () => {
    const h = await webHarness()
    const created = value(await h.post('create', json({ title: 'Retro', transcript: 'Notes.' })))
    expect(created.meeting as object).toMatchObject({ segments: [] })
  })

  it('deletes a meeting and reports an already-absent one', async () => {
    const h = await webHarness()
    const created = value(await h.post('create', json({ title: 'Retro', transcript: 'Notes.' })))
    const id = (created.meeting as { id: string }).id
    expect(value(await h.post('delete', json({ id }))).deleted).toBe(true)
    expect(value(await h.post('delete', json({ id }))).deleted).toBe(false)
  })

  it('recognizes a segment without storing a meeting', async () => {
    const h = await webHarness()
    const recognized = value(await h.post('transcribe', { body: new Uint8Array(46) }))
    expect(recognized.text).toBe('recognized auto 46')
    expect(recognized.audioSeconds).toBe(12.5)
    expect(h.meetings.service.list()).toEqual([])
  })

  it('refuses an empty recording', async () => {
    const h = await webHarness()
    expect(failure(await h.post('transcribe', { body: new Uint8Array(0) }))).toBe('prism-meeting/failure')
  })

  it('imports a recording with its title, participants, and language', async () => {
    const h = await webHarness()
    const answer = await h.post('audio?title=Standup&participant=Ada&participant=Lin&language=zh', {
      body: new Uint8Array(46),
    })
    const meeting = value(answer).meeting as { title: string; participants: string[]; transcript: string }
    expect(meeting.title).toBe('Standup')
    expect(meeting.participants).toEqual(['Ada', 'Lin'])
    expect(meeting.transcript).toBe('recognized zh 46')
  })

  it('resolves an explicit provider and an omitted language from the speech configuration', async () => {
    const h = await webHarness()
    const answer = await h.post('audio?title=Standup&providerId=meeting-test&language=', { body: new Uint8Array(46) })
    const meeting = value(answer).meeting as { participants: string[]; transcript: string }
    expect(meeting.participants).toEqual([])
    expect(meeting.transcript).toBe('recognized auto 46')
  })

  it('answers an empty import with the failed envelope and a 400 status', async () => {
    const h = await webHarness()
    const answer = await h.post('audio?title=Standup', { body: new Uint8Array(0) })
    expect(answer.status).toBe(400)
    expect(answer.body.ok).toBe(false)
  })

  it('withdraws every route on disposal', async () => {
    const h = await webHarness()
    await h.meetings.ctx.fiber.dispose()
    await expect(h.post('list', json({}))).rejects.toThrow('not registered')
  })
})
