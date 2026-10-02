/**
 * Client-side scheduled-task state model shared by Remote transport and UI
 * projection.
 *
 * The model owns the stream generation, the unary mutation echoes, and the
 * resolution between them. A task's identity is never reused, so a removal that
 * a delayed frame announces is final; an upsert loses to the newer of the two
 * `updatedAt` samples, because a unary response and a stream frame travel on
 * separate carriers with no ordering between them.
 * @module @deepseek-ai/dsh-api-cron-controller/client/model
 */

import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-cron-controller/remote'
import { isRemoteFailure } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteFailure, RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CronFollowBaseline,
  CronJobId,
  CronJobView,
  CronViewCreateRequest,
  CronViewJobRequest,
  CronViewRunNowValue,
  CronViewUpdateRequest,
  CronViewValue,
} from '../types.ts'

/** Complete generated `ctx.remote.cron` namespace. */
export type CronRemote = TypertClientRemote['cron']

/**
 * Where the scheduled-task projection stands.
 *
 * `unavailable` is a business state, not a failure: the Host serves no tasks
 * because another process holds the scheduler, so the panel reports that
 * instead of an empty list it cannot support. `error` is the terminal protocol
 * or carrier failure the stream itself could not recover from.
 */
export type CronListPhase = 'connecting' | 'ready' | 'unavailable' | 'error'

/** Immutable Client scheduled-task state. */
export interface CronSnapshot {
  /** Stored tasks in the Host's order, replaced whole by each new generation. */
  readonly items: readonly CronJobView[]
  readonly phase: CronListPhase
  /** The terminal failure behind `phase: 'error'`, or `null`. */
  readonly error: RemoteFailure | null
}

/** State operations emitted by one decoded follow generation. */
export interface CronFollowSink {
  /** Replace all state from the generation baseline. */
  replaceBaseline(value: CronFollowBaseline): void
  /** Merge one task projection. */
  upsertView(job: CronJobView): void
  /** Drop one task projection. */
  removeView(jobId: CronJobId): void
}

/** Owns the Client scheduled-task projection, mutation echoes, and stream/unary race resolution. */
export class ClientCronModel implements CronFollowSink {
  private items: readonly CronJobView[] = []
  private phase: CronListPhase = 'connecting'
  private error: RemoteFailure | null = null
  /** Identities the Host has removed, so a delayed frame cannot revive one. */
  private readonly removedIds = new Set<CronJobId>()
  private readonly listeners = new Set<() => void>()
  private snapshotCache: CronSnapshot
  private snapshotDirty = false
  /** The one dispatch coalescing every change made since the last turn. */
  private dispatch: Promise<void> | undefined

