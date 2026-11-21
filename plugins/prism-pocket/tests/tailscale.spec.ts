/**
 * The Tailscale probe: status parsing and candidate fallthrough.
 *
 * Spec: docs/compose/spec/prism-pocket.md S2.6 — probing fails soft; a
 * machine without Tailscale is a normal deployment.
 */
import { platform } from 'node:os'
import { describe, expect, it } from 'vitest'
import { detectTailscale, parseTailscaleStatus, type ExecRunner } from '../src/tailscale.ts'

describe('parseTailscaleStatus', () => {
  it('lifts the self MagicDNS name and first IPv4 address', () => {
    const info = parseTailscaleStatus(JSON.stringify({
      Self: { DNSName: 'box.tail1234.ts.net.', TailscaleIPs: ['100.64.0.3', 'fd7a:115c:a1e0::3'], Online: true },
    }))
    expect(info).toEqual({ available: true, dnsName: 'box.tail1234.ts.net', ipv4: '100.64.0.3' })
  })

  it('reports an offline node instead of inventing facts', () => {
    const info = parseTailscaleStatus(JSON.stringify({ Self: { DNSName: 'box.tail.ts.net', TailscaleIPs: [], Online: false } }))
    expect(info.available).toBe(false)
    expect(info.detail).toContain('offline')
  })

  it('fails soft on shape drift and non-JSON output', () => {
    expect(parseTailscaleStatus('{}')).toEqual({ available: false, detail: expect.any(String) })
    expect(parseTailscaleStatus('not json')).toEqual({ available: false, detail: expect.stringContaining('non-JSON') })
    expect(parseTailscaleStatus('null')).toEqual({ available: false, detail: expect.any(String) })
  })
})

describe('detectTailscale', () => {
  it('parses the CLI answer of the first candidate that runs', async () => {
    const calls: string[] = []
    const runner: ExecRunner = async (file) => {
      calls.push(file)
      return { stdout: JSON.stringify({ Self: { DNSName: 'box.tail.ts.net', TailscaleIPs: ['100.64.0.9'] } }), stderr: '' }
    }
    const info = await detectTailscale(runner)
    expect(info.available).toBe(true)
    expect(info.ipv4).toBe('100.64.0.9')
    expect(calls.length).toBe(1)
  })

  it('falls through a missing Windows install path to the PATH lookup', async () => {
    if (platform() !== 'win32') return
    const calls: string[] = []
    const runner: ExecRunner = async (file) => {
      calls.push(file)
      if (file.includes('Program Files')) {
        throw new Error('spawn C:\\Program Files\\Tailscale\\tailscale.exe ENOENT')
      }
      return { stdout: JSON.stringify({ Self: { DNSName: 'box.tail.ts.net', TailscaleIPs: ['100.64.0.9'] } }), stderr: '' }
    }
    const info = await detectTailscale(runner)
    expect(calls.length).toBe(2)
    expect(info.available).toBe(true)
  })

  it('reports a real CLI failure as-is instead of retrying', async () => {
    const runner: ExecRunner = async () => {
      throw new Error('tailscale: daemon not running')
    }
    const info = await detectTailscale(runner)
    expect(info).toEqual({ available: false, detail: 'tailscale: daemon not running' })
  })
})
