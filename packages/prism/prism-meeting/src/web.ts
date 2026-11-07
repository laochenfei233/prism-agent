/**
 * Browser-facing meeting operations: exact Fetch routes under Connection's
 * shared `/api` channel. Every route answers one JSON envelope, and every
 * operation delegates to `ctx.meetingMinutes`, so the page runs the
 * deployment's configured model route instead of a second one.
 *
 * Routes rather than a channel: a plugin-registered RPC channel is created
 * through `HostConnectionService`'s own context, which does not inject
 * `webServer`, so `ctx.connection.rpc.handle()` throws at load. The exact
 * Fetch-route registry has no such dependency, and other feature packages in
 * this repository register through it.
 *
 * `webServer` is declared because Connection's registries read services
 * through the CALLER's context: `HostConnectionService.fetch` is a getter, and
 * Cordis invokes a service getter with `this.ctx` rebound to the reader, so
 * anything that registry touches resolves against this plugin's `inject` set.
 * Declaring it also keeps the row pending — rather than failing — in a profile
 * that composes no web server, which is the same profile that composes no
 * browser Connection.
 * @module @prism-ai/prism-meeting/web
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
// Type-only: activates the `ctx.connection` Context merge these routes register on.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: activates the `ctx.webServer` Context merge this row declares.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { MeetingMinutesNotFoundError } from './index.ts'
import type { MeetingMinutesId } from './types.ts'
import { answerView, meetingView } from './view.ts'
import type { MeetingFailure } from './web-contract.ts'

export const name = 'prism-meeting-web'
export const inject = ['meetingMinutes', 'connection', 'webServer']

/** Path prefix every route of this plugin owns below Connection's `/api` channel. */
const BASE = '/api/prism-meeting'

/** One JSON body addressing a stored meeting. */
const idBody = z.object({ id: z.string().min(1) })

/** One recognized span carried by a request body; semantic rules stay with the service. */
const segmentBody = z.object({
  text: z.string().min(1),
  speaker: z.string().min(1).optional(),
})

/** One JSON body carrying a text import; semantic rules stay with the service. */
const createBody = z.object({
  title: z.string(),
  participants: z.array(z.string()).optional(),
  transcript: z.string(),
  segments: z.array(segmentBody).optional(),
  audioSeconds: z.number().optional(),
})

/** One JSON body opening a recording; semantic rules stay with the service. */
const beginBody = z.object({
  title: z.string(),
  participants: z.array(z.string()).optional(),
})

/** One JSON body replacing the transcript an open recording has produced so far. */
const recordingBody = z.object({
  id: z.string().min(1),
  transcript: z.string(),
  segments: z.array(segmentBody).optional(),
  audioSeconds: z.number(),
})

/** One JSON body revising the operator-editable fields of a stored meeting. */
const reviseBody = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  participants: z.array(z.string()).optional(),
})

/** One JSON body addressing one provider's preparation; omission targets the selection. */
const speechTargetBody = z.object({ providerId: z.string().min(1).optional() })

/** One JSON body asking one stored meeting a question. */
const askBody = z.object({
  id: z.string().min(1),
  question: z.string(),
})

/** One JSON body selecting one recognizer as the deployment's speech selection. */
const speechSelectBody = z.object({
  providerId: z.string().min(1),
  language: z.string().min(1).optional(),
})

/**
 * Register every browser route.
 * @param ctx - Registrant context carrying `ctx.meetingMinutes` and `ctx.connection`.
 */
