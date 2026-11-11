/**
 * Owner-only capability descriptor store for the prism bridge. The descriptor
 * is the only credential channel: the HachimoDock desktop app reads it from
 * disk, never from URLs, logs, or application resources.
 *
 * Port of upstream `integrations/dsh-hachimodock/capability.js` with the
 * prism descriptor directory.
 *
 * @module @prism/prism-hachimodock/capability
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { windowsAcl, windowsPath } from './windows-acl.ts'

/** One minted secret: 64 lowercase hex characters. */
export const secret = (): string => randomBytes(32).toString('hex')

/** The descriptor the desktop app reads. */
export interface CapabilityDescriptor {
  readonly version: 2
  readonly baseUrl: string
  readonly epoch: string
  readonly tokens: { readonly relay: string; readonly bus: string; readonly voice: string }
  readonly pairingCode?: string
  readonly pairingExpires?: number
}

/** Descriptor path: env override, then the prism bridge directory. */
export const descriptorPath = (): string =>
  process.env.HACHIMODOCK_PRISM_CAPABILITY_FILE
  || path.join(os.homedir(), '.claw-pet', 'prism-bridge', 'capability.json')

/** Length-safe constant-time string comparison. */
export function equal(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string'
    && Buffer.byteLength(a) === Buffer.byteLength(b)
    && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

const HEX_64 = /^[a-f0-9]{64}$/

/**
 * Capability store with injectable IO for tests; the default instance
 * exercises the real writer ordering and reader guards. Windows ACL checks
 * run only on win32.
 */
export function createCapabilityStore(options: {
  fs?: typeof fs
  platform?: string
  acl?: typeof windowsAcl
  secret?: () => string
  uid?: () => number | undefined
  pathFor?: (file?: string) => string
} = {}): {
  readDescriptor: (file?: string) => CapabilityDescriptor
  writeDescriptor: (d: CapabilityDescriptor, file?: string) => void
  prepareDirectory: (file?: string) => void
} {
  const io = options.fs ?? fs
  const win = (options.platform ?? process.platform) === 'win32'
  const paths = win ? path.win32 : path
  const acl = options.acl ?? windowsAcl
  const mint = options.secret ?? secret
  const uid = options.uid ?? (() => process.getuid?.())
  const pathFor = options.pathFor ?? descriptorPath
  function privateStat(file: string, directory = false): fs.Stats {
    const st = io.lstatSync(file)
    if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile())
      || (!win && (uid() !== undefined && st.uid !== uid() || st.mode & 0o077))) {
      throw new Error('unsafe capability permissions')
    }
    return st
  }
  function existing(file: string): fs.Stats | null {
    try {
      return io.lstatSync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  function prepareDirectory(file: string = pathFor()): void {
    if (win) {
      file = windowsPath(file)
      acl('prepare-directory', paths.dirname(file))
    } else {
      io.mkdirSync(paths.dirname(file), { recursive: true, mode: 0o700 })
    }
    privateStat(paths.dirname(file), true)
    if (existing(file)) {
      privateStat(file)
      // A disclosed existing token is never read or reused; repair only its
      // ACL after the directory is private, then replace it wholesale.
      if (win) acl('protect-file', file)
    }
  }
  function readDescriptor(file: string = pathFor()): CapabilityDescriptor {
    if (win) {
      file = windowsPath(file)
      acl('verify-file', file)
    }
    privateStat(paths.dirname(file), true)
    const fd = io.openSync(file, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW || 0))
    try {
      const before = privateStat(file)
      const st = io.fstatSync(fd)
      if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev || st.size > 4096
        || (!win && (uid() !== undefined && st.uid !== uid() || st.mode & 0o077))) {
        throw new Error('unsafe capability descriptor')
      }
      if (win) acl('verify-file', file)
      const d = JSON.parse(io.readFileSync(fd, 'utf8')) as CapabilityDescriptor
      const u = new URL(d.baseUrl)
      if (d.version !== 2 || !HEX_64.test(d.epoch) || u.protocol !== 'http:' || u.hostname !== '127.0.0.1'
        || !u.port || u.username || u.password || u.pathname !== '/' || u.search || u.hash
        || !(['relay', 'bus', 'voice'] as const).every(k => HEX_64.test(d.tokens?.[k] ?? ''))) {
        throw new Error('invalid capability descriptor')
      }
      return d
    } finally {
      io.closeSync(fd)
    }
  }
  function writeDescriptor(d: CapabilityDescriptor, file: string = pathFor()): void {
    prepareDirectory(file)
    const dir = paths.dirname(file)
    const tmp = paths.join(dir, `.capability-${mint()}.tmp`)
    let fd: number | undefined
    let created = false
    try {
      // Windows creates the empty temp with explicit owner + protected DACL
      // rather than relying on the default object owner of the creating token.
      if (win) {
        acl('create-file', tmp)
        created = true
      }
      fd = io.openSync(tmp, win ? 'r+' : 'wx', 0o600)
      created = true
      if (win) {
        acl('verify-file', tmp)
        const st = privateStat(tmp)
        const opened = io.fstatSync(fd)
        if (!opened.isFile() || st.ino !== opened.ino || st.dev !== opened.dev || opened.size !== 0) {
          throw new Error('unsafe new capability file')
        }
      }
      io.writeFileSync(fd, JSON.stringify(d))
      io.fsyncSync(fd)
    } catch (error) {
      if (fd !== undefined) io.closeSync(fd)
      // CreateNew rejection must never delete a preexisting entry.
      if (created && existing(tmp)) io.unlinkSync(tmp)
      throw error
    }
    io.closeSync(fd)
    try {
      io.renameSync(tmp, file)
      if (win) acl('verify-file', file)
      else privateStat(file)
    } finally {
      if (existing(tmp)) io.unlinkSync(tmp)
    }
  }
  return { readDescriptor, writeDescriptor, prepareDirectory }
}

const store = createCapabilityStore()

export const readDescriptor: (file?: string) => CapabilityDescriptor = store.readDescriptor
export const writeDescriptor: (d: CapabilityDescriptor, file?: string) => void = store.writeDescriptor
export const prepareDirectory: (file?: string) => void = store.prepareDirectory