  /** @param remote - generated scheduled-task Remote namespace. */
  constructor(private readonly remote: CronRemote) {
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * Store one new task and merge the unary result immediately.
   * @param request - the stated rule, destination, and message.
   * @returns the generated Remote result.
   */
  async create(request: CronViewCreateRequest): Promise<RemoteResult<CronViewValue>> {
    const result = await this.remote.create(request)
    if (result.ok) this.upsert(result.value.job)
    return result
  }

  /**
   * Replace the stated fields of one task and merge the unary result immediately.
   * @param request - the target identity and the fields to replace.
   * @returns the generated Remote result.
   */
  async update(request: CronViewUpdateRequest): Promise<RemoteResult<CronViewValue>> {
    const result = await this.remote.update(request)
    if (result.ok) this.upsert(result.value.job)
    return result
  }

  /**
   * Remove one task and drop its row immediately.
   * @param request - the target identity.
   * @returns the generated Remote result.
   */
  async remove(request: CronViewJobRequest): Promise<RemoteResult<CronViewValue>> {
    const result = await this.remote.delete(request)
    if (result.ok) this.drop(result.value.job.jobId, true)
    return result
  }

  /**
   * Run one task once, now, without changing its stored schedule.
   * @param request - the target identity.
   * @returns the generated Remote result carrying the finished run's record.
   */
  async runNow(request: CronViewJobRequest): Promise<RemoteResult<CronViewRunNowValue>> {
    // The run record reaches the row through the stored record's own write, so
    // this reply installs nothing: a local echo could show a run the task never
    // committed.
    return await this.remote.runNow(request)
  }

  /**
   * Replace the projection from one complete stream-generation baseline.
   * @param baseline - the generation's complete task list, or its leader refusal.
   */
  replaceBaseline(baseline: CronFollowBaseline): void {
    if (baseline.listError !== undefined) {
      this.items = []
      this.phase = 'unavailable'
      this.error = null
      this.invalidate()
      return
    }
    this.installItems(baseline.items)
    this.phase = 'ready'
    this.error = null
    this.invalidate()
  }

  /** Merge one decoded task upsert from the current follow generation. */
  upsertView(job: CronJobView): void {
    this.upsert(job)
  }

  /** Apply one decoded task removal from the current follow generation. */
  removeView(jobId: CronJobId): void {
    this.drop(jobId)
  }

  /** Keep the last complete projection visible while a lost carrier reconnects. */
  handleCarrierFailure(): void {
    this.phase = 'connecting'
    this.error = null
    this.invalidate()
  }

  /**
   * Publish a non-retryable stream or protocol failure.
   * @param error - the terminal stream failure.
   */
  handleStreamFailure(error: unknown): void {
    if (!isRemoteFailure(error)) throw error
    this.phase = 'error'
    this.error = error
    this.invalidate()
  }

  /**
   * Subscribe to scheduled-task state invalidation.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Read the cached state, rebuilding it first when necessary.
   * @returns the current stable scheduled-task snapshot.
   */
  getSnapshot(): CronSnapshot {
    this.refreshSnapshot()
    return this.snapshotCache
  }

  private buildSnapshot(): CronSnapshot {
    return { items: this.items, phase: this.phase, error: this.error }
  }

  private installItems(views: readonly CronJobView[]): void {
    this.items = views.filter(view => !this.removedIds.has(view.jobId))
  }

  private upsert(view: CronJobView): void {
    if (this.removedIds.has(view.jobId)) return
    const index = this.items.findIndex(item => item.jobId === view.jobId)
    const installed = this.items[index]
    // A unary response and a stream frame race on separate carriers. Keep the
    // newest Host projection regardless of their arrival order; an equal sample
    // still installs, because the two may differ in fields the sample cannot order.
    if (installed !== undefined && view.updatedAt < installed.updatedAt) return
    this.items = index === -1
      ? [...this.items, view]
      : this.items.map((item, position) => position === index ? view : item)
    this.invalidate()
  }

  private drop(jobId: CronJobId, immediate = false): void {
    // The marker is recorded even when no row was published, because a delayed
    // frame for that identity must still not revive it.
    this.removedIds.add(jobId)
    const items = this.items.filter(item => item.jobId !== jobId)
    // Nothing was published under that identity, so the projection is unchanged
    // and no subscriber is woken: an operation that moved no fact is not a state
    // change, and publishing one would report a change that did not happen.
    if (items.length === this.items.length) return
    this.items = items
    this.invalidate(immediate)
  }

  private invalidate(immediate = false): void {
    this.snapshotDirty = true
    if (immediate) {
      // Nothing is queued after this: the dispatch a pending change installed
      // sees that it is no longer the current one and publishes nothing.
      this.dispatch = undefined
      this.flush()
      return
    }
    if (this.dispatch !== undefined) return
    const dispatch = Promise.resolve().then(() => {
      if (this.dispatch !== dispatch) return
      this.dispatch = undefined
      this.flush()
    })
    this.dispatch = dispatch
  }

  private flush(): void {
    // A dispatch with no mounted surface changes nothing observable, and the
    // fact it carried is consumed either way, so a subscriber that arrives later
    // is not told about a change that predates it.
    if (this.listeners.size === 0) return
    this.refreshSnapshot()
    notifySubscribers(this.listeners, '[cron-controller]')
  }

  private refreshSnapshot(): void {
    if (!this.snapshotDirty) return
    this.snapshotDirty = false
    this.snapshotCache = this.buildSnapshot()
  }
}
