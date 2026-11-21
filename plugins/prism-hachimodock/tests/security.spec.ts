/**
 * Security contract: authentication, origin, loopback policy, JSON bounds,
 * pairing, approval decisions, replay cursors, subscriber bounds, and the
 * private capability descriptor store.
 *
 * Port of upstream `test/security.test.js` with the prism descriptor store.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { BridgeServer } from '../src/server.ts'
import { createCapabilityStore, secret } from '../src/capability.ts'
import { createFakeCtx, createFakePosixFs, createFakeSession, createApprovalRequest, openSse, startTestBridge, startTestServer, waitFor, type AfterRegistry } from './helpers.ts'

const ORIGIN = 'https://dsh.example.test:7443'
const DIR = '/private/prism'
const FILE = '/private/prism/capability.json'
const bearer = (s: BridgeServer, role: 'relay' | 'bus' | 'voice'): Record<string, string> => ({ Authorization: `Bearer ${s.tokens[role]}` })

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: r.status, body: (await r.json()) as any }
}

function raw(s: BridgeServer, target: string, headers: Record<string, string> = {}, method = 'GET'): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: s.listeningPort as number, path: target, method, headers }, r => {
      r.resume()
      r.on('end', () => resolve(r.statusCode))
    })
    req.on('error', reject)
    req.end()
  })
}

let cleanups: Array<() => unknown | Promise<unknown>> = []
const t: AfterRegistry = {
  after(dispose) {
    cleanups.push(dispose)
  },
}
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose()
})

describe('security', () => {
  it('all sensitive routes reject unauthenticated and forged role/query credentials before dispatch', async () => {
    const { server: s, url } = await startTestServer(t)
    for (const p of ['/sessions', '/events?role=bridge', '/events?token=guess', '/inject', '/interrupt', '/voice/begin', '/voice/draft', '/voice/submit', '/approval/decision', '/sessions/activate']) {
      const r = await fetch(url + p, p.startsWith('/events') || p === '/sessions' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      expect([401, 403].includes(r.status), p).toBe(true)
      await r.text()
    }
    expect(s.pending.size).toBe(0)
    expect(s.subscribers.size).toBe(0)
    expect(s.utterances.size).toBe(0)
  })

  it('exact Origin and credential role both required; no wildcard and no origin reflection', async () => {
    const { server: s, url } = await startTestServer(t, { allowedOrigins: [ORIGIN] })
    for (const origin of ['https://evil.test', 'null', 'http://dsh.example.test:7443', 'https://dsh.example.test:7444', `${ORIGIN}.evil`]) {
      const r = await fetch(url + '/sessions', { headers: { ...bearer(s, 'bus'), Origin: origin } })
      expect(r.status).toBe(403)
      expect(r.headers.get('access-control-allow-origin')).toBe(null)
      await r.text()
    }
    const nativeWithOrigin = await fetch(url + '/sessions', { headers: { ...bearer(s, 'bus'), Origin: ORIGIN } })
    expect(nativeWithOrigin.status).toBe(401)
    await nativeWithOrigin.text()
    const r = await fetch(url + '/health')
    const p: any = await r.json()
    expect(p).toEqual({ ok: true, version: 2 })
    expect(r.headers.get('access-control-allow-origin')).toBe(null)
  })

  it('Host, port, absolute-form and forwarded-host cannot bypass loopback policy', async () => {
    const { server: s } = await startTestServer(t)
    for (const host of ['evil.test', `localhost:${s.listeningPort}`, '127.0.0.1:1']) {
      expect(await raw(s, '/sessions', { ...bearer(s, 'bus'), Host: host })).toBe(403)
    }
    expect(await raw(s, 'http://evil.test/sessions', bearer(s, 'bus'))).toBe(403)
    expect(await raw(s, '//evil.test/sessions', bearer(s, 'bus'))).toBe(403)
    expect(await raw(s, '/sessions', { ...bearer(s, 'bus'), Host: 'evil.test', 'X-Forwarded-Host': `127.0.0.1:${s.listeningPort}` })).toBe(403)
  })

  it('preflight is exact and side effect free; actual request remains authenticated', async () => {
    const { server: s, url } = await startTestServer(t, { allowedOrigins: [ORIGIN] })
    const r = await fetch(url + '/approval/decision', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' },
    })
    expect(r.status).toBe(204)
    expect(r.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(r.headers.get('vary')).toBe('Origin')
    expect((await post(url + '/approval/decision', {}, { Origin: ORIGIN })).status).toBe(401)
    expect(s.pending.size).toBe(0)
  })

  it('strict JSON type/schema/prototype and byte limit are enforced', async () => {
    const { server: s, url } = await startTestServer(t)
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/problem+json']) {
      const r = await fetch(url + '/inject', { method: 'POST', headers: { ...bearer(s, 'bus'), 'Content-Type': type }, body: '{}' })
      expect(r.status).toBe(415)
      await r.text()
    }
    for (const body of ['[]', 'null', '{"__proto__":{"allow":true}}', '{"constructor":{}}']) {
      const r = await fetch(url + '/inject', { method: 'POST', headers: { ...bearer(s, 'bus'), 'Content-Type': 'application/json' }, body })
      expect(r.status).toBe(400)
      await r.text()
    }
    expect(s.pending.size).toBe(0)
  })

  it('browser role comes only from one-use exact-origin/session pairing and cannot answer approvals', async () => {
    const { server: s, url } = await startTestServer(t, { allowedOrigins: [ORIGIN], listSessions: () => [{ id: 'a' }, { id: 'b' }] as never })
    const ticket = await post(url + '/pair/ticket', { origin: ORIGIN, sessionId: 'a' }, bearer(s, 'voice'))
    expect(ticket.status).toBe(200)
    expect((await post(url + '/pair', { code: ticket.body.code, sessionId: 'b' }, { Origin: ORIGIN })).status).toBe(403)
    const p = await post(url + '/pair', { code: ticket.body.code, sessionId: 'a' }, { Origin: ORIGIN })
    expect(p.status).toBe(200)
    expect((await post(url + '/pair', { code: ticket.body.code, sessionId: 'a' }, { Origin: ORIGIN })).status).toBe(403)
    const headers = { Origin: ORIGIN, Authorization: `Bearer ${(p.body as any).token}` }
    expect((await post(url + '/approval/decision', { requestId: 'x', decision: 'allow' }, headers)).status).toBe(403)
    const missingOrigin = await fetch(url + '/events', { headers: { Authorization: headers.Authorization } })
    expect(missingOrigin.status).toBe(401)
    await missingOrigin.text()
    const web = await openSse(url + '/events?role=relay', { headers })
    t.after(() => web.close())
    expect(s.hasEventSubscriber()).toBe(false)
  })

  it('exact closure/session/epoch/lease decisions; conflicts cannot grant a second time', async () => {
    const a = createFakeSession('a')
    const b = createFakeSession('b')
    const ctx = createFakeCtx({ sessions: [a, b] })
    const { bridge, url } = await startTestBridge(t, ctx)
    const s = bridge.server
    const stream = await openSse(url + '/events')
    t.after(() => stream.close())
    const outA = bridge.handleApprovalRequest(createApprovalRequest(a))
    const outB = bridge.handleApprovalRequest(createApprovalRequest(b))
    const p: any = (await stream.next()).data
    const q: any = (await stream.next()).data
    const body = { requestId: p.requestId, decision: 'allow', epoch: p.epoch, sessionId: p.sessionId, lease: p.lease }
    for (const wrong of [{ sessionId: q.sessionId }, { epoch: secret() }, { lease: secret() }]) {
      expect((await post(url + '/approval/decision', { ...body, ...wrong }, bearer(s, 'relay'))).status).toBe(409)
    }
    expect(s.pending.size).toBe(2)
    expect((await post(url + '/approval/decision', body, bearer(s, 'relay'))).status).toBe(200)
    expect((await post(url + '/approval/decision', { ...body, decision: 'deny' }, bearer(s, 'relay'))).status).toBe(409)
    expect(await outA).toBe('allowed-once')
    expect(s.pending.size).toBe(1)
    bridge.server.cancelApproval(q.requestId)
    expect(await outB).toBe('unavailable')
  })

  it('claimed approval never delegates/races native and already-aborted never publishes', async () => {
    const a = createFakeSession('a')
    const ctx = createFakeCtx({ sessions: [a] })
    const { bridge } = await startTestBridge(t, ctx)
    const stream = await openSse(bridge.server.url() + '/events')
    t.after(() => stream.close())
    let delegated = 0
    const c = new AbortController()
    c.abort()
    const seq = bridge.server.nextSeq
    expect(await bridge.handleApprovalRequest(createApprovalRequest(a, { signal: c.signal }), () => {
      delegated++
      return 'allowed-once'
    })).toBe('cancelled')
    expect(bridge.server.nextSeq).toBe(seq)
    const out = bridge.handleApprovalRequest(createApprovalRequest(a), () => {
      delegated++
      return 'allowed-once'
    })
    const p: any = (await stream.next()).data
    bridge.server.cancelApproval(p.requestId)
    expect(await out).toBe('unavailable')
    expect(delegated).toBe(0)
  })

  it('relay detach wakes never-expiring approvals and old lease cannot decide new request', async () => {
    const { server: s, url } = await startTestServer(t)
    const first = await openSse(url + '/events')
    const old = s.requestApproval({ sessionId: 'a', timeoutMs: 99999 })
    const p: any = (await first.next()).data
    first.close()
    expect(await old.outcome).toBe('unavailable')
    await waitFor(() => s.subscribers.size === 0)
    const second = await openSse(url + '/events')
    t.after(() => second.close())
    const next = s.requestApproval({ sessionId: 'a', timeoutMs: 99999 })
    const q: any = (await second.next()).data
    expect(q.lease).not.toBe(p.lease)
    expect((await post(url + '/approval/decision', { requestId: next.requestId, sessionId: 'a', epoch: s.epoch, lease: p.lease, decision: 'allow' }, bearer(s, 'relay'))).status).toBe(409)
    s.cancelApproval(next.requestId)
    await next.outcome
  })

  it('1000 cancellations retire timers/listeners and bound tombstones; no late pending publishes', async () => {
    const { server: s, url } = await startTestServer(t)
    const stream = await openSse(url + '/events')
    t.after(() => stream.close())
    for (let i = 0; i < 1000; i++) {
      const c = new AbortController()
      const p = s.requestApproval({ sessionId: 'a', timeoutMs: 99999, signal: c.signal })
      c.abort()
      expect(await p.outcome).toBe('cancelled')
      if (i % 16 === 0) await new Promise(setImmediate)
    }
    expect(s.pending.size).toBe(0)
    expect(s.resolved.size).toBeLessThanOrEqual(256)
    expect(s.events.length).toBeLessThanOrEqual(512)
  })

  it('replay cursor cannot cross client/epoch; stale approval/voice commands are never replayed', async () => {
    const { server: s, url } = await startTestServer(t)
    for (const cursor of [`${secret()}:native-relay:0`, `${s.epoch}:other:0`]) {
      const r = await fetch(url + '/events?after=' + cursor, { headers: bearer(s, 'relay') })
      expect(r.status).toBe(409)
      await r.text()
    }
    s.publish('approval', { requestId: 'old' })
    s.publish('voice-submit', { utteranceId: 'old' })
    s.publish('turn', { sessionId: 'a', phase: 'end' })
    const stream = await openSse(`${url}/events?after=${s.epoch}:native-relay:0`)
    t.after(() => stream.close())
    expect((await stream.next()).event).toBe('turn')
  })

  it('slow subscriber queue is bounded and retired on overflow', async () => {
    const { server: s } = await startTestServer(t)
    let destroyed = false
    const sub = {
      role: 'relay' as const,
      clientId: 'native-relay',
      lease: 'x',
      ended: false,
      res: { writableLength: 131072, write() { throw Error('must not queue') }, destroy() { destroyed = true }, end() {} },
    }
    s.subscribers.add(sub as never)
    s.writeToSubscriber(sub as never, { seq: 1, type: 'turn' })
    expect(destroyed).toBe(true)
    expect(s.subscribers.size).toBe(0)
  })

  it('private bootstrap refuses symlinks/permissive files/directories; never reads real credentials', () => {
    // The POSIX reader guards run through the injected fs on any host; the
    // real Windows ACL execution belongs to the desktop app's validation.
    const d = { version: 2 as const, baseUrl: 'http://127.0.0.1:17892', epoch: secret(), tokens: { relay: secret(), bus: secret(), voice: secret() } }
    const store = (mutate: (entries: Map<string, { directory?: boolean; data?: string; link?: boolean; mode?: number }>) => void, uid = 1000) => {
      const entries = new Map<string, { directory?: boolean; data?: string; link?: boolean; mode?: number }>([
        [DIR, { directory: true }],
        [FILE, { data: JSON.stringify(d) }],
      ])
      mutate(entries)
      const { fs } = createFakePosixFs(entries)
      return createCapabilityStore({ platform: 'linux', fs, uid: () => uid, pathFor: () => FILE })
    }
    // Happy-path round trip plus rotation through the real writer ordering.
    expect(store(() => {}).readDescriptor(FILE).epoch).toBe(d.epoch)
    const rotated = store(() => {})
    const next = { ...d, epoch: secret() }
    rotated.writeDescriptor(next, FILE)
    expect(rotated.readDescriptor(FILE).epoch).toBe(next.epoch)
    // Permissive file, permissive directory, symlink, and foreign owner refuse.
    expect(() => store(e => e.set(FILE, { data: JSON.stringify(d), mode: 0o644 })).readDescriptor(FILE)).toThrow()
    expect(() => store(e => e.set(DIR, { directory: true, mode: 0o755 })).readDescriptor(FILE)).toThrow()
    expect(() => store(e => e.set(FILE, { data: JSON.stringify(d), link: true })).readDescriptor(FILE)).toThrow()
    expect(() => store(() => {}, 1001).readDescriptor(FILE)).toThrow()
    // A malformed descriptor payload never reads as a valid capability.
    expect(() => {
      const entries = new Map<string, { directory?: boolean; data?: string }>([
        [DIR, { directory: true }],
        [FILE, { data: JSON.stringify({ ...d, epoch: 'short' }) }],
      ])
      const { fs } = createFakePosixFs(entries)
      createCapabilityStore({ platform: 'linux', fs, uid: () => 1000, pathFor: () => FILE }).readDescriptor(FILE)
    }).toThrow()
  })
})
