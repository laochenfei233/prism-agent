/**
 * Model-facing meeting tools over `ctx.meetingMinutes`.
 * @module @prism-ai/prism-meeting/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MeetingMinutesId, MeetingMinutesService } from './index.ts'
import { answerView, meetingView } from './view.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'prism-meeting-tools'
export const inject = ['tools', 'meetingMinutes']

/**
 * Render a compact lossless JSON projection for model consumption.
 * @param label - A short result prefix.
 * @param value - The validated tool output.
 * @returns one text content block.
 */
function renderJson(label: string, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: `${label}: ${JSON.stringify(value)}` }]
}

const meetingProperties = {
  id: { type: 'string', required: true },
  title: { type: 'string', required: true },
  participants: { type: 'array', required: true, items: { type: 'string' } },
  status: { type: 'string', required: true, enum: ['recording', 'transcribed', 'summarized'] },
  summary: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  transcript: { type: 'string', required: true },
  segments: {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', required: true },
        speaker: { type: 'string' },
      },
    },
  },
  transcriptChars: { type: 'integer', required: true },
  audioSeconds: { type: 'number', required: true },
  createdAt: { type: 'string', required: true },
  updatedAt: { type: 'string', required: true },
} as const

/** Shared result schema for operations returning one meeting. */
const meetingResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    meeting: {
      type: 'object',
      additionalProperties: false,
      properties: meetingProperties,
      required: true,
    },
  },
} as const

const answerProperties = {
  id: { type: 'string', required: true },
  meetingId: { type: 'string', required: true },
  question: { type: 'string', required: true },
  answer: { type: 'string', required: true },
  createdAt: { type: 'string', required: true },
} as const

/**
 * Bind every tool definition to the activated meeting service.
 * @param minutes - The meeting service exposed by the registrant context.
 * @returns tool definitions in registration order.
 */
function createMeetingTools(minutes: MeetingMinutesService) {
  const create = defineTool({
    name: 'meeting_minutes_create',
    description: 'Create a durable meeting record from a complete transcript. Use this after transcript text is available.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short meeting title.' },
      participants: {
        type: 'array',
        description: 'Participant display names in meeting order.',
        items: { type: 'string' },
      },
      transcript: { type: 'string', required: true, description: 'Complete meeting transcript.' },
      audioSeconds: { type: 'number', description: 'Nonnegative recognized-audio duration in seconds; omit for a text import.' },
    },
    output: {
      schema: meetingResultSchema,
      render: (_args, value) => renderJson('Created meeting', value),
    },
    async execute(args, exec) {
      const request = {
        title: args.title,
        transcript: args.transcript,
        ...(args.participants === undefined ? {} : { participants: args.participants }),
        ...(args.audioSeconds === undefined ? {} : { audioSeconds: args.audioSeconds }),
      }
      const meeting = await minutes.createFromTranscript(request, exec.signal)
      return { meeting: meetingView(meeting, true) }
    },
  })

  const list = defineTool({
    name: 'meeting_minutes_list',
    description: 'List durable meetings without their transcripts. Read one meeting when its transcript is needed.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          meetings: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: meetingProperties },
          },
        },
      },
      render: (_args, value) => renderJson('Meeting list', value),
    },
    execute(_args): Promise<{ total: number; meetings: ReturnType<typeof meetingView>[] }> {
      const meetings = minutes.list().map(record => meetingView(record, false))
      return Promise.resolve({ total: meetings.length, meetings })
    },
  })

  const get = defineTool({
    name: 'meeting_minutes_get',
    description: 'Read one durable meeting, including its transcript and current summary.',
    parameters: { id: { type: 'string', required: true, description: 'Meeting id.' } },
    output: {
      schema: meetingResultSchema,
      render: (_args, value) => renderJson('Meeting', value),
    },
    execute(args): Promise<{ meeting: ReturnType<typeof meetingView> }> {
      const meeting = minutes.get(brandString<MeetingMinutesId>(args.id))
      return Promise.resolve({ meeting: meetingView(meeting, true) })
    },
  })

  const summarize = defineTool({
    name: 'meeting_minutes_summarize',
    description: 'Generate and persist a summary for one meeting using the deployment-configured meeting model.',
    parameters: { id: { type: 'string', required: true, description: 'Meeting id.' } },
    output: {
      schema: meetingResultSchema,
      render: (_args, value) => renderJson('Summarized meeting', value),
    },
    async execute(args, exec) {
      const meeting = await minutes.summarize(brandString<MeetingMinutesId>(args.id), exec.signal)
      return { meeting: meetingView(meeting, true) }
    },
  })

  const ask = defineTool({
    name: 'meeting_minutes_ask',
    description: 'Ask one question about a meeting and persist the question/answer exchange.',
    parameters: {
      id: { type: 'string', required: true, description: 'Meeting id.' },
      question: { type: 'string', required: true, description: 'The question to answer from the meeting transcript.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: {
            type: 'object',
            additionalProperties: false,
            properties: answerProperties,
            required: true,
          },
        },
      },
      render: (_args, value) => renderJson('Meeting answer', value),
    },
    async execute(args, exec) {
      const answer = await minutes.ask(
        brandString<MeetingMinutesId>(args.id),
        { question: args.question },
        exec.signal,
      )
      return { answer: answerView(answer) }
    },
  })

  return [create, list, get, summarize, ask]
}

/**
 * Register the model-facing meeting tools.
 * @param ctx - Registrant context carrying `ctx.meetingMinutes` and `ctx.tools`.
 */
export function apply(ctx: Context): void {
  const dispose = createMeetingTools(ctx.meetingMinutes)
    .map(definition => ctx.tools.register(definition))
  ctx.effect(() => () => {
    for (const remove of dispose) remove()
  }, 'prismMeeting.tools.register')
}

/** Plugin descriptor consumed by the Cordis loader. */
export default { name, inject, apply }
