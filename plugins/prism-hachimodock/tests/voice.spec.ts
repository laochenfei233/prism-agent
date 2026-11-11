/**
 * Voice contract: `/voice/status` shape, and the fail-closed behavior of the
 * scoped-input endpoints when no composer consumer is paired — which is the
 * steady production state for prism, where device voice input goes through
 * the OS composer adapter and `allowedOrigins` stays empty.
 *
 * Port of upstream `test/voice.test.js` minus the legacy browser
 * InputActions consumer, which prism intentionally does not ship.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { startTestBridge, startTestServer, createFakeCtx, createFakeSession, type AfterRegistry } from './helpers.ts'
import { capabilities, serviceView } from '../src/host-contract.ts'

let cleanups: Array<() => unknown | Promise<unknown>> = []
const t: AfterRegistry = {
  after(dispose) {
    cleanups.push(dispose)
  },
}
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose()
})

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: r.status, body: (await r.json()) as any }
}

const voice = (s: { tokens: Record<string, string | undefined> }): Record<string, string> => ({ Authorization: `Bearer ${s.tokens.voice}` })

describe('voice', () => {
  it('/voice/status reports the scoped-input protocol and unpaired composer', async () => {
    const ctx = createFakeCtx({ sessions: [createFakeSession('a')] })
    const { bridge, url } = await startTestBridge(t, ctx)
    const s = bridge.server
    bridge.server.capabilities = () => capabilities(serviceView(bridge.ctx))
    const r = await post(url + '/voice/status', { sessionId: 'a' }, voice(s))
    expect(r.status).toBe(200)
    expect(r.body.protocol).toBe('hachimodock-scoped-input-v1')
    expect(r.body.epoch).toBe(s.epoch)
    expect(r.body.sessionKnown).toBe(true)
    expect(r.body.composerReady).toBe(false)
    expect(r.body.composerMount).toBe('unverified')
    expect(r.body.reason).toBe('composer-unpaired')
    expect(r.body.scopedInput).toEqual({ capture: false, insert: false, submit: false })
    expect(r.body.capabilities.sessions).toBe(true)
    expect(r.body.clientBundleAvailable).toBe(false)
  })

  it('/voice/status names an unknown session and never guesses the newest one', async () => {
    const { server: s, url } = await startTestServer(t, { listSessions: () => [{ id: 'a' }] as never })
    const r = await post(url + '/voice/status', { sessionId: 'other' }, voice(s))
    expect(r.status).toBe(200)
    expect(r.body.sessionKnown).toBe(false)
    expect(r.body.reason).toBe('exact-session-required')
    const auto = await post(url + '/voice/status', { sessionId: '' }, voice(s))
    expect(auto.body.sessionId).toBe('')
    expect(auto.body.sessionKnown).toBe(false)
  })

  it('unknown fields are refused; a missing session id reads as unknown session, never auto', async () => {
    const { server: s, url } = await startTestServer(t)
    expect((await post(url + '/voice/status', { sessionId: 'a', extra: true }, voice(s))).status).toBe(400)
    const empty = await post(url + '/voice/status', {}, voice(s))
    expect(empty.status).toBe(200)
    expect(empty.body.sessionKnown).toBe(false)
  })

  it('scoped-input endpoints refuse unpaired composers instead of guessing an editor', async () => {
    const { server: s, url } = await startTestServer(t, { listSessions: () => [{ id: 'a' }] as never })
    for (const [path, body] of [
      ['/voice/begin', { sessionId: 'a', utteranceId: 'u', revision: 1, text: '', epoch: s.epoch, lease: 'lease' }],
      ['/voice/draft', { sessionId: 'a', utteranceId: 'u', revision: 1, text: 'voice', epoch: s.epoch, lease: 'lease' }],
      ['/voice/submit', { sessionId: 'a', utteranceId: 'u', revision: 1, text: '', epoch: s.epoch, lease: 'lease' }],
    ] as const) {
      const r = await post(url + path, body, voice(s))
      expect(r.status, path).toBe(409)
      expect(r.body.error, path).toBe('composer-unavailable')
    }
    // No utterance state was created for a refused begin.
    expect(s.utterances.size).toBe(0)
  })

  it('/voice/ack is a web-role route; native roles are refused outright', async () => {
    const { server: s, url } = await startTestServer(t)
    const r = await post(url + '/voice/ack', {
      actionId: 'a', utteranceId: 'u', sessionId: 's', epoch: s.epoch, lease: 'l', ok: true, status: 'captured',
    }, { Authorization: `Bearer ${s.tokens.bus}` })
    expect(r.status).toBe(403)
  })

  it('pair/ticket requires the exact configured origin and a live session', async () => {
    const ORIGIN = 'https://dsh.example.test:7443'
    const { server: s, url } = await startTestServer(t, { allowedOrigins: [ORIGIN], listSessions: () => [{ id: 'a' }] as never })
    expect((await post(url + '/pair/ticket', { origin: ORIGIN, sessionId: 'nope' }, voice(s))).status).toBe(400)
    expect((await post(url + '/pair/ticket', { origin: 'https://evil.test', sessionId: 'a' }, voice(s))).status).toBe(400)
    const ticket = await post(url + '/pair/ticket', { origin: ORIGIN, sessionId: 'a' }, voice(s))
    expect(ticket.status).toBe(200)
    expect(ticket.body.code).toMatch(/^[a-f0-9]{64}$/)
  })

  it('pairing without the empty allowedOrigins contract stays closed for browsers', async () => {
    const { server: s, url } = await startTestServer(t)
    expect((await post(url + '/pair/ticket', { origin: 'https://dsh.example.test:7443', sessionId: 'a' }, voice(s))).status).toBe(400)
  })

  it('host capabilities snapshot drives the status payload', () => {
    const session = createFakeSession('optional')
    const ctx = createFakeCtx({ sessions: [session] })
    const view = serviceView(ctx)
    const caps = capabilities(view)
    expect(caps.sessions).toBe(true)
    expect(caps.agentSnapshot).toBe(false)
    expect(caps.backgroundPrompt).toBe(false)
    expect(caps.clientBundle).toBe(false)
    expect(caps.approval).toBe('independent-relay')
    ctx.provide('agents', { get() {} })
    expect(capabilities(view).agentSnapshot).toBe(true)
    ctx.provide('sessionController', { prompt() { throw Error('must not invoke') }, cancel() { throw Error('must not invoke') } })
    expect(capabilities(view).backgroundPrompt).toBe(true)
    expect(capabilities(view).interrupt).toBe(true)
  })
})
