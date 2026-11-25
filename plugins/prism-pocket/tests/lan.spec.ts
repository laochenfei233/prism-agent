/**
 * The local-network probe: which IPv4 address a phone on the same network
 * should open.
 *
 * Spec: docs/compose/spec/pocket-remote-providers.md S2.10 — the LAN transport
 * is the default, so the chosen address is the one a home network uses.
 */
import { describe, expect, it } from 'vitest'
import { detectLanAddress } from '../src/lan.ts'

/** One interface entry in the shape `os.networkInterfaces()` reports. */
function entry(address: string | undefined, family = 'IPv4', internal = false): readonly { address: string; family: string; internal: boolean }[] | undefined {
  return address === undefined ? undefined : [{ address, family, internal }]
}

describe('detectLanAddress', () => {
  it('prefers the 192.168 range over the other private ranges', () => {
    expect(detectLanAddress({
      ethernet: entry('10.0.0.7'),
      wifi: entry('192.168.1.23'),
      tailscale: entry('100.64.0.3'),
    })).toEqual({ available: true, ipv4: '192.168.1.23' })
  })

  it('falls back to the other private ranges, then any external address', () => {
    expect(detectLanAddress({ eth: entry('10.1.2.3'), wifi: entry('172.20.0.9') }))
      .toEqual({ available: true, ipv4: '10.1.2.3' })
    expect(detectLanAddress({ eth: entry('172.20.0.9'), wifi: entry('8.8.8.8') }))
      .toEqual({ available: true, ipv4: '172.20.0.9' })
    expect(detectLanAddress({ eth: entry('203.0.113.9') }))
      .toEqual({ available: true, ipv4: '203.0.113.9' })
  })

  it('ignores loopback, IPv6-only, and missing interfaces', () => {
    expect(detectLanAddress({
      lo: entry('127.0.0.1', 'IPv4', true),
      wifi6: entry('fe80::1', 'IPv6'),
      empty: undefined,
    })).toEqual({ available: false, detail: 'no non-internal IPv4 interface was found' })
    expect(detectLanAddress({})).toEqual({ available: false, detail: 'no non-internal IPv4 interface was found' })
  })
})
