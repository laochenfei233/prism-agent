/**
 * Reading and writing the jobs one opened cron domain holds.
 *
 * The store takes the domain's two handles rather than the domain itself: the
 * capability that opens the domain also owns closing it, and keeping that
 * lifecycle out of here leaves this class as the logic over durable state,
 * verifiable without booting a storage backend.
 *
 * Every write is durable when it resolves — the domain persists to its backend
 * before it mutates memory — so there is no separate flush barrier here, unlike
 * a Session-backed store whose durability depends on Session listeners.
 * @module @deepseek-ai/dsh-cron/store
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { CronDomainState } from './spec.ts'
import type { CronJob, CronJobId } from './types.ts'

/** The durable jobs of one opened cron domain. */
export class CronStore {
  /** Serializes id allocation so two concurrent creates never mint one number. */
  private minting: Promise<unknown> = Promise.resolve()

  /**
   * @param jobs - the domain's job table.
   * @param global - the domain's global state, which owns the id allocator.
   */
  constructor(
    private readonly jobs: KvTable<CronJobId, CronJob>,
    private readonly global: DomainGlobal<CronDomainState>,
  ) {}

  /**
   * Every stored job, in the table's own iteration order.
   * @returns the jobs this domain holds.
   */
  list(): readonly CronJob[] {
    return [...this.jobs.entries()].map(([, job]) => job)
  }

  /**
   * Read one job.
   * @param id - the job's identity.
   * @returns the stored job, or `undefined` when this domain holds none.
   */
  get(id: CronJobId): CronJob | undefined {
    return this.jobs.get(id)
  }

  /**
   * Write one job, creating or replacing it.
   * @param job - the complete record to store.
   */
  async put(job: CronJob): Promise<void> {
    await this.jobs.put(job.id, job)
  }

  /**
   * Remove one job.
   * @param id - the job's identity.
   * @returns whether this domain held it.
   */
  async remove(id: CronJobId): Promise<boolean> {
    return await this.jobs.delete(id)
  }

  /**
   * Mint an identity no deleted job can bring back. The allocator only advances,
   * so a reused number can never make a stale reference resolve to a new job.
   * @returns a fresh identity, unique within this domain's lifetime.
   */
  async allocateId(): Promise<CronJobId> {
    const minted = this.minting.then(async () => {
      // The number is captured before the write: a handle may expose live state,
      // so reading it after the write would read what the write just stored.
      const mintedNumber = this.global.get().nextJobNumber
      await this.global.set({ nextJobNumber: mintedNumber + 1 })
      return brandString<CronJobId>(`cron-${mintedNumber}`)
    })
    // A failed allocation must not poison later ones, so the chain continues
    // from a settled continuation rather than from the rejection.
    this.minting = minted.then(() => undefined, () => undefined)
    return await minted
  }
}
