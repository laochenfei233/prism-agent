/**
 * R5 approval contract: prompt broadcast, answerer outcomes, one-shot decisions.
 * Uses a fake host context whose `approval/request` listener is the bridge's
 * real answerer, so this covers the host boundary without a live host process.
 *
 * Port of upstream `test/approval.test.js`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Bridge } from '../src/bridge.ts'
import {
  appendSessionEvent,
  nextControlEvent,
  createFakeCtx,
  createFakeSession,
  createApprovalRequest,
  startTestBridge,
  openSse,
  postJson,
  waitFor,
  type AfterRegistry,
  type FakeCtx,
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

/** Start a bridge plus one attached `/events` consumer. */
async function fixtures(config: Record<string, unknown> = {}): Promise<{
  bridge: Bridge
  ctx: FakeCtx
  session: ReturnType<typeof createFakeSession>
  sse: Awaited<ReturnType<typeof openSse>>
  url: string
}> {
  const session = createFakeSession('session-approval')
  const ctx = createFakeCtx({ sessions: [session] })
  const { bridge, url } = await startTestBridge(t, ctx, config)
  const sse = await openSse(`${url}/events`)
  t.after(() => sse.close())
  await waitFor(() => bridge.server.hasEventSubscriber())
  return { bridge, ctx, session, sse, url } as never
}

/** Invoke the registered answerer exactly like Cordis' waterfall would. */
function answer(ctx: FakeCtx, request: unknown, next: () => unknown = () => Promise.resolve('unavailable')): Promise<string> {
  return ctx.invokeFirst('approval/request', request, next) as Promise<string>
}