export function apply(ctx: Context): void {
  /** Register one route so its contribution leaves with this plugin's fiber. */
  const route = (
    name: string,
    path: string,
    fetch: (request: Request) => Promise<Response>,
  ): void => {
    ctx.effect(
      () => ctx.connection.fetch.register({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => guard(() => fetch(request)),
      } satisfies ConnectionFetchRoute),
      `prismMeeting.web.${name}`,
    )
  }

  route('list', `${BASE}/list`, () => Promise.resolve(ok({
    meetings: ctx.meetingMinutes.list().map(record => meetingView(record, false)),
  })))

  route('get', `${BASE}/get`, json((body) => {
    const { id } = idBody.parse(body)
    return Promise.resolve(ok({ meeting: meetingView(ctx.meetingMinutes.get(meetingId(id)), true) }))
  }))

  route('create', `${BASE}/create`, json(async (body, signal) => {
    const parsed = createBody.parse(body)
    const meeting = await ctx.meetingMinutes.createFromTranscript({
      title: parsed.title,
      ...(parsed.participants === undefined ? {} : { participants: parsed.participants }),
      transcript: parsed.transcript,
      ...(parsed.segments === undefined ? {} : { segments: parsed.segments }),
      ...(parsed.audioSeconds === undefined ? {} : { audioSeconds: parsed.audioSeconds }),
    }, signal)
    return ok({ meeting: meetingView(meeting, true) })
  }))

  route('begin', `${BASE}/begin`, json(async (body, signal) => {
    const parsed = beginBody.parse(body)
    const meeting = await ctx.meetingMinutes.beginRecording({
      title: parsed.title,
      ...(parsed.participants === undefined ? {} : { participants: parsed.participants }),
    }, signal)
    return ok({ meeting: meetingView(meeting, true) })
  }))

  // The page holds the microphone, so it owns recognition and sends the whole
  // text each time; the route only carries that text into the durable record.
  const recordingRoute = (
    name: 'update' | 'finish',
    write: typeof ctx.meetingMinutes.updateRecording,
  ): void => {
    route(name, `${BASE}/${name}`, json(async (body, signal) => {
      const parsed = recordingBody.parse(body)
      const meeting = await write(meetingId(parsed.id), {
        transcript: parsed.transcript,
        ...(parsed.segments === undefined ? {} : { segments: parsed.segments }),
        audioSeconds: parsed.audioSeconds,
      }, signal)
      return ok({ meeting: meetingView(meeting, true) })
    }))
  }

  recordingRoute('update', (id, request, writeSignal) => ctx.meetingMinutes.updateRecording(id, request, writeSignal))
  recordingRoute('finish', (id, request, writeSignal) => ctx.meetingMinutes.finishRecording(id, request, writeSignal))

  route('revise', `${BASE}/revise`, json(async (body, signal) => {
    const parsed = reviseBody.parse(body)
    const meeting = await ctx.meetingMinutes.reviseMeeting(meetingId(parsed.id), {
      ...(parsed.title === undefined ? {} : { title: parsed.title }),
      ...(parsed.participants === undefined ? {} : { participants: parsed.participants }),
    }, signal)
    return ok({ meeting: meetingView(meeting, true) })
  }))

  route('summarize', `${BASE}/summarize`, json(async (body, signal) => {
    const { id } = idBody.parse(body)
    return ok({ meeting: meetingView(await ctx.meetingMinutes.summarize(meetingId(id), signal), true) })
  }))

  // The page's answers tab asks the configured model route and reads the
  // persisted exchanges, so a question asked in the browser stays in the record.
  route('ask', `${BASE}/ask`, json(async (body, signal) => {
    const parsed = askBody.parse(body)
    const answer = await ctx.meetingMinutes.ask(meetingId(parsed.id), { question: parsed.question }, signal)
    return ok({ answer: answerView(answer) })
  }))

  route('answers', `${BASE}/answers`, json((body) => {
    const { id } = idBody.parse(body)
    return Promise.resolve(ok({ answers: ctx.meetingMinutes.listAnswers(meetingId(id)).map(answerView) }))
  }))

  route('delete', `${BASE}/delete`, json(async (body) => {
    const { id } = idBody.parse(body)
    return ok({ deleted: await ctx.meetingMinutes.delete(meetingId(id)) })
  }))

  // The page reads speech availability before it offers recording, so an
  // operator learns a speech plugin is missing before granting a microphone.
  route('speech', `${BASE}/speech`, () => Promise.resolve(ok({ speech: ctx.meetingMinutes.speech() })))

  // Preparation runs on the Host, so the page starts or cancels it here and
  // reads progress through the speech route.
  route('speech-prepare', `${BASE}/speech/prepare`, json((body) => {
    const { providerId } = speechTargetBody.parse(body)
    return Promise.resolve(ok({ speech: ctx.meetingMinutes.prepareSpeech(providerId) }))
  }))

  route('speech-cancel', `${BASE}/speech/cancel`, json(async (body) => {
    const { providerId } = speechTargetBody.parse(body)
    return ok({ speech: await ctx.meetingMinutes.cancelSpeechPreparation(providerId) })
  }))

  // Persisting the recognizer here routes every later transcription — slices
  // and imports — through the operator's chosen provider.
  route('speech-select', `${BASE}/speech/select`, json(async (body) => {
    const parsed = speechSelectBody.parse(body)
    return ok({ speech: await ctx.meetingMinutes.selectSpeech(parsed.providerId, parsed.language) })
  }))

  // Live capture asks for text alone: the page appends each answer while
  // recording and stores one meeting when recording stops.
  route('transcribe', `${BASE}/transcribe`, async (request) => {
    const recognized = await ctx.meetingMinutes.transcribe(
      new Uint8Array(await request.arrayBuffer()),
      request.signal,
    )
    return ok({
      text: recognized.text,
      ...(recognized.segments === undefined ? {} : { segments: recognized.segments }),
      audioSeconds: recognized.audioSeconds,
    })
  })

  route('audio', `${BASE}/audio`, async (request) => {
    const query = new URL(request.url).searchParams
    const participants = query.getAll('participant')
    const language = query.get('language')
    const providerId = query.get('providerId')
    const meeting = await ctx.meetingMinutes.createFromAudio({
      title: query.get('title') ?? '',
      ...(participants.length === 0 ? {} : { participants }),
      audio: new Uint8Array(await request.arrayBuffer()),
      ...(language === null || language.length === 0 ? {} : { language }),
      ...(providerId === null || providerId.length === 0 ? {} : { providerId }),
    }, request.signal)
    return ok({ meeting: meetingView(meeting, true) })
  })
}

/**
 * Wrap one JSON-body operation in this plugin's envelope.
 * @param operation - body reader answering the operation result.
 * @returns the Fetch handler for that route.
 */
function json(
  operation: (body: unknown, signal: AbortSignal) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    let body: unknown
    try {
      body = await request.json()
    } catch (error) {
      return fail('prism-meeting/invalid-request', `the request body is not JSON: ${reasonOf(error)}`)
    }
    return await operation(body, request.signal)
  }
}

/** Project one operation failure onto this plugin's failure vocabulary. */
async function guard(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof MeetingMinutesNotFoundError) return fail('prism-meeting/not-found', error.message)
    if (error instanceof z.ZodError) return fail('prism-meeting/invalid-request', error.message)
    return fail('prism-meeting/failure', reasonOf(error))
  }
}

/** Answer one successful operation. */
function ok(value: unknown): Response {
  return Response.json({ ok: true, value })
}

/** Answer one failed operation with the status the page reports as an error. */
function fail(code: string, message: string): Response {
  const failure: MeetingFailure = { code, message }
  return Response.json({ ok: false, error: failure }, { status: 400 })
}

/** Operator-readable text for one thrown value. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Brand one validated wire identity as a meeting id. */
function meetingId(id: string): MeetingMinutesId {
  return brandString<MeetingMinutesId>(id)
}

/** Plugin descriptor consumed by the Cordis loader. */
export default { name, inject, apply }
