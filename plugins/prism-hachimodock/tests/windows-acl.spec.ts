/**
 * Windows ACL validator and descriptor writer guards. The real PowerShell
 * execution belongs to the desktop app's validation; here the spawn boundary
 * is injected and the receipt semantics are checked exactly.
 *
 * Port of upstream `test/windows-acl.test.js` (minus the cross-repo
 * byte-identity check, which lives in the HachimoDock repository).
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { windowsAcl, windowsPath, validateAclReceipt } from '../src/windows-acl.ts'
import { createCapabilityStore } from '../src/capability.ts'
import { createFakePosixFs } from './helpers.ts'

const SID = 'S-1-5-21-1-2-3-1001'
const SYSTEM = 'S-1-5-18'
const file = 'C:\\private\\capability.json'

function entry(name: string, directory: boolean): Record<string, unknown> {
  return {
    path: name,
    directory,
    owner: SID,
    protected: true,
    reparse: false,
    rawAceCount: 2,
    rules: [SID, SYSTEM].map(sid => ({ sid, type: 0, inherited: false, rights: 2032127, inheritance: directory ? 3 : 0, propagation: 0 })),
  }
}

function receipt(operation = 'verify-file', target = file): Record<string, unknown> {
  const isFile = operation.endsWith('file')
  return {
    version: 1,
    operation,
    currentSid: SID,
    directory: entry(isFile ? path.win32.dirname(target) : target, true),
    item: isFile ? entry(target, false) : null,
  }
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

describe('windows-acl', () => {
  it('production receipt validator requires protected current SID + SYSTEM exclusively', () => {
    const good = receipt() as never as Parameters<typeof validateAclReceipt>[0]
    expect(validateAclReceipt(good, 'verify-file', file)).toBe(good)
    for (const key of ['directory', 'item'] as const) {
      for (const [field, value] of [['owner', SYSTEM], ['protected', false], ['rawAceCount', 3], ['reparse', true], ['directory', key !== 'directory']] as const) {
        const bad = clone(good) as any
        bad[key][field] = value
        expect(() => validateAclReceipt(bad, 'verify-file', file)).toThrow()
      }
      for (const [field, value] of [['sid', 'S-1-1-0'], ['inherited', true], ['type', 1], ['rights', 1179785], ['inheritance', 7], ['propagation', 1]] as const) {
        const bad = clone(good) as any
        bad[key].rules[1][field] = value
        expect(() => validateAclReceipt(bad, 'verify-file', file)).toThrow()
      }
      const duplicate = clone(good) as any
      duplicate[key].rules[1].sid = SID
      expect(() => validateAclReceipt(duplicate, 'verify-file', file)).toThrow()
      const extra = clone(good) as any
      extra[key].rules.push({ ...extra[key].rules[1], sid: 'S-1-5-32-544' })
      expect(() => validateAclReceipt(extra, 'verify-file', file)).toThrow()
    }
    for (const field of ['currentSid', 'operation', 'version']) {
      const bad = clone(good) as any
      bad[field] = null
      expect(() => validateAclReceipt(bad, 'verify-file', file)).toThrow()
    }
  })

  it('Windows path policy handles Unicode/spaces and rejects UNC, devices, ADS and ambiguous paths', () => {
    expect(windowsPath('D:\\用户 Name\\prism-bridge\\capability.json')).toBe('D:\\用户 Name\\prism-bridge\\capability.json')
    for (const p of ['relative.json', '\\\\server\\share\\capability.json', '\\\\?\\C:\\private\\capability.json', 'C:\\private\\..\\capability.json', 'C:\\private\\capability.json:stream', 'C:\\private \\capability.json', 'C:\\private.\\capability.json', 'C:/private/capability.json', 'C:\\private\\\nfile', 'C:\\' + 'x'.repeat(2048)]) {
      expect(() => windowsPath(p), p).toThrow()
    }
  })

  it('8.3 caller spelling stays exact; an expanded receipt is never accepted as a different path', () => {
    const short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\private\\capability.json'
    expect(windowsPath(short)).toBe(short)
    const good = receipt('verify-file', short) as never as Parameters<typeof validateAclReceipt>[0]
    expect(validateAclReceipt(good, 'verify-file', short)).toBe(good)
    const expanded = clone(good) as any
    expanded.directory.path = expanded.directory.path.replace('RUNNER~1', 'runneradmin')
    expanded.item.path = expanded.item.path.replace('RUNNER~1', 'runneradmin')
    expect(() => validateAclReceipt(expanded, 'verify-file', short)).toThrow()
  })

  it('PowerShell invocation is fixed, bounded, NoProfile/NonInteractive; only path/operation enter child env', () => {
    let called = 0
    const result = windowsAcl('verify-file', file, {
      env: { SystemRoot: 'C:\\Windows', API_TOKEN: 'do-not-inherit' } as never,
      spawn(exe: string, args: string[], opts: { timeout?: number; maxBuffer?: number; env?: Record<string, string | undefined> }) {
        called++
        expect(exe).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
        expect(args.slice(0, -1)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
        const script = Buffer.from(args.at(-1) as string, 'base64').toString('utf16le')
        expect(script).toBe(readFileSync(path.join(import.meta.dirname, '../windows-acl.ps1'), 'utf8'))
        expect(opts.timeout).toBe(5000)
        expect(opts.maxBuffer).toBe(32768)
        expect(opts.env?.API_TOKEN).toBeUndefined()
        expect(opts.env?.HACHIMODOCK_DSH_ACL_PATH).toBe(file)
        expect(args.join(' ').includes(file)).toBe(false)
        return { status: 0, stdout: JSON.stringify(receipt()), stderr: '' } as never
      },
    })
    expect(called).toBe(1)
    expect(result.currentSid).toBe(SID)
  })

  it('PowerShell failure, timeout, bad/oversized output and insecure receipt fail closed', () => {
    for (const result of [
      { error: Error('timeout') },
      { status: 1, stdout: '{}', stderr: '' },
      { status: 0, signal: 'SIGTERM', stdout: '{}', stderr: '' },
      { status: 0, stdout: '{}', stderr: 'warning' },
      { status: 0, stdout: 'not-json', stderr: '' },
      { status: 0, stdout: 'x'.repeat(32769), stderr: '' },
      { status: 0, stdout: JSON.stringify({ ...receipt(), currentSid: SYSTEM }), stderr: '' },
    ]) {
      expect(() => windowsAcl('verify-file', file, { env: { SystemRoot: 'C:\\Windows' } as never, spawn: () => result as never })).toThrow()
    }
  })

  it('POSIX reader guards refuse symlink, permissive modes, and foreign owners through the injected fs', () => {
    const d = { version: 2 as const, baseUrl: 'http://127.0.0.1:17892', epoch: 'a'.repeat(64), tokens: { relay: 'b'.repeat(64), bus: 'c'.repeat(64), voice: 'd'.repeat(64) } }
    const mk = (mutate: (entries: Map<string, { directory?: boolean; data?: string; link?: boolean; mode?: number }>) => void, uid = 1000) => {
      const entries = new Map<string, { directory?: boolean; data?: string; link?: boolean; mode?: number }>([
        ['/private/prism', { directory: true }],
        ['/private/prism/capability.json', { data: JSON.stringify(d) }],
      ])
      mutate(entries)
      const { fs } = createFakePosixFs(entries)
      return createCapabilityStore({ platform: 'linux', fs, uid: () => uid, pathFor: () => '/private/prism/capability.json' })
    }
    expect(mk(() => {}).readDescriptor().epoch).toBe(d.epoch)
    expect(() => mk(e => e.set('/private/prism/capability.json', { data: JSON.stringify(d), mode: 0o644 })).readDescriptor()).toThrow()
    expect(() => mk(e => e.set('/private/prism', { directory: true, mode: 0o755 })).readDescriptor()).toThrow()
    expect(() => mk(e => e.set('/private/prism/capability.json', { data: JSON.stringify(d), link: true })).readDescriptor()).toThrow()
    expect(() => mk(() => {}, 1001).readDescriptor()).toThrow()
  })

  it('descriptor validation rejects bad endpoints, epochs, and tokens', () => {
    const mk = (payload: unknown) => {
      const entries = new Map<string, { directory?: boolean; data?: string }>([
        ['/private/prism', { directory: true }],
        ['/private/prism/capability.json', { data: JSON.stringify(payload) }],
      ])
      const { fs } = createFakePosixFs(entries)
      return createCapabilityStore({ platform: 'linux', fs, uid: () => 1000, pathFor: () => '/private/prism/capability.json' })
    }
    const base = { version: 2, baseUrl: 'http://127.0.0.1:17892', epoch: 'e'.repeat(64), tokens: { relay: 'r'.repeat(64), bus: 'b'.repeat(64), voice: 'v'.repeat(64) } }
    for (const payload of [
      { ...base, version: 1 },
      { ...base, baseUrl: 'https://127.0.0.1:17892' },
      { ...base, baseUrl: 'http://0.0.0.0:17892' },
      { ...base, baseUrl: 'http://127.0.0.1:17892/?x=1' },
      { ...base, epoch: 'short' },
      { ...base, tokens: { ...base.tokens, bus: 'short' } },
      'not-json',
    ]) {
      expect(() => mk(payload).readDescriptor()).toThrow()
    }
  })
})
