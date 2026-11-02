/**
 * Remote-access facts: the deployment steps, the phone target, and the origin
 * check.
 *
 * Spec: docs/compose/spec/prism-pocket.md S2.6 — the steps mirror the trust
 * fence, so every acceptance path here rejects a fence-invalid case.
 */
import { describe, expect, it } from 'vitest'
import { isOriginTrusted, phoneAccess, phoneTarget, probeVerdict, remoteCommands } from '../src/commands.ts'
import type { PocketServerSurface, PocketTailscaleInfo } from '../src/types.ts'

const surface: PocketServerSurface = { host: '127.0.0.1', port: 3080, trustedHosts: [] }

function tailscale(overrides: Partial<PocketTailscaleInfo>): PocketTailscaleInfo {
  return { available: true, ...overrides }
}

describe('remoteCommands', () => {
  it('renders the proxy command and the fence patch for a MagicDNS name', () => {
    // The parser strips the CLI's trailing dot before the name reaches here.
    const commands = remoteCommands(surface, tailscale({ dnsName: 'box.tail1234.ts.net' }))
    expect(commands.serve).toBe('tailscale serve --bg --https=443 http://127.0.0.1:3080')
    expect(commands.trust).toBe('- id: connection\n  config:\n    trustedHosts:\n      - box.tail1234.ts.net')
    expect(commands.trustedHost).toBe('--trusted-host box.tail1234.ts.net')
  })

  it('offers nothing without a MagicDNS name: an address alone names no remote URL', () => {
    expect(remoteCommands(surface, tailscale({ ipv4: '100.64.0.3' }))).toEqual({})
    expect(remoteCommands(surface, { available: false })).toEqual({})
  })
})

describe('phoneTarget', () => {
  it('prefers the advertised public URL', () => {
    expect(phoneTarget({ ...surface, publicUrl: 'https://app.example/' }, tailscale({ dnsName: 'box.tail.ts.net' })))
      .toBe('https://app.example/')
  })

  it('uses the MagicDNS root when a name exists', () => {
    expect(phoneTarget(surface, tailscale({ dnsName: 'box.tail.ts.net' }))).toBe('https://box.tail.ts.net/')
  })

  it('falls back to a non-loopback bind address', () => {
    expect(phoneTarget({ ...surface, host: '100.64.0.3' }, { available: false })).toBe('http://100.64.0.3:3080/')
    expect(phoneTarget({ ...surface, host: '[::1]' }, { available: false })).toBeUndefined()
  })
})

describe('phoneAccess', () => {
  it('reports a loopback server with no tailnet route', () => {
    expect(phoneAccess(surface, tailscale({}))).toEqual({ blocker: 'loopback', trusted: false })
    expect(phoneAccess(surface, { available: false })).toEqual({ blocker: 'no-tailscale', trusted: false })
  })

  it('offers the MagicDNS address as untrusted until the fence names it', () => {
    expect(phoneAccess(surface, tailscale({ dnsName: 'box.tail.ts.net' })))
      .toEqual({ target: 'https://box.tail.ts.net/', trusted: false, blocker: 'untrusted' })
  })

  it('reports the address as ready once the fence names it', () => {
    const fenced = { ...surface, trustedHosts: ['box.tail.ts.net'] }
    expect(phoneAccess(fenced, tailscale({ dnsName: 'box.tail.ts.net' })))
      .toEqual({ target: 'https://box.tail.ts.net/', trusted: true })
  })

  it('treats a direct bind address as already trusted', () => {
    expect(phoneAccess({ ...surface, host: '100.64.0.3' }, { available: false }))
      .toEqual({ target: 'http://100.64.0.3:3080/', trusted: true })
  })
})

describe('probeVerdict', () => {
  it('reads the fence refusal apart from every answer that got through', () => {
    // The fence answers before the session layer, so 401 is a reachable server.
    expect(probeVerdict(403)).toBe('untrusted')
    expect(probeVerdict(401)).toBe('accepted')
    expect(probeVerdict(200)).toBe('accepted')
  })
})

describe('isOriginTrusted', () => {
  it('accepts the bind authority verbatim and port-ignored, like the fence', () => {
    expect(isOriginTrusted('http://127.0.0.1:3080', surface)).toBe(true)
    expect(isOriginTrusted('http://100.64.0.3:3080', { ...surface, host: '100.64.0.3' })).toBe(true)
    expect(isOriginTrusted('http://100.64.0.3:9999', { ...surface, host: '100.64.0.3' })).toBe(true)
  })

  it('accepts any loopback origin when the server binds loopback', () => {
    expect(isOriginTrusted('http://127.0.0.1:9999', surface)).toBe(true)
    expect(isOriginTrusted('http://localhost:3080', surface)).toBe(true)
    expect(isOriginTrusted('http://localhost:5173', surface)).toBe(true)
    expect(isOriginTrusted('http://[::1]:3080', surface)).toBe(true)
    expect(isOriginTrusted('http://localhost:3080', { ...surface, host: '100.64.0.3' })).toBe(false)
  })

  it('accepts a trusted-host entry with or without the port, like the fence', () => {
    const fenced = { ...surface, trustedHosts: ['box.tail.ts.net', 'other.tail.ts.net:8443'] }
    expect(isOriginTrusted('https://box.tail.ts.net', fenced)).toBe(true)
    expect(isOriginTrusted('https://box.tail.ts.net:443', fenced)).toBe(true)
    expect(isOriginTrusted('https://box.tail.ts.net:9999', fenced)).toBe(true)
    expect(isOriginTrusted('https://other.tail.ts.net:8443', fenced)).toBe(true)
  })

  it('rejects an authority the fence would 403', () => {
    const fenced = { ...surface, trustedHosts: ['box.tail.ts.net'] }
    expect(isOriginTrusted('https://evil.tail.ts.net', fenced)).toBe(false)
    expect(isOriginTrusted('https://other.tail.ts.net:9999', { ...surface, trustedHosts: ['other.tail.ts.net:8443'] })).toBe(false)
    expect(isOriginTrusted('https://127.0.0.1:3080', { ...surface, host: '100.64.0.3', trustedHosts: [] })).toBe(false)
  })
})
