/**
 * Windows ACL protection for the capability descriptor, driven by the
 * byte-identical vendored `windows-acl.ps1` under the plugin root. The
 * script receives only the operation and path, never credentials.
 *
 * Port of upstream `integrations/dsh-hachimodock/windows-acl.js`.
 *
 * @module @prism/prism-hachimodock/windows-acl
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SYSTEM = 'S-1-5-18'
const FULL = 2032127
const OPERATIONS = new Set(['prepare-directory', 'create-file', 'protect-file', 'verify-directory', 'verify-file'])

/** The vendored script lives one level above `lib/` in the installed package. */
const SCRIPT_URL = new URL('../windows-acl.ps1', import.meta.url)

/**
 * Normalize and validate one Windows path for ACL work; UNC, device paths,
 * ADS, and non-local forms are refused.
 */
export function windowsPath(value: string): string {
  if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z]:\\/.test(value)
    || /[\x00-\x1f]/.test(value) || value.slice(2).includes(':') || value.includes('/')) {
    throw new Error('invalid Windows capability path')
  }
  const parts = value.slice(3).split('\\')
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))) {
    throw new Error('invalid Windows capability path')
  }
  return path.win32.normalize(value)
}

/** One ACE as reported by the script receipt. */
interface AclRule {
  readonly sid: string
  readonly type: number
  readonly inherited: boolean
  readonly rights: number
  readonly inheritance: number
  readonly propagation: number
}

/** One protected entry as reported by the script receipt. */
interface AclEntry {
  readonly path: string
  readonly directory: boolean
  readonly reparse: boolean
  readonly rawAceCount: number
  readonly owner: string
  readonly protected: boolean
  readonly rules: readonly AclRule[]
}

/** Script receipt for one ACL operation. */
export interface AclReceipt {
  readonly version: number
  readonly operation: string
  readonly currentSid: string
  readonly directory: AclEntry
  readonly item: AclEntry | null
}

/** Validate the receipt against the requested operation and target path. */
export function validateAclReceipt(receipt: AclReceipt, operation: string, target: string): AclReceipt {
  if (!receipt || receipt.version !== 1 || receipt.operation !== operation
    || !/^S-1-(?:\d+-)+\d+$/.test(receipt.currentSid) || receipt.currentSid === SYSTEM
    || receipt.currentSid.length > 184) {
    throw new Error('invalid Windows ACL receipt')
  }
  const check = (entry: AclEntry, expectedPath: string, directory: boolean): void => {
    if (!entry || typeof entry.path !== 'string' || entry.path.toLowerCase() !== expectedPath.toLowerCase()
      || entry.directory !== directory || entry.reparse !== false || entry.rawAceCount !== 2
      || entry.owner !== receipt.currentSid || entry.protected !== true || !Array.isArray(entry.rules)
      || entry.rules.length !== 2) {
      throw new Error('unsafe Windows capability ACL')
    }
    const sids = new Set<string>()
    for (const r of entry.rules) {
      if (![receipt.currentSid, SYSTEM].includes(r.sid) || sids.has(r.sid) || r.type !== 0
        || r.inherited !== false || r.rights !== FULL || r.inheritance !== (directory ? 3 : 0)
        || r.propagation !== 0) {
        throw new Error('unsafe Windows capability ACE')
      }
      sids.add(r.sid)
    }
    if (!sids.has(receipt.currentSid) || !sids.has(SYSTEM)) throw new Error('missing Windows capability ACE')
  }
  target = windowsPath(target)
  const file = operation.endsWith('file')
  check(receipt.directory, file ? path.win32.dirname(target) : target, true)
  if (file) check(receipt.item as AclEntry, target, false)
  else if (receipt.item !== null) throw new Error('unexpected Windows capability item')
  return receipt
}

/** Structural spawn double for tests; the real path uses spawnSync. */
export interface SpawnDoubleResult {
  status?: number | null
  signal?: string | null
  error?: Error
  stdout?: string
  stderr?: string
}

export interface WindowsAclOptions {
  env?: NodeJS.ProcessEnv
  spawn?: (command: string, args: string[], options: {
    timeout?: number
    maxBuffer?: number
    env?: Record<string, string | undefined>
    windowsHide?: boolean
    encoding?: string
    stdio?: Array<'ignore' | 'pipe'>
  }) => SpawnDoubleResult
}

/**
 * Run one ACL operation through the fixed Windows PowerShell 5.1 program and
 * validate its receipt. POSIX callers never invoke this.
 */
export function windowsAcl(operation: string, target: string, options: WindowsAclOptions = {}): AclReceipt {
  if (!OPERATIONS.has(operation)) throw new Error('invalid Windows ACL operation')
  target = windowsPath(target)
  const env = options.env ?? process.env
  const systemRoot = windowsPath(env.SystemRoot ?? env.SYSTEMROOT ?? (env.WINDIR as string))
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = fs.readFileSync(fileURLToPath(SCRIPT_URL), 'utf8')
  const result = (options.spawn ?? spawnSync)(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 32768,
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        PSModulePath: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        HACHIMODOCK_DSH_ACL_OPERATION: operation,
        HACHIMODOCK_DSH_ACL_PATH: target,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const rawStdout: unknown = result.stdout
  if (result.error || result.signal || result.status !== 0 || (typeof result.stderr === 'string' ? result.stderr.trim() : '')
    || typeof rawStdout !== 'string' || Buffer.byteLength(rawStdout) > 32768) {
    throw new Error('Windows capability ACL verification failed')
  }
  let receipt: AclReceipt
  try {
    receipt = JSON.parse((rawStdout as string).replace(/^\uFEFF/, '').trim()) as AclReceipt
  } catch {
    throw new Error('invalid Windows ACL receipt')
  }
  return validateAclReceipt(receipt, operation, target)
}
