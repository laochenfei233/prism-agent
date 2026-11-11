/**
 * `/inject` and `/interrupt` contracts: exact-session admission, bounded
 * frames, receipts that invalid requests cannot consume or evict, and the
 * official SessionController shapes.
 *
 * Port of upstream `test/inject.test.js` and `test/interrupt.test.js`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createFakeCtx, createFakeSession, openSse, postJson, startTestBridge, startTestServer, type AfterRegistry } from './helpers.ts'

let cleanups: Array<() => unknown | Promise<unknown>> = []
const t: AfterRegistry = {
  after(dispose) {
    cleanups.push(dispose)
  },
}
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose()
})

const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ sessionId: 's1', requestId: randomUUID(), text: 'hello', ...extra })
const opts = (b: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })

describe('inject', () => {
  it('inject transport preserves bounded token/tool and terminal adapter frames', async () => {
    const { url } = await startTestServer(t, {
      listSessions: () => [{ id: 's1' } as never],
      inject: async ({ emit, sessionId, requestId }) => {
        expect(sessionId).toBe('s1')
        expect(requestId).toBeTruthy()
        emit({ type: 'token', text: 'answer' })
        emit({ type: 'tool', name: 'bash', phase: 'end', ok: false })
        emit({ type: 'done', sessionId, tokens: 2, stopReason: 'admitted' })
      },
    })
    const sse = await openSse(url + '/inject', opts(body()))
    t.after(() => sse.close())
    expect((await sse.next() as any).data.text).toBe('answer')
    expect((await sse.next() as any).data.ok).toBe(false)
    expect((await sse.next() as any).data.stopReason).toBe('admitted')
  })

  it('inject requires explicit existing session and requestId before adapter entry', async () => {
    let calls = 0
    const { url } = await startTestServer(t, { listSessions: () => [{ id: 's1' } as never], inject: async () => { calls++ } })
    for (const b of [body({ sessionId: 'auto' }), body({ sessionId: '' }), body({ sessionId: 'other' }), { text: 'hello' }, body({ requestId: '' })]) {
      expect((await postJson(url + '/inject', b)).status).toBe(400)
    }
    expect(calls).toBe(0)
  })

  it('inject rejects invalid text/shape/unknown fields before opening stream', async () => {
    const { url } = await startTestServer(t, { listSessions: () => [{ id: 's1' } as never] })
    for (const b of [body({ text: '' }), body({ text: ' '.repeat(4) }), body({ text: 'x'.repeat(32769) }), [], null, body({ extra: true })]) {
      expect((await postJson(url + '/inject', b)).status).toBe(400)
    }
  })

  it('adapter exception is an error frame, not a completion claim', async () => {
    const { url } = await startTestServer(t, { listSessions: () => [{ id: 's1' } as never], inject: async () => { throw new Error('failed') } })
    const sse = await openSse(url + '/inject', opts(body()))
    t.after(() => sse.close())
    expect((await sse.next()).event).toBe('error')
  })

  it('inject deadline aborts a stalled adapter with an error', async () => {
    let signal: AbortSignal | undefined
    const { url } = await startTestServer(t, {
      injectTimeoutMs: 30,
      listSessions: () => [{ id: 's1' } as never],
      inject: async (a) => {
        signal = a.signal
        return new Promise(() => {})
      },
    })
    const sse = await openSse(url + '/inject', opts(body()))
    t.after(() => sse.close())
    expect((await sse.next()).event).toBe('error')
    expect(signal?.aborted).toBe(true)
  })

  it('same requestId is never re-admitted by this bridge', async () => {
    let calls = 0
    const { url } = await startTestServer(t, {
      listSessions: () => [{ id: 's1' } as never],
      inject: async ({ emit }) => {
        calls++
        emit({ type: 'done', sessionId: 's1' })
      },
    })
    const b = body()
    const sse = await openSse(url + '/inject', opts(b))
    await sse.next()
    sse.close()
    expect((await postJson(url + '/inject', b)).status).toBe(409)
    expect(calls).toBe(1)
  })

  it('invalid inject text cannot consume or evict request receipts', async () => {
    let calls = 0
    const { server, url } = await startTestServer(t, {
      listSessions: () => [{ id: 's1' } as never],
      inject: async ({ emit }) => {
        calls++
        emit({ type: 'done', sessionId: 's1' })
      },
    })
    const req = body()
    const sse = await openSse(url + '/inject', opts(req))
    await sse.next()
    sse.close()
    for (let i = 0; i < 256; i++) expect((await postJson(url + '/inject', body({ text: '' }))).status).toBe(400)
    expect(server.injecting.size).toBe(1)
    expect((await postJson(url + '/inject', req)).status).toBe(409)
    expect(calls).toBe(1)
  })

  it('bounded receipt eviction preserves an in-flight inject request', async () => {
    const active = body()
    let activeCalls = 0
    let release: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const { server, url } = await startTestServer(t, {
      listSessions: () => [{ id: 's1' } as never],
      inject: async ({ requestId, emit }) => {
        if (requestId === active.requestId) {
          activeCalls++
          await pending
        }
        emit({ type: 'done', sessionId: 's1' })
      },
    })
    t.after(() => release!())
    const first = await openSse(url + '/inject', opts(active))
    t.after(() => first.close())
    try {
      for (let i = 0; i < 257; i++) {
        const sse = await openSse(url + '/inject', opts(body()))
        await sse.next()
        sse.close()
      }
      expect(server.injecting.size <= 256).toBe(true)
      expect(server.injecting.has(active.requestId as string)).toBe(true)
      expect((await postJson(url + '/inject', active)).status).toBe(409)
      expect(activeCalls).toBe(1)
      release!()
      await first.next()
      expect((await postJson(url + '/inject', active)).status).toBe(409)
    } finally {
      release!()
      first.close()
    }
  })

  it('prompt uses the exact SessionController queue request and reports only admission', async () => {
    const a = createFakeSession('s1')
    const b = createFakeSession('s2')
    let received: unknown
    const ctx = createFakeCtx({ sessions: [a, b] })
    ctx.sessionController = { prompt: async (r, signal) => { received = r; expect(signal).toBeTruthy(); return { accepted: true } } }
    const { bridge, url } = await startTestBridge(t, ctx)
    expect(bridge.resolveTargetSession('auto')).toBeUndefined()
    const req = body()
    const sse = await openSse(url + '/inject', opts(req))
    t.after(() => sse.close())
    const frame = await sse.next()
    expect(received).toEqual({ requestId: req.requestId, sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] })
    expect((frame.data as any).stopReason).toBe('admitted')
    expect((frame.data as any).tokens).toBe(0)
  })

  it('unsupported SessionController fails closed without guessed agent APIs', async () => {
    const session = createFakeSession('s1')
    const ctx = createFakeCtx({ sessions: [session] })
    const { url } = await startTestBridge(t, ctx)
    const sse = await openSse(url + '/inject', opts(body()))
    t.after(() => sse.close())
    expect((await sse.next() as any).data.code).toBe('session-controller-unavailable')
  })

  it('lost prompt admission receipt is unknown and not blindly retried', async () => {
    const ctx = createFakeCtx({ sessions: [createFakeSession('s1')] })
    let n = 0
    ctx.sessionController = { prompt: async () => { n++; throw new Error('lost response') } }
    const { url } = await startTestBridge(t, ctx)
    const req = body()
    const sse = await openSse(url + '/inject', opts(req))
    t.after(() => sse.close())
    expect((await sse.next() as any).data.code).toBe('delivery-unknown')
    expect((await postJson(url + '/inject', req)).status).toBe(409)
    expect(n).toBe(1)
  })
})

describe('interrupt', () => {
  it('interrupt uses the exact-session cancel and preserves its admission semantics', async () => {
    const ctx = createFakeCtx({ sessions: [createFakeSession('a'), createFakeSession('b')] })
    const cancelled: unknown[] = []
    ctx.sessionController = { cancel: (r) => { cancelled.push(r); return { accepted: true } } }
    const { url } = await startTestBridge(t, ctx)
    const r = await postJson(url + '/interrupt', { sessionId: 'a' })
    expect(r.status).toBe(200)
    expect((r.body as any).state).toBe('cancel-requested')
    expect(cancelled).toEqual([{ sessionId: 'a' }])
    expect((await postJson(url + '/interrupt', { sessionId: 'auto' })).status).toBe(400)
    expect(cancelled.length).toBe(1)
  })

  it('missing official cancel service does not fall back to agent.cancel', async () => {
    const ctx = createFakeCtx({ sessions: [createFakeSession('a')] })
    const { url } = await startTestBridge(t, ctx)
    expect((await postJson(url + '/interrupt', { sessionId: 'a' })).status).toBe(409)
  })
})
