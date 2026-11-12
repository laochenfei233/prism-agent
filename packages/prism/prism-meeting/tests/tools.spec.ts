import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Volatile } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { MeetingAnswerRecord, MeetingMinutesId, MeetingMinutesRecord } from '@prism-ai/prism-meeting'
import MeetingMinutesService from '@prism-ai/prism-meeting'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ToolMeetingMinutes from '../src/tools.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

const meeting: MeetingMinutesRecord = {
  id: brandString<MeetingMinutesId>('meeting-1'),
  title: 'Planning',
  participants: ['Alice'],
  transcript: 'Alice: Hello',
  summary: null,
  status: 'transcribed',
  audioSeconds: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}


const answer: MeetingAnswerRecord = {
  id: brandString<MeetingAnswerRecord['id']>('answer-1'),
  meetingId: meeting.id,
  question: 'Who spoke?',
  answer: 'Alice.',
  createdAt: '2026-01-01T00:01:00.000Z',
}


function volatile(value: string): Volatile<string>
function volatile(value: number): Volatile<number>
function volatile(value: string | number): Volatile<string | number> {
  return { get: () => value }
}


class StubMeetingMinutesService extends MeetingMinutesService {
  constructor() {
    super(new Context(), {
      summaryProvider: volatile('meeting-provider'),
      summaryModel: volatile('meeting-model'),
      summarySystemPrompt: volatile('summarize meetings'),
      answerSystemPrompt: volatile('answer meeting questions'),
      maxTranscriptChars: volatile(100),
    })
  }
}


function makeService(calls: string[] = []): MeetingMinutesService {
  const service = new StubMeetingMinutesService()
  service.createFromTranscript = async (request) => {
    calls.push(`create:${request.title}:${request.transcript}`)
    return meeting
  }
  service.list = () => {
    calls.push('list')
    return [meeting]
  }
  service.get = (id) => {
    calls.push(`get:${id}`)
    return meeting
  }
  service.summarize = async (id) => {
    calls.push(`summarize:${id}`)
    return { ...meeting, summary: 'Plan', status: 'summarized', updatedAt: '2026-01-01T00:02:00.000Z' }
  }
  service.ask = async (id, request) => {
    calls.push(`ask:${id}:${request.question}`)
    return answer
  }
  return service
}

async function setup(calls: string[] = []): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('meetingMinutes', makeService(calls))
  await ctx.plugin(ToolMeetingMinutes)
  return ctx
}


function call(ctx: Context, name: string, args: unknown = {}) {
  return executeModelToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`meeting-tool-${name}`),
    name,
    arguments: args,
  })
}


function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}


function json<T>(
  result: { content: { type: string; text?: string }[] },
  parse: (rendered: string) => T = value => JSON.parse(value) as T,
): T {
  const rendered = text(result)
  return parse(rendered.slice(rendered.indexOf(':') + 1))
}


describe('prism-meeting tools', () => {
  it('registers and disposes the five schemas', async () => {
    const ctx = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([
      'meeting_minutes_create', 'meeting_minutes_list', 'meeting_minutes_get',
      'meeting_minutes_summarize', 'meeting_minutes_ask',
    ])
    await ctx.fiber.dispose()
  })

  it('routes create to the service and returns the meeting', async () => {
    const calls: string[] = []
    const ctx = await setup(calls)
    const result = await call(ctx, 'meeting_minutes_create', {
      title: ' Planning ', participants: [' Alice ', ''], transcript: ' Hello ', audioSeconds: 3,
    })
    expect(result.isError).toBe(false)
    expect(calls).toEqual(['create: Planning : Hello '])
    expect(text(result)).toContain('"title":"Planning"')
  })

  it('omits transcript content from list but includes it from get', async () => {
    const calls: string[] = []
    const ctx = await setup(calls)
    const listed = json<{
      total: number
      meetings: { transcript: string; transcriptChars: number }[]
    }>(await call(ctx, 'meeting_minutes_list'))
    expect(calls).toEqual(['list'])
    expect(listed).toEqual({
      total: 1,
      meetings: [{ ...meeting, transcript: '', segments: [], participants: ['Alice'], transcriptChars: 12 }],
    })
    const read = json<{ meeting: MeetingMinutesRecord }>(await call(ctx, 'meeting_minutes_get', { id: 'meeting-1' }))
    expect(calls).toEqual(['list', 'get:meeting-1'])
    expect(read.meeting.transcript).toBe('Alice: Hello')
  })

  it('routes summarize and ask with cancellation and returns persisted values', async () => {
    const calls: string[] = []
    const ctx = await setup(calls)
    const summarized = json<{ meeting: MeetingMinutesRecord }>(await call(ctx, 'meeting_minutes_summarize', { id: 'meeting-1' }))
    const answered = json<{ answer: MeetingAnswerRecord }>(await call(ctx, 'meeting_minutes_ask', {
      id: 'meeting-1', question: 'Who spoke?',
    }))
    expect(calls).toEqual(['summarize:meeting-1', 'ask:meeting-1:Who spoke?'])
    expect(summarized.meeting.summary).toBe('Plan')
    expect(answered.answer).toEqual(answer)
  })
})
