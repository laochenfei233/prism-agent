/**
 * Transport contract: health, sessions, routing, body limits.
 * Runs against the real transport with fake adapter deps (no host process).
 *
 * Port of upstream `test/health-sessions.test.js`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { SessionSummary } from '../src/types.ts'
import { BridgeServer, isLoopbackAddress, MAX_BODY_BYTES } from '../src/server.ts'
import { createFakeSession, requestJson, startTestServer, type AfterRegistry } from './helpers.ts'

let cleanups: Array<() => unknown | Promise<unknown>> = []
const t: AfterRegistry = {
  after(dispose) {
    cleanups.push(dispose)
  },
}
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose()
})

function fakeSummaries(): SessionSummary[] {
  return [
    {
      id: 'session-a',
      title: 'Fix the firmware build',
      cwd: '/Users/dev/project',
      lastModified: 1790000000000,
      status: 'running',
      agentId: 'prism-agent',
    },
    {
      id: 'session-b',
      title: null,
      cwd: null,
      lastModified: 1789999999000,
      status: 'idle',
      agentId: 'prism-agent',
    },
  ] as unknown as SessionSummary[]
}

describe('health and sessions', () => {
  it('GET /health reports protocol version, session count, and pending approvals', async () => {
    const { url } = await startTestServer(t, { listSessions: fakeSummaries })
    const { status, body } = await requestJson(`${url}/health`)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, version: 2 })
  })

  it('GET /health counts pending approval requests', async () => {
    const { server, url } = await startTestServer(t, { listSessions: fakeSummaries })
    const prompt = server.requestApproval({ agentId: 'prism-agent', sessionId: 'session-a', tool: 'bash' })
    const { body } = await requestJson(`${url}/health`)
    expect((body as any).pendingApprovals).toBeUndefined()
    server.decideApproval(prompt.requestId, 'deny')
    await prompt.outcome
    const after = await requestJson(`${url}/health`)
    expect((after.body as any).pendingApprovals).toBeUndefined()
  })

  it('GET /sessions returns the adapter summaries in order', async () => {
    const { url } = await startTestServer(t, { listSessions: fakeSummaries })
    const { status, body } = await requestJson(`${url}/sessions`)
    expect(status).toBe(200)
    expect((body as any).sessions.length).toBe(2)
    expect((body as any).sessions[0]).toEqual(fakeSummaries()[0])
    expect((body as any).sessions[1].title).toBe(null)
  })

  it('GET /sessions tolerates a throwing adapter', async () => {
    const { url } = await startTestServer(t, {
      listSessions: () => {
        throw new Error('session store exploded')
      },
    })
    const { status, body } = await requestJson(`${url}/sessions`)
    expect(status).toBe(500)
    expect((body as any).ok).toBe(false)
  })

  it('unknown routes answer 404 JSON', async () => {
    const { url } = await startTestServer(t)
    const { status, body } = await requestJson(`${url}/nope`)
    expect(status).toBe(404)
    expect(body).toEqual({ ok: false, error: 'not-found' })
  })

  it('wrong methods answer 405 JSON', async () => {
    const { url } = await startTestServer(t)
    for (const [path, method] of [
      ['/health', 'POST'],
      ['/sessions', 'POST'],
      ['/inject', 'GET'],
      ['/events', 'POST'],
      ['/approval/decision', 'GET'],
    ] as const) {
      const { status } = await requestJson(`${url}${path}`, { method, headers: { 'content-type': 'application/json' } })
      expect(status, `${method} ${path}`).toBe(405)
    }
  })

  it('invalid JSON bodies answer 400 invalid-json', async () => {
    const { url } = await startTestServer(t)
    for (const path of ['/inject', '/approval/decision']) {
      const { status, body } = await requestJson(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      })
      expect(status, path).toBe(400)
      expect((body as any).error).toBe('invalid-json')
    }
  })

  it('an over-limit body answers 413 without buffering it', async () => {
    const { server, url } = await startTestServer(t)
    const oversized = 'x'.repeat(MAX_BODY_BYTES + 1)
    const response = await fetch(`${url}/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${server.tokens.bus}` },
      body: JSON.stringify({ sessionId: 'auto', text: oversized }),
    })
    expect(response.status).toBe(413)
    const body: any = await response.json()
    expect(body.error).toBe('payload-too-large')
  })

  it('loopback address classification', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('10.0.0.2')).toBe(false)
    expect(isLoopbackAddress('::ffff:10.0.0.2')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })

  it('the server only binds 127.0.0.1', async () => {
    const server = new BridgeServer({ port: 0, writeBootstrap: false })
    await server.listen(0)
    t.after(() => server.close())
    expect(server.host).toBe('127.0.0.1')
    expect(server.url().startsWith('http://127.0.0.1:')).toBe(true)
  })

  it('pending approvals are failed closed when the server closes', async () => {
    const server = new BridgeServer({ port: 0, writeBootstrap: false })
    await server.listen(0)
    const prompt = server.requestApproval({ agentId: 'prism-agent', sessionId: 's', tool: 'bash' })
    await server.close()
    expect(await prompt.outcome).toBe('unavailable')
  })

  it('contract-shaped session summary survives a session JSON round-trip', async () => {
    // The adapter produces the summary; the transport must not reshape it.
    const session = createFakeSession('session-c', { cwd: '/tmp/x' })
    const summary = {
      id: session.id,
      title: 'A title',
      cwd: session.header?.cwd,
      lastModified: session.header?.createdAt,
      status: 'idle',
      agentId: 'prism-agent',
    }
    const { url } = await startTestServer(t, { listSessions: () => [summary as never] })
    const { body } = await requestJson(`${url}/sessions`)
    expect((body as any).sessions).toEqual([summary])
  })
})