describe('approval', () => {
  it('an approval prompt is broadcast and allow resolves allowed-once', async () => {
    const { ctx, session, sse, url } = await fixtures()
    const request = createApprovalRequest(session)
    const outcome = answer(ctx, request)

    const frame = await sse.next()
    expect(frame.event).toBe('approval')
    expect((frame.data as any).type).toBe('approval')
    expect((frame.data as any).seq).toBe(Number(frame.id!.split(':').pop()))
    expect((frame.data as any).sessionId).toBe('session-approval')
    expect((frame.data as any).agentId).toBe('prism-agent')
    expect((frame.data as any).tool).toBe('bash')
    expect((frame.data as any).reason).toBe('run the test suite')
    expect((frame.data as any).displayReason).toBe('Run tests?')
    expect((frame.data as any).requestId).toMatch(/^req-/)
    expect(Number.isSafeInteger((frame.data as any).expiresAtMs)).toBe(true)
    expect((frame.data as any).expiresAtMs > Date.now()).toBe(true)

    const decided = await postJson(`${url}/approval/decision`, {
      requestId: (frame.data as any).requestId,
      decision: 'allow',
    })
    expect(decided.status).toBe(200)
    expect(decided.body).toEqual({ ok: true, requestId: (frame.data as any).requestId, accepted: true })
    expect(await outcome).toBe('allowed-once')
  })

  it('deny resolves rejected', async () => {
    const { ctx, session, sse, url } = await fixtures()
    const outcome = answer(ctx, createApprovalRequest(session))
    const frame = await sse.next()
    const decided = await postJson(`${url}/approval/decision`, {
      requestId: (frame.data as any).requestId,
      decision: 'deny',
    })
    expect(decided.status).toBe(200)
    expect(await outcome).toBe('rejected')
  })

  it('an identical duplicate decision returns the original receipt', async () => {
    const { ctx, session, sse, url } = await fixtures()
    const outcome = answer(ctx, createApprovalRequest(session))
    const frame = await sse.next()
    const first = await postJson(`${url}/approval/decision`, {
      requestId: (frame.data as any).requestId,
      decision: 'allow',
    })
    expect(first.status).toBe(200)
    await outcome

    const duplicate = await postJson(`${url}/approval/decision`, {
      requestId: (frame.data as any).requestId,
      decision: 'allow',
    })
    expect(duplicate.status).toBe(200)
    expect((duplicate.body as any).ok).toBe(true)
    expect((duplicate.body as any).requestId).toBe((frame.data as any).requestId)
    expect((duplicate.body as any).accepted).toBe(true)
  })

  it('an unknown requestId answers 409 unknown-or-expired', async () => {
    const { url } = await fixtures()
    const response = await postJson(`${url}/approval/decision`, {
      requestId: 'req-does-not-exist',
      decision: 'allow',
    })
    expect(response.status).toBe(409)
    expect(response.body).toEqual({ ok: false, requestId: 'req-does-not-exist', error: 'unknown-or-expired' })
  })

  it('a decision after the timeout answers 409 unknown-or-expired', async () => {
    const { ctx, session, sse, url } = await fixtures({ approvalTimeoutMs: 120 })
    const startedAt = Date.now()
    const outcome = answer(ctx, createApprovalRequest(session))
    const frame = await sse.next()
    expect(await outcome).toBe('unavailable')
    expect(Date.now() - startedAt >= 100).toBe(true)

    const late = await postJson(`${url}/approval/decision`, {
      requestId: (frame.data as any).requestId,
      decision: 'allow',
    })
    expect(late.status).toBe(409)
    expect((late.body as any).error).toBe('unknown-or-expired')
  })

  it('aborting the host request signal fails the approval closed promptly', async () => {
    const { ctx, session, sse } = await fixtures({ approvalTimeoutMs: 60000 })
    const controller = new AbortController()
    const outcome = answer(ctx, createApprovalRequest(session, { signal: controller.signal }))
    await sse.next()
    const startedAt = Date.now()
    controller.abort()
    expect(await outcome).toBe('cancelled')
    expect(Date.now() - startedAt < 1000).toBe(true)
  })

  it('no connected HachimoDock bridge answers unavailable immediately (fail closed)', async () => {
    const session = createFakeSession('session-offline')
    const ctx = createFakeCtx({ sessions: [session] })
    await startTestBridge(t, ctx, { approvalTimeoutMs: 60000 })
    const startedAt = Date.now()
    let delegated = false
    const outcome = await answer(ctx, createApprovalRequest(session), () => {
      delegated = true
      return Promise.resolve('allowed-once')
    })
    expect(outcome).toBe('unavailable')
    expect(delegated).toBe(false)
    expect(Date.now() - startedAt < 1000).toBe(true)
  })

  it('delegate fallback hands an unanswerable request to the next answerer', async () => {
    const session = createFakeSession('session-delegate')
    const ctx = createFakeCtx({ sessions: [session] })
    await startTestBridge(t, ctx, { approvalFallback: 'delegate' })
    let delegated = 0
    const outcome = await answer(ctx, createApprovalRequest(session), () => {
      delegated += 1
      return Promise.resolve('rejected')
    })
    expect(outcome).toBe('rejected')
    expect(delegated).toBe(1)
  })

  it('two concurrent prompts keep independent request ids and decisions', async () => {
    const { ctx, session, sse, url } = await fixtures()
    const firstOutcome = answer(ctx, createApprovalRequest(session, { toolName: 'bash' }))
    const secondOutcome = answer(ctx, createApprovalRequest(session, { toolName: 'write_file' }))
    const first = await sse.next()
    const second = await sse.next()
    expect((first.data as any).requestId).not.toBe((second.data as any).requestId)
    expect((first.data as any).tool).toBe('bash')
    expect((second.data as any).tool).toBe('write_file')

    await postJson(`${url}/approval/decision`, { requestId: (second.data as any).requestId, decision: 'deny' })
    await postJson(`${url}/approval/decision`, { requestId: (first.data as any).requestId, decision: 'allow' })
    expect(await firstOutcome).toBe('allowed-once')
    expect(await secondOutcome).toBe('rejected')
  })

  it('an invalid decision body answers 400', async () => {
    const { url } = await fixtures()
    for (const body of [{}, { requestId: 'req-1' }, { decision: 'allow' }, { requestId: 42, decision: 'allow' }]) {
      const { status } = await postJson(`${url}/approval/decision`, body)
      expect(status, JSON.stringify(body)).toBe(400)
    }
  })

  it('the answerer never throws into the approval service', async () => {
    const session = createFakeSession('session-throwing')
    const ctx = createFakeCtx({ sessions: [session] })
    await startTestBridge(t, ctx)
    // No /events subscriber -> unavailable without touching the request fields.
    expect(await answer(ctx, {})).toBe('unavailable')
    expect(await answer(ctx, { agent: {} })).toBe('unavailable')
    expect(await answer(ctx, null)).toBe('unavailable')
  })

  it('official audit events are display-only and never guessed onto a request', async () => {
    const { bridge, ctx, session, sse, url } = await fixtures()
    appendSessionEvent(ctx, session, { type: 'turn/start', data: { turn: 1 } })
    appendSessionEvent(ctx, session, { type: 'tool/call', data: { turn: 1, callId: 'call-audit', name: 'bash' } })
    await nextControlEvent(sse, 'turn', session.id)
    await nextControlEvent(sse, 'tool', session.id)
    // The host appends `approval/asked` synchronously before dispatching the answerer.
    appendSessionEvent(ctx, session, {
      type: 'approval/asked',
      time: Date.now(),
      data: { id: 'dsh-approval-1', callId: 'call-audit', toolName: 'bash', reason: 'run the test suite' },
    })
    const asked = await nextControlEvent(sse, 'approval-asked', session.id)
    expect(asked.event).toBe('approval-asked')
    expect((asked.data as any).approvalId).toBe('dsh-approval-1')
    expect(bridge.server.pending.size).toBe(0)

    const outcome = answer(ctx, createApprovalRequest(session))
    const prompt = await nextControlEvent(sse, 'approval', session.id)
    expect(prompt.event).toBe('approval')
    expect((prompt.data as any).approvalId).toBeUndefined()

    await postJson(`${url}/approval/decision`, { requestId: (prompt.data as any).requestId, decision: 'allow' })
    expect(await outcome).toBe('allowed-once')

    appendSessionEvent(ctx, session, {
      type: 'approval/decided',
      time: Date.now(),
      data: { id: 'dsh-approval-1', outcome: 'allowed-once' },
    })
    const resolved = await nextControlEvent(sse, 'approval-resolved', session.id)
    expect(resolved.event).toBe('approval-resolved')
    expect((resolved.data as any).approvalId).toBe('dsh-approval-1')
    expect((resolved.data as any).requestId).toBeUndefined()
    expect((resolved.data as any).outcome).toBe('allowed-once')
  })

  it('a finite timeout emits approval-expired after the prompt', async () => {
    const { ctx, session, sse } = await fixtures({ approvalTimeoutMs: 120 })
    const outcome = answer(ctx, createApprovalRequest(session))
    const prompt = await sse.next()
    const expired = await sse.next()
    expect(expired.event).toBe('approval-expired')
    expect((expired.data as any).requestId).toBe((prompt.data as any).requestId)
    expect(await outcome).toBe('unavailable')
  })

  it('the large never sentinel never expires and still accepts a decision', async () => {
    const NEVER = 99999
    const { ctx, session, sse, url } = await fixtures({ approvalTimeoutMs: NEVER })
    const outcome = answer(ctx, createApprovalRequest(session))
    const prompt = await sse.next()
    expect((prompt.data as any).neverExpires).toBe(true)
    expect((prompt.data as any).expiresAtMs).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 180))
    const decided = await postJson(`${url}/approval/decision`, {
      requestId: (prompt.data as any).requestId,
      decision: 'allow',
    })
    expect(decided.status).toBe(200)
    expect(await outcome).toBe('allowed-once')
  })

  it('pinned official localized displayReason object preserves presentation without audit ID guessing', async () => {
    const { ctx, session, sse, url } = await fixtures()
    const outcome = answer(ctx, createApprovalRequest(session, { displayReason: { en: 'Run tests?', 'zh-CN': '运行测试？' } }))
    const frame = await sse.next()
    expect((frame.data as any).displayReason).toBe('运行测试？')
    await postJson(`${url}/approval/decision`, { requestId: (frame.data as any).requestId, decision: 'deny' })
    expect(await outcome).toBe('rejected')
  })
})
