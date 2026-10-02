/**
 * Leader election for the cron store.
 *
 * Exactly one process may open the store. A storage domain keeps memory
 * authoritative after it opens and offers no reload, so a second process that
 * opened the same domain would serve the jobs it read at open time forever.
 * Leadership is therefore taken before the store is opened and released before
 * it is closed, and because the lease is a kernel lock the holder's death
 * releases it — a crashed scheduler never blocks its successor.
 *
 * This module owns the policy around the shared primitive: the lock file's
 * location convention, its directory mode, and the translation of contention
 * into "not the leader" rather than a failure.
 * @module @deepseek-ai/dsh-cron/lease
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { PathLock, PathLockedError } from '@deepseek-ai/dsh-util-path-lock'

/** Base name of the leadership lock file inside the scheduler's directory. */
export const LEADER_LOCK_FILENAME = 'leader.lock'

/** Held leadership: this process is the one allowed to open the store. */
export class CronLeadership {
  private constructor(private readonly lock: PathLock) {}

  /**
   * Take leadership when it is free. Never waits: a process that is not the
   * leader serves no jobs and reports that, rather than queueing behind one.
   * @param lockPath - the lock file's path; its parent directory is created with owner-only access.
   * @returns the held leadership, or `undefined` while another live process holds it.
   */
  static async take(lockPath: string): Promise<CronLeadership | undefined> {
    // Provisioning and locking are one attempt: a failure in either is the same
    // question — did this process become the leader — and only contention
    // answers "no" rather than raising.
    try {
      // Owner-only like the directories the session store materializes: the lock
      // may create the scheduler's directory first, and every creator must agree
      // on the mode.
      await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
      return new CronLeadership(await PathLock.acquire(lockPath))
    } catch (error: unknown) {
      if (error instanceof PathLockedError) return undefined
      throw error
    }
  }

  /**
   * Release leadership by closing the kernel lock. Idempotent, and the POSIX
   * lock file deliberately survives so later holders verify the same inode.
   */
  async release(): Promise<void> {
    await this.lock.release()
  }
}
