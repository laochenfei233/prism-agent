/**
 * Cross-process write ownership for one session's artifact directory, held for
 * the whole life of a write handle. The kernel lock itself is owned by
 * `@deepseek-ai/dsh-util-path-lock`; this module owns the session's policy
 * around it — the lock file's name inside the session directory, the directory
 * provisioning mode, and the translation of generic lock contention into the
 * persistence seam's `SessionAlreadyOwnedError`.
 * @module @deepseek-ai/dsh-session-persistence-jsonl/lease
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { PathLock, PathLockedError } from '@deepseek-ai/dsh-util-path-lock'

/** Base name of the kernel lock file inside a session's directory. */
export const LEASE_FILENAME = 'session.lock'

/**
 * One held session write lock. Constructed only by
 * {@link SessionWriteLease.acquire}; `release` closes the underlying kernel
 * lock, which is what releases it.
 */
export class SessionWriteLease {
  private constructor(private readonly lock: PathLock) {}

  /**
   * Acquire the session directory's kernel write lock.
   * @param dir - the session's artifact directory (created if absent).
   * @param id - the session the lock guards, for error identities.
   * @returns the held lock.
   * @throws {SessionAlreadyOwnedError} while another holder keeps the lock.
   */
  static async acquire(dir: string, id: SessionId): Promise<SessionWriteLease> {
    // Owner-only like materializePosix's directories: the lock may create the
    // session directory first, and both creators must agree on the mode.
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      return new SessionWriteLease(await PathLock.acquire(join(dir, LEASE_FILENAME)))
    } catch (error: unknown) {
      if (error instanceof PathLockedError) throw new SessionAlreadyOwnedError(id)
      throw error
    }
  }

  /**
   * Release the kernel lock by closing its descriptor or handle. The POSIX lock
   * file is never removed: every acquired lock belongs to a materialized or
   * materializing session, and keeping the file preserves the stable inode
   * later lockers verify against. Idempotent.
   */
  async release(): Promise<void> {
    await this.lock.release()
  }
}
