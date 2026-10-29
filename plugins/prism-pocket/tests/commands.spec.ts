/**
 * Remote-access command generation and the origin check.
 *
 * Spec: docs/compose/spec/prism-pocket.md S2.6 — the commands mirror the
 * trust fence, so every acceptance path here rejects a fence-invalid case.
 */
import { describe, expect, it } from 'vitest'
import { isOriginTrusted, remoteCommands } from '../src/commands.ts'
import type { PocketServerSurface, PocketTailscaleInfo } from '../src/types.ts'

const surface: PocketServerSurface = { host: '127.0.0.1', port: 3080, trustedHosts: [] }

function tailscale(overrides: Partial<PocketTailscaleInfo>): PocketTailscaleInfo {
  return { available: true, ...overrides }
}

describe('remoteCommands', () => {
  it('offers the direct-IP command for a Tailscale address', () => {
    const commands = remoteCommands(surface, tailscale({ ipv4: '100.64.0.3' }))
    expect(commands.directIp).toBe('prism --profile web --host 100.64.0.3')
    expect(commands.serve).toBeUndefined()
  })

  it('offers the MagicDNS set bound to the actual listen port', () => {
    // The parser strips the CLI's trailing dot before the name reaches here.
    const commands = remoteCommands(surface, tailscale({ dnsName: 'box.tail1234.ts.net' }))
    expect(commands.serve).toBe('tailscale serve --bg --https=443 http://127.0.0.1:3080')
    expect(commands.trustedHost).toBe('--trusted-host box.tail1234.ts.net')
    expect(commands.publicUrl).toBe('--public-url https://box.tail1234.ts.net/')
    expect(commands.directIp).toBeUndefined()
  })

  it('offers both paths when the node has an address and a name', () => {
    const commands = remoteCommands(surface, tailscale({ ipv4: '100.64.0.3', dnsName: 'box.tail.ts.net' }))
    expect(commands.directIp).toBeDefined()
    expect(commands.serve).toBeDefined()
  })

  it('offers nothing without Tailscale', () => {
    const commands = remoteCommands(surface, { available: false })
    expect(commands).toEqual({})
  })
})

describe('isOriginTrusted', () => {
  it('accepts the bind authority verbatim', () => {
    expect(isOriginTrusted('http://127.0.0.1:3080', surface)).toBe(true)
    expect(isOriginTrusted('http://100.64.0.3:3080', { ...surface, host: '100.64.0.3' })).toBe(true)
  })

  it('accepts a trusted-host entry with or without the port', () => {
    const fenced = { ...surface, trustedHosts: ['box.tail.ts.net', 'other.tail.ts.net:8443'] }
    expect(isOriginTrusted('https://box.tail.ts.net', fenced)).toBe(true)
    expect(isOriginTrusted('https://box.tail.ts.net:443', fenced)).toBe(true)
    expect(isOriginTrusted('https://other.tail.ts.net:8443', fenced)).toBe(true)
  })

  it('rejects an authority the fence would 403', () => {
    const fenced = { ...surface, trustedHosts: ['box.tail.ts.net'] }
    expect(isOriginTrusted('https://evil.tail.ts.net', fenced)).toBe(false)
    expect(isOriginTrusted('https://box.tail.ts.net:9999', fenced)).toBe(false)
    expect(isOriginTrusted('http://127.0.0.1:9999', surface)).toBe(false)
  })
})
