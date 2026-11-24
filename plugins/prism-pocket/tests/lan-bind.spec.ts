/**
 * The LAN bind action: put the machine's preferred LAN address on the running
 * listener, idempotently, with the failure mapping the settings page shows.
 *
 * Spec: docs/compose/specs/pocket-lan-bind.md S2.2
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyLanBind, type BindableWebServer } from '../src/lan-bind.ts'
import { lanBindResponse } from '../src/index.ts'
import { SubscriptionStore } from '../src/push/store.ts'
import { RemotePrefsStore } from '../src/remote-prefs.ts'
import { loadOrCreateVapidKeys } from '../src/push/keys.ts'

/** The interface table the mocked `node:os` reports; set per test. */
const osState: { interfaces: Record<string, readonly { address: string; family: string; internal: boolean }[] | undefined> } = { interfaces: {} }

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  networkInterfaces: () => osState.interfaces,
}))

// The checkout's `@deepseek-ai/dsh-llm` facade resolves to built declarations —
// not executable — so the route test stubs the one runtime export the plugin
// uses; the message object itself is never read here.
vi.mock('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: (message: { content: unknown; source: unknown }) => message,
}))

afterEach(() => {
  osState.interfaces = {}
})

/** A webserver double that records runtime binds and can fail them. */
function fakeWebServer(hosts: string[], fail?: Error): BindableWebServer & { bound: string[] } {
  const bound: string[] = []
  return {
    hosts,
    bound,
    async bindAdditionalHost(host: string) {
      if (fail !== undefined) throw fail
      bound.push(host)
      hosts.push(host)
    },
  }
}

const LAN = { available: true, ipv4: '192.168.1.23' } as const

describe('applyLanBind', () => {
  it('binds the detected LAN address on the running listener', async () => {
    const webserver = fakeWebServer(['127.0.0.1'])
    const result = await applyLanBind(webserver, LAN)
    expect(result).toEqual({ ok: true, ipv4: '192.168.1.23' })
    expect(webserver.bound).toEqual(['192.168.1.23'])
    expect(webserver.hosts).toEqual(['127.0.0.1', '192.168.1.23'])
  })

  it('skips the listener when the address is already bound, zone included', async () => {
    const webserver = fakeWebServer(['127.0.0.1', '192.168.1.23%3'])
    const result = await applyLanBind(webserver, LAN)
    expect(result).toEqual({ ok: true, ipv4: '192.168.1.23' })
    expect(webserver.bound).toEqual([])
  })

  it('reports a missing LAN address as a 400', async () => {
    const result = await applyLanBind(fakeWebServer(['127.0.0.1']), { available: false, detail: 'no non-internal IPv4 interface was found' })
    expect(result).toEqual({ ok: false, status: 400, error: 'no local-network address to bind: no non-internal IPv4 interface was found' })
  })

  it('maps a failed listen to a 500 and leaves the bound set alone', async () => {
    const webserver = fakeWebServer(['127.0.0.1'], new Error('listen EADDRNOTAVAIL'))
    const result = await applyLanBind(webserver, LAN)
    expect(result).toEqual({ ok: false, status: 500, error: 'listen EADDRNOTAVAIL' })
    expect(webserver.hosts).toEqual(['127.0.0.1'])
  })
})

/** A webserver double carrying the full surface the route's status body reads. */
function fakeListenerServer(hosts: string[], fail?: Error): ReturnType<typeof fakeWebServer> & { host: string; port: number; register: () => () => void } {
  return {
    ...fakeWebServer(hosts, fail),
    host: hosts[0] ?? '127.0.0.1',
    port: 38081,
    register: () => () => {},
  }
}

/** A runtime over real stores and keys, with only the connection stubbed. */
function fakeRuntime(webserver: ReturnType<typeof fakeListenerServer>) {
  const root = mkdtempSync(join(tmpdir(), 'pocket-lan-bind-'))
  return {
    connection: {
      fetch: { register: () => async () => {} },
      authenticatedUrl: (url: string) => `${url}?token=secret`,
    },
    webserver,
    webStartup: {},
    material: loadOrCreateVapidKeys(join(root, 'keys.json')),
    store: new SubscriptionStore(join(root, 'subscriptions.json')),
    prefs: new RemotePrefsStore(join(root, 'remote.json')),
    config: { pushEnabled: true, notifyTurnComplete: true },
  }
}

describe('lanBindResponse', () => {
  it('binds the detected LAN address and answers the live status body', async () => {
    osState.interfaces = { eth0: [{ address: '192.168.1.23', family: 'IPv4', internal: false }] }
    const webserver = fakeListenerServer(['127.0.0.1'])
    const response = await lanBindResponse(new Request('http://localhost/api/pocket/lan/bind', { method: 'POST' }), fakeRuntime(webserver))
    expect(response.status).toBe(200)
    const body = await response.json() as { server: { additionalHosts?: string[] }; phone: { url?: string; blocker?: string } }
    expect(body.server.additionalHosts).toEqual(['192.168.1.23'])
    expect(body.phone.blocker).toBeUndefined()
    expect(body.phone.url).toContain('192.168.1.23:38081')
    expect(webserver.bound).toEqual(['192.168.1.23'])
  })

  it('answers the status without rebinding an already-bound address', async () => {
    osState.interfaces = { eth0: [{ address: '192.168.1.23', family: 'IPv4', internal: false }] }
    const webserver = fakeListenerServer(['127.0.0.1', '192.168.1.23'])
    const response = await lanBindResponse(new Request('http://localhost/api/pocket/lan/bind', { method: 'POST' }), fakeRuntime(webserver))
    expect(response.status).toBe(200)
    expect(webserver.bound).toEqual([])
  })

  it('answers 400 when the machine has no LAN address', async () => {
    osState.interfaces = {}
    const response = await lanBindResponse(new Request('http://localhost/api/pocket/lan/bind', { method: 'POST' }), fakeRuntime(fakeListenerServer(['127.0.0.1'])))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'no local-network address to bind: no non-internal IPv4 interface was found' })
  })

  it('answers 500 with the OS reason when the listen fails', async () => {
    osState.interfaces = { eth0: [{ address: '192.168.1.23', family: 'IPv4', internal: false }] }
    const webserver = fakeListenerServer(['127.0.0.1'], new Error('listen EADDRNOTAVAIL'))
    const response = await lanBindResponse(new Request('http://localhost/api/pocket/lan/bind', { method: 'POST' }), fakeRuntime(webserver))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'listen EADDRNOTAVAIL' })
    expect(webserver.hosts).toEqual(['127.0.0.1'])
  })
})
