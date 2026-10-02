/**
 * Cross-process path-lock behavior. Kernel `flock` conflicts between two
 * descriptors even inside one process, so a second held lock behaves exactly
 * like a second process. Real cross-process exclusion and crash release are
 * pinned separately by the session backend's two-process e2e; these tests cover
 * exclusion, admission after release, lock-file residue, the inode verification
 * that defeats an unlinked-and-recreated lock path, and the Win32 semaphore
 * branch through a mocked kernel32 binding.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PathLock, PathLockedError } from '../src/index.ts'

const LOCK = 'path.lock'

const refuse = vi.hoisted(() => ({
  /** Next open of the lock file fails EACCES (read-only directory). */
  lockOpen: false,
  /** Next flock call fails EACCES (a non-contention kernel refusal). */
  flock: false,
  /** Next flock call fails EAGAIN (contention the kernel reports). */
  flockBusy: false,
  /** For N further lock-path stats: unlink and recreate the file first, so the locked inode is orphaned. */
  swapLockOnStat: 0,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const denied = (syscall: string): never => {
    throw Object.assign(new Error(`EACCES: injected ${syscall} refusal`), { code: 'EACCES' })
  }
  return {
    ...actual,
    open: (async (path: unknown, ...rest: never[]) => {
      if (refuse.lockOpen && String(path).endsWith(LOCK)) {
        refuse.lockOpen = false
        denied('open')
      }
      return (actual.open as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.open,
    stat: (async (path: unknown, ...rest: never[]) => {
      const at = String(path)
      if (at.endsWith(LOCK) && refuse.swapLockOnStat > 0) {
        refuse.swapLockOnStat -= 1
        await actual.unlink(at)
        await actual.writeFile(at, '')
      }
      return (actual.stat as (path: unknown, ...args: never[]) => Promise<unknown>)(path, ...rest)
    }) as typeof actual.stat,
  }
})

vi.mock('@deepseek-ai/node-addon-system/flock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/node-addon-system/flock')>()
  return {
    tryLockExclusive: async (fd: number): Promise<void> => {
      if (refuse.flock) {
        refuse.flock = false
        throw Object.assign(new Error('EACCES: injected flock refusal'), { code: 'EACCES' })
      }
      if (refuse.flockBusy) {
        refuse.flockBusy = false
        throw Object.assign(new Error('EAGAIN: injected contention'), { code: 'EAGAIN' })
      }
      return actual.tryLockExclusive(fd)
    },
  }
})

const roots: string[] = []
const held: PathLock[] = []

