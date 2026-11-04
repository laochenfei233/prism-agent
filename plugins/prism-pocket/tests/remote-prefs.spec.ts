/**
 * The remote-transport selection: URL validation, body validation, and the
 * file-backed store.
 *
 * Spec: docs/compose/spec/pocket-remote-providers.md S2.1, S2.2 — a hand-edited
 * file or a hostile body can only select a known transport and an acceptable
 * https hostname.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RemotePrefsStore, readRemotePrefs, readTunnelUrl } from '../src/remote-prefs.ts'

describe('readTunnelUrl', () => {
  it('accepts an https hostname, with or without a path', () => {
    expect(readTunnelUrl('https://prism.example.com')).toBe('https://prism.example.com')
    expect(readTunnelUrl('https://prism.example.com/ui/')).toBe('https://prism.example.com/ui/')
  })

  it('rejects everything the fence or the browser would refuse', () => {
    // http would break the service worker, push, and the HTTPS probe.
    expect(readTunnelUrl('http://prism.example.com')).toBeUndefined()
    expect(readTunnelUrl('https://user:pass@prism.example.com')).toBeUndefined()
    expect(readTunnelUrl('https://prism.example.com/#frag')).toBeUndefined()
    expect(readTunnelUrl('not a url')).toBeUndefined()
    // Whitespace would persist a value the readiness probe then skips.
    expect(readTunnelUrl(' https://prism.example.com')).toBeUndefined()
    expect(readTunnelUrl('')).toBeUndefined()
    expect(readTunnelUrl(undefined)).toBeUndefined()
  })
})

describe('readRemotePrefs', () => {
  it('accepts each known transport with and without a hostname', () => {
    expect(readRemotePrefs({ provider: 'tailscale' })).toEqual({ provider: 'tailscale' })
    expect(readRemotePrefs({ provider: 'tunnel', tunnelUrl: 'https://prism.example.com' }))
      .toEqual({ provider: 'tunnel', tunnelUrl: 'https://prism.example.com' })
  })

  it('rejects an unknown transport or a bad hostname', () => {
    expect(readRemotePrefs({ provider: 'ngrok' })).toBeUndefined()
    expect(readRemotePrefs({ provider: 'tunnel', tunnelUrl: 'http://prism.example.com' })).toBeUndefined()
    expect(readRemotePrefs({})).toBeUndefined()
    expect(readRemotePrefs(null)).toBeUndefined()
    expect(readRemotePrefs('tunnel')).toBeUndefined()
  })
})

describe('RemotePrefsStore', () => {
  it('defaults to the tailscale transport without a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-pocket-prefs-'))
    expect(new RemotePrefsStore(join(dir, 'remote.json')).read()).toEqual({ provider: 'tailscale' })
  })

  it('persists a selection and reads it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-pocket-prefs-'))
    const file = join(dir, 'remote.json')
    const store = new RemotePrefsStore(file)
    store.write({ provider: 'tunnel', tunnelUrl: 'https://prism.example.com' })
    expect(new RemotePrefsStore(file).read()).toEqual({ provider: 'tunnel', tunnelUrl: 'https://prism.example.com' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      provider: 'tunnel',
      tunnelUrl: 'https://prism.example.com',
    })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('ignores a corrupt or hand-edited file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prism-pocket-prefs-'))
    const corrupt = join(dir, 'corrupt.json')
    writeFileSync(corrupt, 'not json')
    expect(new RemotePrefsStore(corrupt).read()).toEqual({ provider: 'tailscale' })

    const edited = join(dir, 'edited.json')
    writeFileSync(edited, JSON.stringify({ version: 1, provider: 'ngrok', tunnelUrl: 'http://plain.example' }))
    expect(new RemotePrefsStore(edited).read()).toEqual({ provider: 'tailscale' })
  })
})
