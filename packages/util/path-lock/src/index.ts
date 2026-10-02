/**
 * Cross-process exclusive lock on one caller-named filesystem path. The
 * arbiter is the kernel: POSIX takes a non-blocking `flock(2)` through the
 * native system support, and Windows holds a named kernel semaphore derived
 * from the canonical path — never a file lock or handle, so readers, searches,
 * and directory removal proceed freely while the lock is held. Contention
 * throws {@link PathLockedError}, and the kernel releases the lock when the
 * holder's descriptor or last object handle closes, including on any process
 * death, so a crashed holder never blocks a successor. A live but wedged
 * holder keeps the lock until its process exits: there is deliberately no
 * expiry, because an expiring lock would admit a second writer whose writes
 * interleave with a stalled one.
 *
 * A POSIX lock names an inode, not a path, so after locking the holder verifies
 * the locked inode is still the file at the lock path and retries otherwise: an
 * unlinked-and-recreated lock file carries a fresh inode, and a lock on the
 * orphaned one proves nothing. Removing a live holder's lock file therefore
 * forfeits exclusion on POSIX; Windows has no lock file at all. Release never
 * removes the POSIX lock file, which keeps the stable inode later lockers
 * verify against.
 *
 * The caller owns path provisioning: the lock path's parent directory must
 * already exist, and the lock path itself is created when absent.
 * @module @deepseek-ai/dsh-util-path-lock
 */

import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'

/** Another live holder owns the requested path. */
export class PathLockedError extends Error {
  /**
   * @param path - the lock path that is already held.
   */
  constructor(readonly path: string) {
    super(`path is already locked by a live holder: ${path}`)
    this.name = 'PathLockedError'
  }
}

/** The held kernel lock: a POSIX descriptor or a Win32 semaphore handle. */
type HeldLock =
  | { readonly kind: 'posix'; readonly handle: FileHandle }
  | { readonly kind: 'win32'; readonly handle: number }

/** Whether a flock failure means another descriptor holds the lock. */
function isLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  // flock(2) reports EAGAIN; some libcs spell it EWOULDBLOCK.
  return code === 'EAGAIN' || code === 'EWOULDBLOCK'
}

/**
 * One held path lock. Constructed only by {@link PathLock.acquire}; `release`
 * closes the descriptor or handle, which is what releases the lock.
 */
export class PathLock {
  private released = false

  private constructor(private readonly held: HeldLock, readonly path: string) {}

  /**
   * Acquire the kernel lock for one path.
   * @param path - the lock path; its parent directory must already exist.
   * @returns the held lock, released through {@link PathLock.release}.
   * @throws {PathLockedError} while another live holder keeps the lock.
   */
  static async acquire(path: string): Promise<PathLock> {
    const absolute = resolve(path)
    /* v8 ignore start -- native Windows coverage exercises this platform branch; Linux covers the POSIX peer */
    if (process.platform === 'win32') return new PathLock({ kind: 'win32', handle: await acquireLockHandleWin32(absolute) }, absolute)
    /* v8 ignore stop */
    // Bounded retry: locking an inode a releasing creator just unlinked (or a
    // recreated path) re-opens the fresh file; steady state needs one pass.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const handle = await open(absolute, 'w')
      try {
        try {
          await tryLockExclusive(handle.fd)
        } catch (error: unknown) {
          if (isLockContention(error)) throw new PathLockedError(absolute)
          throw error
        }
        const held = await handle.stat({ bigint: true })
        const current = await stat(absolute, { bigint: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
          throw error
        })
        if (current !== undefined && current.ino === held.ino && current.dev === held.dev) {
          return new PathLock({ kind: 'posix', handle }, absolute)
        }
      } catch (error: unknown) {
        await handle.close()
        throw error
      }
      // The locked inode is no longer the file at the lock path: start over
      // against whatever now stands there.
      await handle.close()
    }
    throw new PathLockedError(absolute)
  }

  /**
   * Release the kernel lock by closing its descriptor or handle. The POSIX lock
   * file is never removed, because keeping it preserves the stable inode later
   * lockers verify against. Idempotent.
   */
  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    /* v8 ignore start -- native Windows coverage exercises this platform branch; Linux covers the POSIX peer */
    if (this.held.kind === 'win32') {
      await releaseLockHandleWin32(this.held.handle, this.path)
      return
    }
    /* v8 ignore stop */
    await this.held.handle.close()
  }
}

