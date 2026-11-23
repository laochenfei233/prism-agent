/**
 * The LAN bind action: put the machine's preferred LAN address on the running
 * listener, idempotently, with the failure mapping the settings page shows.
 *
 * Spec: docs/compose/specs/pocket-lan-bind.md S2.2
 */
import { describe, expect, it } from 'vitest'
import { applyLanBind, type BindableWebServer } from '../src/lan-bind.ts'

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
