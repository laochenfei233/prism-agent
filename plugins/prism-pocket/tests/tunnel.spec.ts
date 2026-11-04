/**
 * The cloudflared probe: version parsing and candidate fallthrough.
 *
 * Spec: docs/compose/spec/pocket-remote-providers.md S2.3 — the probe reports
 * what the CLI says and nothing about tunnels it cannot see.
 */
import { platform } from 'node:os'
import { describe, expect, it } from 'vitest'
import { detectCloudflared, versionOf } from '../src/tunnel.ts'
import type { ExecRunner } from '../src/exec.ts'

describe('versionOf', () => {
  it('lifts the version from the CLI banner', () => {
    expect(versionOf('cloudflared version 2024.8.3 (built 2024-08-28-0721 UTC)\ngo1.22.5\n'))
      .toEqual({ version: '2024.8.3' })
  })

  it('reports no version when the banner does not carry one', () => {
    expect(versionOf('cloudflared\n')).toEqual({})
  })
})

describe('detectCloudflared', () => {
  it('reports the installed version of the first candidate that runs', async () => {
    const runner: ExecRunner = async () => ({ stdout: 'cloudflared version 2025.1.0\n', stderr: '' })
    await expect(detectCloudflared(runner)).resolves.toEqual({ available: true, version: '2025.1.0' })
  })

  it('falls through a missing Windows install path to the PATH lookup', async () => {
    if (platform() !== 'win32') return
    const calls: string[] = []
    const runner: ExecRunner = async (file) => {
      calls.push(file)
      if (file.includes('Program Files')) throw new Error('spawn cloudflared.exe ENOENT')
      return { stdout: 'cloudflared version 2025.1.0\n', stderr: '' }
    }
    await expect(detectCloudflared(runner)).resolves.toEqual({ available: true, version: '2025.1.0' })
    expect(calls.length).toBe(2)
  })

  it('reports a real CLI failure as-is instead of retrying', async () => {
    const runner: ExecRunner = async () => { throw new Error('access denied') }
    await expect(detectCloudflared(runner)).resolves.toEqual({ available: false, detail: 'access denied' })
  })
})
