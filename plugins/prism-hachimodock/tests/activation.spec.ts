/**
 * Conversation switching: the bridge `/sessions/activate` bus route fans the
 * validated session id out to same-origin SSE subscribers. Live events only,
 * no replay, and unknown session ids never reach the hub.
 *
 * New capability: not present upstream.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createFakeCtx, createFakeSession, postJson, startTestBridge, type AfterRegistry } from './helpers.ts'
import { ACTIVATION_PATH, ActivationHub } from '../src/activation.ts'

let cleanups: Array<() => unknown | Promise<unknown>> = []
const t: AfterRegistry = {
  after(dispose) {
    cleanups.push(dispose)
  },
}
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose()
})

/** Read the first raw SSE block (comment or frame) with a bounded wait. */
async function nextBlock(response: Response, timeoutMs = 3000): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const index = buffer.indexOf('\n\n')
    if (index >= 0) {
      void reader.cancel().catch(() => {})
      return buffer.slice(0, index)
    }
    if (Date.now() > deadline) {
      void reader.cancel().catch(() => {})
      throw new Error('timed out waiting for activation block')
    }
    const chunk = await reader.read()
    if (chunk.done) throw new Error('activation stream closed early')
    buffer += decoder.decode(chunk.value, { stream: true })
  }
}

/** Read one SSE frame from a Response with a bounded wait. */
async function nextFrame(response: Response, timeoutMs = 3000): Promise<{ event?: string; data?: any }> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const index = buffer.indexOf('\n\n')
    if (index >= 0) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      let event: string | undefined
      let data: string | undefined
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        if (line.startsWith('data:')) data = line.slice(5).trimStart()
      }
      if (event !== undefined && data !== undefined) {
        void reader.cancel().catch(() => {})
        return { event, data: JSON.parse(data) }
      }
      continue
    }
    if (Date.now() > deadline) {
      void reader.cancel().catch(() => {})
      throw new Error('timed out waiting for activation frame')
    }
    const chunk = await reader.read()
    if (chunk.done) throw new Error('activation stream closed early')
    buffer += decoder.decode(chunk.value, { stream: true })
  }
}

describe('activation hub', () => {
  it('activate broadcasts a session-activated event to connected subscribers', async () => {
    const hub = new ActivationHub()
    const response = hub.subscribe(new Request('http://127.0.0.1' + ACTIVATION_PATH))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    const done = nextFrame(response)
    hub.activate('session-9')
    const frame = await done
    expect(frame.event).toBe('session-activated')
    expect(frame.data).toEqual({ type: 'session-activated', sessionId: 'session-9', at: expect.any(Number) })
  })

  it('a subscriber that connected later never receives past activations', async () => {
    const hub = new ActivationHub()
    hub.activate('first')
    const response = hub.subscribe(new Request('http://127.0.0.1' + ACTIVATION_PATH))
    const connected = await nextBlock(response)
    // Only the comment ack, never a replayed activation.
    expect(connected).toContain(': connected')
    void response.body!.cancel().catch(() => {})
  })

  it('clients above the cap are refused with 503', () => {
    const hub = new ActivationHub()
    const clients: Response[] = []
    for (let i = 0; i < 8; i++) clients.push(hub.subscribe(new Request('http://127.0.0.1' + ACTIVATION_PATH)))
    const refused = hub.subscribe(new Request('http://127.0.0.1' + ACTIVATION_PATH))
    expect(refused.status).toBe(503)
    for (const response of clients) void response.body!.cancel().catch(() => {})
  })

  it('abort drops the subscriber so a later activation is not written', async () => {
    const hub = new ActivationHub()
    const controller = new AbortController()
    const response = hub.subscribe(new Request('http://127.0.0.1' + ACTIVATION_PATH, { signal: controller.signal }))
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 10))
    // No throw: the hub tolerates writes to dropped clients.
    hub.activate('after-abort')
    void response.body!.cancel().catch(() => {})
  })
})

describe('activation route', () => {
  it('POST /sessions/activate with a live session fans out to the hub', async () => {
    const session = createFakeSession('switch-me')
    const ctx = createFakeCtx({ sessions: [session] })
    const hub = new ActivationHub()
    const { bridge, url } = await startTestBridge(t, ctx)
    bridge.server.activate = ({ sessionId }) => hub.activate(sessionId)
    const response = hub.subscribe(new Request('http://127.0.0.1' + ACTIVATION_PATH))
    const pending = nextFrame(response)
    const r = await postJson(url + '/sessions/activate', { sessionId: 'switch-me' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, sessionId: 'switch-me' })
    const frame = await pending
    expect(frame.event).toBe('session-activated')
    expect(frame.data.sessionId).toBe('switch-me')
    void response.body!.cancel().catch(() => {})
  })

  it('unknown, auto, and malformed session ids are refused before the hub', async () => {
    const ctx = createFakeCtx({ sessions: [createFakeSession('known')] })
    let activations = 0
    const { bridge, url } = await startTestBridge(t, ctx)
    bridge.server.activate = () => { activations += 1 }
    expect((await postJson(url + '/sessions/activate', { sessionId: 'unknown' })).status).toBe(400)
    expect((await postJson(url + '/sessions/activate', { sessionId: 'auto' })).status).toBe(400)
    expect((await postJson(url + '/sessions/activate', { sessionId: '' })).status).toBe(400)
    expect((await postJson(url + '/sessions/activate', { sessionId: 'known', extra: true })).status).toBe(400)
    expect(activations).toBe(0)
  })

  it('the activation route requires bus authentication like every bus route', async () => {
    const ctx = createFakeCtx({ sessions: [createFakeSession('known')] })
    const { bridge, url } = await startTestBridge(t, ctx)
    let activations = 0
    bridge.server.activate = () => { activations += 1 }
    // Raw fetch: no automatic test credentials.
    const r = await fetch(url + '/sessions/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'known' }),
    })
    expect(r.status).toBe(401)
    await r.text()
    expect(activations).toBe(0)
  })
})