type CreateSemaphoreW = (security: null, initial: number, maximum: number, name: string) => number
type WaitForSingleObject = (handle: number, milliseconds: number) => number
type ReleaseSemaphore = (handle: number, count: number, previous: null) => number
type CloseHandle = (handle: number) => number
type GetLastError = () => number

interface SemaphoreBindings {
  createSemaphoreW: CreateSemaphoreW
  waitForSingleObject: WaitForSingleObject
  releaseSemaphore: ReleaseSemaphore
  closeHandle: CloseHandle
  getLastError: GetLastError
}

const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 0x00000102
const ERROR_ACCESS_DENIED = 5
const ERROR_INVALID_NAME = 123

let bindings: SemaphoreBindings | undefined

/** Load the small Win32 API lazily so non-Windows processes never load Koffi. */
async function win32(): Promise<SemaphoreBindings> {
  if (bindings !== undefined) return bindings
  const koffi = (await import('koffi')).default
  const kernel32 = koffi.load('kernel32.dll')
  bindings = {
    createSemaphoreW: kernel32.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']) as CreateSemaphoreW,
    waitForSingleObject: kernel32.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']) as WaitForSingleObject,
    releaseSemaphore: kernel32.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']) as ReleaseSemaphore,
    closeHandle: kernel32.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as CloseHandle,
    getLastError: kernel32.func('__stdcall', 'GetLastError', 'uint', []) as GetLastError,
  }
  return bindings
}

/** The errno a semaphore call's Win32 code maps to for callers that branch on it. */
function semaphoreErrno(win32Code: number): string {
  if (win32Code === ERROR_ACCESS_DENIED) return 'EACCES'
  if (win32Code === ERROR_INVALID_NAME) return 'EINVAL'
  return 'EIO'
}

function semaphoreError(syscall: string, win32Code: number, path: string): NodeJS.ErrnoException & { win32Code: number } {
  const code = semaphoreErrno(win32Code)
  const error = new Error(`${syscall} ${code} (Win32 ${win32Code}): ${path}`) as NodeJS.ErrnoException & { win32Code: number }
  error.code = code
  error.errno = win32Code
  error.syscall = syscall
  error.path = path
  error.win32Code = win32Code
  return error
}

/**
 * Acquire the lock as a named kernel semaphore (count 1) whose name is derived
 * from the canonical path. A kernel object never touches the filesystem, so
 * readers, searches, and directory removal proceed freely while the lock is
 * held; a second acquirer's zero-timeout wait reports contention; and when the
 * last handle closes — including on any process death — the object is
 * destroyed, so a successor's create starts fresh.
 * @param path - the absolute lock path the name is derived from (case-folded:
 *   Windows paths are case-insensitive).
 * @returns the open semaphore handle.
 * @throws {PathLockedError} while another live holder keeps the lock.
 */
async function acquireLockHandleWin32(path: string): Promise<number> {
  const api = await win32()
  const name = `Local\\dsh-path-lock-${createHash('sha256').update(path.toLowerCase()).digest('hex')}`
  const handle = api.createSemaphoreW(null, 1, 1, name)
  if (handle === 0) throw semaphoreError('CreateSemaphoreW', api.getLastError(), path)
  const wait = api.waitForSingleObject(handle, 0)
  if (wait === WAIT_OBJECT_0) return handle
  api.closeHandle(handle)
  if (wait === WAIT_TIMEOUT) throw new PathLockedError(path)
  throw semaphoreError('WaitForSingleObject', api.getLastError(), path)
}

/**
 * Release a lock from the Win32 acquisition: restore the semaphore count and
 * close the handle (the object dies with its last handle).
 * @param handle - the open semaphore handle.
 * @param path - the lock path, for the failure identity.
 */
async function releaseLockHandleWin32(handle: number, path: string): Promise<void> {
  const api = await win32()
  const released = api.releaseSemaphore(handle, 1, null)
  const closed = api.closeHandle(handle)
  if (released === 0 || closed === 0) throw semaphoreError('ReleaseSemaphore', api.getLastError(), path)
}
