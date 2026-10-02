/**
 * The `ctx.cron` Service Definition: what every consumer of calendar scheduling
 * may ask for, and what a provider must answer.
 *
 * The definition carries the verbs and their request and result types only. It
 * decides nothing about storage, leadership, timers, or Sessions: those belong
 * to the provider that implements this, and a consumer that could observe them
 * would be depending on one provider's mechanism rather than on the capability.
 * @module @deepseek-ai/dsh-cron/service
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {
  CronJob,
  CronJobId,
  CronMisfirePolicy,
  CronOverlapPolicy,
  CronRunRecord,
  CronTarget,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    cron: CronService
  }
}

/** Everything a caller states to create a job; the provider mints the rest. */
export interface CronJobRequest {
  /** The cron expression, as the caller wrote it. */
  readonly expression: string
  /** The IANA zone the expression is stated in. */
  readonly timeZone: string
  /** Where a run happens. */
  readonly target: CronTarget
  /** The message a fired run delivers. */
  readonly prompt: string
  /** Behavior when a run is still in flight at the next occurrence. */
  readonly overlapPolicy?: CronOverlapPolicy
  /** Behavior for occurrences missed while no scheduler ran. */
  readonly misfirePolicy?: CronMisfirePolicy
  /** Positive ceiling on one run's duration, in milliseconds. */
  readonly maxRunMs?: number
}

/** The changes one update may carry; every field is optional and replaces what was stored. */
export type CronJobUpdate = Partial<Omit<CronJobRequest, 'expression' | 'timeZone'>> & {
  readonly expression?: string
  readonly timeZone?: string
  readonly enabled?: boolean
}

/**
 * Calendar scheduling, as every consumer sees it.
 *
 * Implementations answer from durable state, so a caller never has to know
 * whether this process is the scheduler: an operation that cannot be served
 * here reports `cron_not_leader` through the provider's own failure surface
 * rather than returning a stale answer.
 */
export abstract class CronService extends Service {
  /**
   * @param ctx - the context this service is published on.
   */
  constructor(ctx: Context) {
    super(ctx, 'cron')
  }

  /**
   * Every stored job, in the store's own order.
   * @returns the jobs the provider holds.
   */
  abstract list(): readonly CronJob[]

  /**
   * Read one job.
   * @param id - the job's identity.
   * @returns the job, or `undefined` when none is stored under that id.
   */
  abstract get(id: CronJobId): CronJob | undefined

  /**
   * Create a job.
   * @param request - the caller's stated rule, target, and message.
   * @returns the stored job, including its minted identity and next occurrence.
   */
  abstract create(request: CronJobRequest): Promise<CronJob>

  /**
   * Change a stored job.
   * @param id - the job's identity.
   * @param update - the fields to replace.
   * @returns the stored job after the change.
   */
  abstract update(id: CronJobId, update: CronJobUpdate): Promise<CronJob>

  /**
   * Remove a job.
   * @param id - the job's identity.
   * @returns whether a job was stored under that id.
   */
  abstract remove(id: CronJobId): Promise<boolean>

  /**
   * Run a job once, now, without changing its schedule.
   * @param id - the job's identity.
   * @returns the finished run's record.
   */
  abstract runNow(id: CronJobId): Promise<CronRunRecord>
}
