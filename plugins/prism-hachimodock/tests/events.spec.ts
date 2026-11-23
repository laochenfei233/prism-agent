/**
 * GET /events SSE contract: cursor replay, live forwarding, compact session
 * event translation (turn/tool/title/session), and payload bounds.
 *
 * Port of upstream `test/events.test.js` with the prism agent identity.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  appendSessionEvent,
  nextControlEvent,
  createFakeAgent,
  createFakeCtx,
  createFakeSession,
  startTestBridge,
  startTestServer,
  openSse,
  requestJson,
  waitFor,
  type AfterRegistry,
} from './helpers.ts'

let cleanups: Array<() => unknown | Promise<unknown>> = []
const t: AfterRegistry = {
  after(dispose) {
    cleanups.push(dispose)
  },
}
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose()
})

describe('events', () => {
  it('events without an after cursor only stream new events', async () => {
    const { server, url } = await startTestServer(t)
    server.publish('turn', { sessionId: 'before', phase: 'start' })
    const sse = await openSse(`${url}/events`)
    t.after(() => sse.close())
    await waitFor(() => server.hasEventSubscriber())
    server.publish('turn', { sessionId: 'after', phase: 'start' })
    const frame = await sse.next()
    expect(frame.event).toBe('turn')
    expect((frame.data as any).sessionId).toBe('after')
    expect((frame.data as any).seq).toBe(2)
    expect(frame.id).toBe(`${server.epoch}:native-relay:2`)
  })

  it('events?after=<seq> replays the retained window after the cursor', async () => {
    const { server, url } = await startTestServer(t)
    server.publish('turn', { sessionId: 's1', phase: 'start' })
    server.publish('tool', { sessionId: 's1', phase: 'start', name: 'bash' })
    server.publish('session-title', { sessionId: 's1', title: 'A title' })
    const sse = await openSse(`${url}/events?after=${server.epoch}:native-relay:1`)
    t.after(() => sse.close())
    const first = await sse.next()
    expect(first.id).toBe(`${server.epoch}:native-relay:2`)
    expect(first.event).toBe('tool')
    const second = await sse.next()
    expect(second.id).toBe(`${server.epoch}:native-relay:3`)
    expect(second.event).toBe('session-title')
    expect((second.data as any).title).toBe('A title')
  })

  it('events?after rejects a non-numeric cursor with 400', async () => {
    const { server, url } = await startTestServer(t)
    for (const after of ['abc', '-1', '1.5']) {
      const { status, body } = await requestJson(`${url}/events?after=${server.epoch}:native-relay:${after}`)
      expect(status, after).toBe(400)
      expect((body as any).error).toBe('invalid-after')
    }
  })

  it('session/event forwarding emits compact turn, tool, title and approval events', async () => {
    const session = createFakeSession('session-events', { cwd: '/tmp/events' })
    const ctx = createFakeCtx({ sessions: [session] })
    const { bridge, url } = await startTestBridge(t, ctx)
    const sse = await openSse(`${url}/events?after=${bridge.server.epoch}:native-relay:0`)
    t.after(() => sse.close())
    await waitFor(() => bridge.server.hasEventSubscriber())
    appendSessionEvent(ctx, session, { type: 'turn/start', time: 1000, data: { turn: 1 } })
    appendSessionEvent(ctx, session, {
      type: 'tool/call',
      time: 1001,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"cmd":"ls"}' },
    })
    // Official asked audit can omit turn, but must identify the still-current call.
    appendSessionEvent(ctx, session, {
      type: 'approval/asked',
      time: 1002,
      data: { id: 'approval-1', callId: 'call-1', toolName: 'bash', reason: 'go' },
    })
    appendSessionEvent(ctx, session, {
      type: 'approval/decided',
      time: 1003,
      data: { id: 'approval-1', outcome: 'rejected' },
    })
    appendSessionEvent(ctx, session, {
      type: 'tool/result',
      time: 1004,
      data: { turn: 1, step: 1, message: { toolCallId: 'call-1', isError: true } },
    })
    appendSessionEvent(ctx, session, {
      type: 'session/title',
      time: 1005,
      data: { title: 'Refactor the bridge', messageSeqs: [0], source: { kind: 'user' } },
    })
    appendSessionEvent(ctx, session, { type: 'turn/end', time: 1006, data: { turn: 1, reason: { kind: 'completed' } } })
    const next = (kind: string) => nextControlEvent(sse, kind, session.id)
    const start = await next('turn')
    expect((start.data as any).phase).toBe('start')
    expect((start.data as any).state).toBe('working')
    const call = await next('tool')
    expect((call.data as any).name).toBe('bash')
    expect((call.data as any).callId).toBe('call-1')
    expect((call.data as any).ok).toBe(true)
    expect('arguments' in (call.data as object)).toBe(false)
    const asked = await next('approval-asked')
    expect((asked.data as any).approvalId).toBe('approval-1')
    expect((asked.data as any).state).toBe('waiting_user')
    expect((asked.data as any).waitKind).toBe('toolapproval')
    const decided = await next('approval-resolved')
    expect((decided.data as any).outcome).toBe('rejected')
    const result = await next('tool')
    expect((result.data as any).phase).toBe('end')
    expect((result.data as any).ok).toBe(false)
    const title = await next('session-title')
    expect((title.data as any).title).toBe('Refactor the bridge')
    const end = await next('turn')
    expect((end.data as any).phase).toBe('end')
    expect((end.data as any).state).toBe('done')
    expect(bridge.server.pending.size).toBe(0)
  })

  it('title/session summaries expose tracked state and stay bounded', async () => {
    const session = createFakeSession('session-summary', { cwd: '/tmp/summary' })
    const ctx = createFakeCtx({ sessions: [session] })
    const agent = createFakeAgent(session)
    agent.status = 'running'
    ctx.addAgent(agent)
    const { bridge, url } = await startTestBridge(t, ctx)
    const sse = await openSse(`${url}/events?after=${bridge.server.epoch}:native-relay:0`)
    t.after(() => sse.close())
    await waitFor(() => bridge.server.hasEventSubscriber())

    const longTitle = 'x'.repeat(400)
    appendSessionEvent(ctx, session, {
      type: 'session/title',
      time: 4242,
      data: { title: longTitle, messageSeqs: [], source: { kind: 'user' } },
    })
    const titleFrame = await nextControlEvent(sse, 'session-title', session.id)
    expect((titleFrame.data as any).title.length <= 160).toBe(true)

    const { body } = await requestJson(`${url}/sessions`)
    expect((body as any).sessions.length).toBe(1)
    expect((body as any).sessions[0].id).toBe('session-summary')
    expect((body as any).sessions[0].cwd).toBe('/tmp/summary')
    expect((body as any).sessions[0].status).toBe('running')
    expect((body as any).sessions[0].agentId).toBe('prism-agent')
    expect((body as any).sessions[0].lastModified).toBe(4242)
    expect((body as any).sessions[0].title.length <= 160).toBe(true)

    const afterTitle = await sse.next()
    expect(afterTitle.event).toBe('session')
    expect((afterTitle.data as any).session.status).toBe('running')

    // agent/status transitions publish a fresh session summary.
    agent.status = 'idle'
    void ctx.dispatchSync('agent/status', { status: 'idle', agent })
    const summaryFrame = await sse.next()
    expect(summaryFrame.event).toBe('session')
    expect((summaryFrame.data as any).session.status).toBe('idle')
  })

  it('session/created publishes a summary and session/disposed publishes removal', async () => {
    const session = createFakeSession('session-lifecycle')
    const ctx = createFakeCtx({ sessions: [session] })
    const { bridge, url } = await startTestBridge(t, ctx)
    const sse = await openSse(`${url}/events?after=${bridge.server.epoch}:native-relay:0`)
    t.after(() => sse.close())
    await waitFor(() => bridge.server.hasEventSubscriber())
    ctx.dispatchSync('session/created', session)
    const created = await sse.next()
    expect(created.event).toBe('session')
    expect((created.data as any).session.id).toBe('session-lifecycle')
    ctx.dispatchSync('session/disposed', session)
    const disposed = await sse.next()
    expect(disposed.event).toBe('session')
    expect((disposed.data as any).session.removed).toBe(true)
  })

  it('sessions with no title read the optional sessionTitle projection', async () => {
    const session = createFakeSession('session-title-service')
    const ctx = createFakeCtx({
      sessions: [session],
      services: {
        sessionTitle: {
          get: (target: unknown) => (target === session ? { title: 'from service' } : undefined),
        },
      },
    })
    const { url } = await startTestBridge(t, ctx)
    const { body } = await requestJson(`${url}/sessions`)
    expect((body as any).sessions[0].title).toBe('from service')
  })

  it('the replay buffer is bounded', async () => {
    const { server, url } = await startTestServer(t)
    for (let index = 0; index < 600; index += 1) server.publish('turn', { index })
    const sse = await openSse(`${url}/events?after=${server.epoch}:native-relay:0`)
    t.after(() => sse.close())
    // Only the retained tail is replayed; the newest event is always present.
    const replay = server.events
    expect(replay.length <= 512).toBe(true)
    expect((replay[replay.length - 1] as any).index).toBe(599)
    const first = await sse.next()
    expect((first.data as any).index).toBe(600 - replay.length)
  })

  it('tool/call publishes tool_running and tool/result returns to working', async () => {
    const session = createFakeSession('session-tool-state', { cwd: '/tmp/tool-state' })
    const ctx = createFakeCtx({ sessions: [session] })
    const { bridge, url } = await startTestBridge(t, ctx)
    await waitFor(() => bridge.server.hasEventSubscriber() === false)

    appendSessionEvent(ctx, session, { type: 'turn/start', time: 2000, data: { turn: 1 } })
    appendSessionEvent(ctx, session, {
      type: 'tool/call',
      time: 2001,
      data: { turn: 1, step: 1, callId: 'call-state', name: 'bash', arguments: '{"cmd":"sleep 1"}' },
    })
    let { body } = await requestJson(`${url}/sessions`)
    expect((body as any).sessions[0].state).toBe('tool_running')
    const toolRevision = (body as any).sessions[0].transitionRevision

    appendSessionEvent(ctx, session, {
      type: 'tool/result',
      time: 2002,
      data: { turn: 1, step: 1, message: { callId: 'call-state' } },
    })
    ;({ body } = await requestJson(`${url}/sessions`))
    expect((body as any).sessions[0].state).toBe('working')
    expect((body as any).sessions[0].transitionRevision > toolRevision).toBe(true)
  })

  it('assistant text is exposed as bounded displayContent for the P4 body', async () => {
    const session = createFakeSession('session-assistant-text', { cwd: '/tmp/text' })
    const ctx = createFakeCtx({ sessions: [session] })
    const { url } = await startTestBridge(t, ctx)
    appendSessionEvent(ctx, session, {
      type: 'assistant/message',
      time: 5000,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'hidden reasoning' },
            { type: 'text', text: '### 标题\n**粗体**\n- 列表' },
            { type: 'tool-call', id: 'call-text', name: 'bash', arguments: '{}' },
          ],
        },
      },
    })
    const { body } = await requestJson(`${url}/sessions`)
    expect((body as any).sessions[0].displayContent).toBe('### 标题\n**粗体**\n- 列表')
    expect((body as any).sessions[0].displayContent.includes('hidden reasoning')).toBe(false)
  })

  it('stopped turns remain distinct from completed state', async () => {
    const session = createFakeSession('session-stopped')
    const ctx = createFakeCtx({ sessions: [session] })
    const { url } = await startTestBridge(t, ctx)

    appendSessionEvent(ctx, session, { type: 'turn/start', time: 7000, data: { turn: 1 } })
    appendSessionEvent(ctx, session, {
      type: 'turn/end',
      time: 7001,
      data: { turn: 1, reason: { kind: 'aborted', reason: 'user' } },
    })
    let { body } = await requestJson(`${url}/sessions`)
    expect((body as any).sessions[0].state).toBe('stopped')

    appendSessionEvent(ctx, session, { type: 'turn/start', time: 7002, data: { turn: 2 } })
    appendSessionEvent(ctx, session, {
      type: 'turn/end',
      time: 7003,
      data: { turn: 2, reason: { kind: 'completed' } },
    })
    ;({ body } = await requestJson(`${url}/sessions`))
    expect((body as any).sessions[0].state).toBe('done')
  })

  it('live state rejects duplicate sequence, old turn and gaps without guessing completion', async () => {
    const session = createFakeSession('live-negative')
    const ctx = createFakeCtx({ sessions: [session] })
    const { bridge } = await startTestBridge(t, ctx)
    const emit = (type: string, data: Record<string, unknown>): unknown[] => appendSessionEvent(ctx, session, { type, data })
    const state = (): string => bridge.summarizeSession(session).state
    emit('turn/start', { turn: 1 })
    expect(state()).toBe('working')
    ctx.dispatchSync('session/event', session, { seq: 0, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    expect(state()).toBe('working')
    emit('tool/call', { turn: 0, callId: 'old', name: 'bash' })
    expect(state()).toBe('working')
    emit('tool/call', { turn: 1, callId: 'current', name: 'bash' })
    expect(state()).toBe('tool_running')
    session.seq += 2
    ctx.dispatchSync('session/event', session, { seq: session.seq - 1, type: 'assistant/message', data: {} })
    expect(state()).toBe('unknown')
  })

  it('missing event fields and uncorrelated approval audits stay unknown and cannot grant', async () => {
    const session = createFakeSession('unsupported-audit')
    const ctx = createFakeCtx({ sessions: [session] })
    const { bridge } = await startTestBridge(t, ctx)
    ctx.dispatchSync('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    expect(bridge.summarizeSession(session).state).toBe('unknown')
    appendSessionEvent(ctx, session, { type: 'turn/start', data: { turn: 1 } })
    appendSessionEvent(ctx, session, { type: 'approval/asked', data: { id: 'unbound', toolName: 'bash' } })
    expect(bridge.summarizeSession(session).state).toBe('unknown')
    expect(bridge.server.pending.size).toBe(0)
  })

  it('question continuation resumes only on admitted exact call and unknown end reason never becomes done', async () => {
    const session = createFakeSession('question-resume')
    const ctx = createFakeCtx({ sessions: [session] })
    const { bridge } = await startTestBridge(t, ctx)
    const emit = (type: string, data: Record<string, unknown>): unknown[] => appendSessionEvent(ctx, session, { type, data })
    const state = (): any => bridge.summarizeSession(session)
    emit('turn/start', { turn: 1 })
    emit('tool/call', { turn: 1, callId: 'q', name: 'ask_user_question' })
    expect(state().state).toBe('waiting_user')
    expect(state().waitKind).toBe('question')
    emit('tool/result', { turn: 1, message: { toolCallId: 'wrong', content: [{ type: 'text', text: '{"answers":[]}' }] } })
    expect(state().state).toBe('waiting_user')
    emit('tool/result', { turn: 1, message: { toolCallId: 'q', content: [{ type: 'text', text: '{"pending":true}' }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(state().state).toBe('waiting_user')
    emit('user/message', { source: { kind: 'user-question-reply', callId: 'wrong' } })
    expect(state().state).toBe('waiting_user')
    emit('user/message', { source: { kind: 'user-question-reply', callId: 'q' } })
    expect(state().state).toBe('unknown')
    emit('turn/start', { turn: 2 })
    expect(state().state).toBe('working')
    emit('approval/asked', { turn: 1, id: 'late', toolName: 'bash' })
    expect(state().state).toBe('working')
    emit('turn/end', { turn: 2, reason: { kind: 'future-unknown' } })
    expect(state().state).toBe('unknown')
  })
})
