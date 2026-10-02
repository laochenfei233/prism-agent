/**
 * Ownership of the cron store: which process may open it, and the retry that
 * lets a follower take over once the leader is gone.
 *
 * A process that is not the leader opens nothing. That is the whole point of
 * the separation: a storage domain keeps memory authoritative after it opens
 * and offers no reload, so a follower that opened the same domain would serve
 * the jobs it read at open time forever instead of reporting that it is not the
 * scheduler.
 *
 * The retry timer is injected rather than created here, so the plugin that owns
 * the fiber owns the timer and disposal cancels it without this class reaching
 * for a scheduler of its own.
 * @module @deepseek-ai/dsh-cron/ownership
 */

import { CronLeadership } from './lease.ts'
import type { CronStore } from './store.ts'

/** Everything one ownership attempt needs from its caller. */
export interface CronOwnershipOptions {
  /** Path of the leadership lock file. */
  readonly lockPath: string
  /** Delay before the next takeover attempt while another process leads. */
  readonly retryMs: number
  /** Open the store; called only while this process holds leadership. */
  readonly openStore: () => Promise<CronStore>
  /** Close a store this process opened. */
  readonly closeStore: (store: CronStore) => Promise<void>
  /** Receive the open store, or `undefined` when this process stops leading. */
  readonly onStore: (store: CronStore | undefined) => void
  /**
   * Arrange one later attempt and return its canceller. The caller owns the
   * timer, so disposal cancels it through the returned function.
   */
  readonly scheduleRetry: (attempt: () => void, delayMs: number) => () => void
}

/** Whether this process leads, and the store it leads with. */
export class CronOwnership {
  private leadership: CronLeadership | undefined
  private store: CronStore | undefined
  private cancelRetry: (() => void) | undefined
  private disposed = false

  private constructor(private readonly options: CronOwnershipOptions) {}

  /**
   * Attempt leadership once, arranging a later attempt when another process
   * leads. Resolves after the first attempt settles, so a caller learns
   * immediately whether this process is the scheduler.
   * @param options - the lock path, retry delay, store lifecycle, and timer.
   * @returns the ownership, whether or not leadership was taken.
   */
  static async start(options: CronOwnershipOptions): Promise<CronOwnership> {
    const ownership = new CronOwnership(options)
    await ownership.attempt()
    return ownership
  }

  /** The store this process leads, or `undefined` while it does not lead. */
  get current(): CronStore | undefined {
    return this.store
  }

  /**
   * Stop leading: cancel the retry, close the store, and release the lock, in
   * that order, so nothing is left holding leadership without a store. Reopening
   * later always reads the backend again, which is what makes a takeover see the
   * previous leader's committed jobs. Idempotent.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.cancelRetry?.()
    this.cancelRetry = undefined
    const store = this.store
    this.store = undefined
    if (store !== undefined) {
      this.options.onStore(undefined)
      await this.options.closeStore(store)
    }
    const leadership = this.leadership
    this.leadership = undefined
    await leadership?.release()
  }

  /** One attempt: take the lock, and only then open the store. */
  private async attempt(): Promise<void> {
    if (this.disposed) return
    const leadership = await CronLeadership.take(this.options.lockPath)
    if (leadership === undefined) {
      this.cancelRetry = this.options.scheduleRetry(() => {
        void this.attempt()
      }, this.options.retryMs)
      return
    }
    this.leadership = leadership
    try {
      const store = await this.options.openStore()
      if (this.adopt(store)) return
      // Disposal ran while the store was opening; leadership must not outlive
      // it, so the store closes immediately instead of being adopted.
      await this.options.closeStore(store)
    } catch (error: unknown) {
      // A store that could not open must not leave this process holding
      // leadership, or no other process could ever become the scheduler.
      this.leadership = undefined
      await leadership.release()
      throw error
    }
  }

  /**
   * Adopt a store that finished opening, unless disposal ran while it opened.
   * The disposal flag is read here, after the open awaited, because the entry
   * check in {@link attempt} predates that await.
   * @param store - the store this attempt opened.
   * @returns whether it was adopted; `false` means the caller closes it.
   */
  private adopt(store: CronStore): boolean {
    if (this.disposed) return false
    this.store = store
    this.options.onStore(store)
    return true
  }
}