afterEach(async () => {
  refuse.lockOpen = false
  refuse.flock = false
  refuse.flockBusy = false
  refuse.swapLockOnStat = 0
  await Promise.allSettled(held.splice(0).map(lock => lock.release()))
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function lockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-path-lock-'))
  roots.push(dir)
  return join(dir, LOCK)
}

async function acquire(path: string): Promise<PathLock> {
  const lock = await PathLock.acquire(path)
  held.push(lock)
  return lock
}

describe('PathLock (kernel path lock)', () => {
  it('excludes a second holder', async () => {
    const path = await lockPath()
    await acquire(path)
    await expect(PathLock.acquire(path)).rejects.toBeInstanceOf(PathLockedError)
  })

  it.skipIf(process.platform === 'win32')('creates the lock file for the held path', async () => {
    const path = await lockPath()
    await acquire(path)
    expect(existsSync(path)).toBe(true)
  })

  it('admits a successor once the holder releases', async () => {
    const path = await lockPath()
    const lock = await PathLock.acquire(path)
    await lock.release()
    const next = await PathLock.acquire(path)
    held.push(next)
    expect(next.path).toBe(lock.path)
  })

  it.skipIf(process.platform === 'win32')('keeps the lock file after release and treats release as idempotent', async () => {
    const path = await lockPath()
    const lock = await PathLock.acquire(path)
    await lock.release()
    await lock.release()
    // The surviving file preserves the stable inode later lockers verify against.
    expect(existsSync(path)).toBe(true)
    expect(await readdir(join(path, '..'))).toEqual([LOCK])
  })

  it.skipIf(process.platform === 'win32')('reports kernel contention as PathLockedError', async () => {
    refuse.flockBusy = true
    await expect(PathLock.acquire(await lockPath())).rejects.toBeInstanceOf(PathLockedError)
  })

  it.skipIf(process.platform === 'win32')('propagates a filesystem refusal opening the lock path', async () => {
    refuse.lockOpen = true
    await expect(PathLock.acquire(await lockPath())).rejects.toMatchObject({ code: 'EACCES' })
  })

  it.skipIf(process.platform === 'win32')('propagates a non-contention flock refusal', async () => {
    refuse.flock = true
    await expect(PathLock.acquire(await lockPath())).rejects.toMatchObject({ code: 'EACCES' })
  })

  it.skipIf(process.platform === 'win32')('refuses a lock whose inode was replaced under it', async () => {
    // Every verification finds a different inode at the lock path, so the
    // bounded retry is exhausted rather than accepting a lock that proves nothing.
    refuse.swapLockOnStat = 3
    await expect(PathLock.acquire(await lockPath())).rejects.toBeInstanceOf(PathLockedError)
  })

  it.skipIf(process.platform === 'win32')('rejects a lock path whose parent directory is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-path-lock-'))
    await rm(dir, { recursive: true, force: true })
    await expect(PathLock.acquire(join(dir, LOCK))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('PathLock Windows semaphore branch', () => {
  it('derives one case-folded name and takes a count-1 semaphore', async () => {
    await onWindows(async () => {
      const created: Array<{ name: string; initial: number; maximum: number }> = []
      const module = await importLockWithSemaphore({
        createSemaphoreW: (name, initial, maximum) => {
          created.push({ name, initial, maximum })
          return 7
        },
      })
      const first = await module.PathLock.acquire('C:\\s\\path.lock')
      const second = await module.PathLock.acquire('C:\\S\\PATH.LOCK')
      try {
        expect(created).toHaveLength(2)
        expect(created[0]).toMatchObject({ initial: 1, maximum: 1 })
        expect(created[0]?.name).toMatch(/^Local\\dsh-path-lock-[0-9a-f]{64}$/)
        expect(created[1]?.name).toBe(created[0]?.name)
      } finally {
        await first.release()
        await second.release()
      }
    })
  })

  it('reports a held semaphore as PathLockedError and closes the probe handle', async () => {
    await onWindows(async () => {
      const closed: number[] = []
      const module = await importLockWithSemaphore({
        waitResult: 0x102,
        closeHandle: (handle) => { closed.push(handle); return 1 },
      })
      // A reset module owns a distinct error class, so the identity asserted here
      // is the published name rather than `instanceof`.
      await expect(module.PathLock.acquire('C:\\s\\path.lock')).rejects.toMatchObject({ name: 'PathLockedError' })
      expect(closed).toEqual([7])
    })
  })

  it('surfaces create and wait failures with their Win32 codes', async () => {
    await onWindows(async () => {
      const createFailed = await importLockWithSemaphore({ createSemaphoreW: () => 0, lastError: 5 })
      await expect(createFailed.PathLock.acquire('C:\\s\\path.lock')).rejects.toMatchObject({ code: 'EACCES', win32Code: 5 })
      const waitFailed = await importLockWithSemaphore({ waitResult: 0xffffffff, lastError: 5 })
      await expect(waitFailed.PathLock.acquire('C:\\s\\path.lock')).rejects.toMatchObject({ code: 'EACCES', win32Code: 5 })
    })
  })

  it('maps an invalid path name and an unknown failure to their errno', async () => {
    await onWindows(async () => {
      const invalid = await importLockWithSemaphore({ createSemaphoreW: () => 0, lastError: 123 })
      await expect(invalid.PathLock.acquire('C:\\s\\path.lock')).rejects.toMatchObject({ code: 'EINVAL', win32Code: 123 })
      const unknown = await importLockWithSemaphore({ createSemaphoreW: () => 0, lastError: 87 })
      await expect(unknown.PathLock.acquire('C:\\s\\path.lock')).rejects.toMatchObject({ code: 'EIO', win32Code: 87 })
    })
  })

  it('releases by restoring the count and closing, surfacing a failed release', async () => {
    await onWindows(async () => {
      const order: string[] = []
      const working = await importLockWithSemaphore({
        releaseSemaphore: (handle) => { order.push(`release:${handle}`); return 1 },
        closeHandle: (handle) => { order.push(`close:${handle}`); return 1 },
      })
      const lock = await working.PathLock.acquire('C:\\s\\path.lock')
      await lock.release()
      expect(order).toEqual(['release:7', 'close:7'])
      const failing = await importLockWithSemaphore({ releaseSemaphore: () => 0, lastError: 5 })
      const held = await failing.PathLock.acquire('C:\\s\\path.lock')
      await expect(held.release()).rejects.toMatchObject({ code: 'EACCES', win32Code: 5 })
    })
  })
})

/** Run one body with `process.platform` reported as Windows, restoring it after. */
async function onWindows(body: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  try {
    await body()
  } finally {
    if (original !== undefined) Object.defineProperty(process, 'platform', original)
  }
}

async function importLockWithSemaphore(bindings: {
  createSemaphoreW?: (name: string, initial: number, maximum: number) => number
  waitResult?: number
  releaseSemaphore?: (handle: number) => number
  closeHandle?: (handle: number) => number
  lastError?: number
}): Promise<typeof import('../src/index.ts')> {
  vi.resetModules()
  vi.doMock('koffi', () => ({
    default: {
      load: () => ({
        func: (_convention: string, name: string) => {
          if (name === 'CreateSemaphoreW') {
            return (_security: null, initial: number, maximum: number, semName: string) =>
              (bindings.createSemaphoreW ?? (() => 7))(semName, initial, maximum)
          }
          if (name === 'WaitForSingleObject') return () => bindings.waitResult ?? 0
          if (name === 'ReleaseSemaphore') return bindings.releaseSemaphore ?? (() => 1)
          if (name === 'CloseHandle') return bindings.closeHandle ?? (() => 1)
          return () => bindings.lastError ?? 0 // GetLastError
        },
      }),
    },
  }))
  return import('../src/index.ts')
}
