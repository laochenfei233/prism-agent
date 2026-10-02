/**
 * One run of a job: the composition's run body, the slot that admits one run per
 * job at a time, and the bounded history written back to the store.
 *
 * A run is at-least-once. The record is appended after the body settles, and a
 * process that dies between the two repeats that occurrence on the next start;
 * nothing here claims exactly-once effects.
 * @module @deepseek-ai/dsh-cron/run
 */

import { CronServiceError } from './error.ts'
import type { CronStore } from './store.ts'
import type { CronJob, CronJobId, CronRunOutcome, CronRunRecord } from './types.ts'

/** Largest delay Node timers represent without clamping to one millisecond. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * What one firing does, and how it settled.
 *
 * It is the composition's delivery step: a run body resolves the job's target
 * and delivers its prompt. A body that rejects is recorded as `failed`, and one
 * that outlives the job's ceiling is recorded as `timeout` after its signal
 * aborts.
 * @param job - the job this firing runs, as stored when the run started.
 * @param signal - aborted once the run passes the job's ceiling.
 * @returns how the run settled.
 */
export type CronRunBody = (job: CronJob, signal: AbortSignal) => Promise<CronRunOutcome>

/** Everything one run needs from its owner. */
export interface CronRunnerOptions {
  /** The store this process leads, or `undefined` while it does not lead. */
  readonly store: () => CronStore | undefined
  /** What a firing does. */
  readonly body: CronRunBody
  /** Finished runs one job keeps; the oldest are dropped as new ones land. */
  readonly maxRunsPerJob: number
  /** The wall clock, so a caller can state the samples a test uses. */
  readonly now: () => number
}

/** The runs of one process, one at a time per job, with their bounded history. */
export class CronRunner {
  /** Jobs whose run this process has not settled yet. */
  private readonly running = new Set<CronJobId>()

  /**
   * @param options - the store, the run body, the history bound, and the clock.
   */
  constructor(private readonly options: CronRunnerOptions) {}

  /**
   * Whether a run of this job is in flight.
   * @param id - the job's identity.
   * @returns `true` while this process has not settled that job's run.
   */
  isRunning(id: CronJobId): boolean {
    return this.running.has(id)
  }

  /**
   * Run one job and record how it settled.
   *
   * The slot is claimed before the first await, so a caller that checked
   * {@link isRunning} first cannot interleave with another caller's run.
   * @param job - the job to run, as stored when the run started.
   * @returns the appended record.
   * @throws {CronServiceError} `cron_not_leader` when this process stopped leading while the run was in flight.
   */
  async run(job: CronJob): Promise<CronRunRecord> {
    this.running.add(job.id)
    const startedAt = this.options.now()
    const controller = new AbortController()
    let outcome: CronRunOutcome
    try {
      outcome = await this.bounded(job, controller)
    } catch {
      // The run body's own failure is the run's outcome; it must not escape into
      // the caller's wake path, where it would read as a scheduler fault.
      outcome = 'failed'
    } finally {
      this.running.delete(job.id)
    }
    const record: CronRunRecord = { startedAt, finishedAt: this.options.now(), outcome }
    await this.append(job, record)
    return record
  }

  /**
   * The run body bounded by the job's ceiling. Whichever of the body and the
   * ceiling settles first decides the outcome, and a ceiling that wins aborts
   * the signal the body watches.
   *
   * The ceiling is clamped to the largest delay a Node timer represents: a
   * larger `maxRunMs` would otherwise fire immediately and end every run of that
   * job as `timeout`.
   */
  private async bounded(job: CronJob, controller: AbortController): Promise<CronRunOutcome> {
    let ceiling: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<CronRunOutcome>((resolve) => {
      ceiling = setTimeout(() => {
        controller.abort()
        resolve('timeout')
      }, Math.min(job.maxRunMs, MAX_TIMER_DELAY_MS))
    })
    try {
      return await Promise.race([this.options.body(job, controller.signal), expiry])
    } finally {
      clearTimeout(ceiling)
    }
  }

  /**
   * Append one record to the job's stored history, keeping the newest
   * {@link CronRunnerOptions.maxRunsPerJob}.
   *
   * The job is re-read first, because a management update can land while the run
   * is in flight and its fields must survive this write.
   */
  private async append(job: CronJob, record: CronRunRecord): Promise<void> {
    const store = this.options.store()
    if (store === undefined) {
      throw new CronServiceError(
        'cron_not_leader',
        `run of cron job '${job.id}' cannot be recorded: this process no longer holds the scheduler`,
      )
    }
    const current = store.get(job.id) ?? job
    const runs = [...current.recentRuns, record]
    const kept = runs.slice(Math.max(0, runs.length - this.options.maxRunsPerJob))
    await store.put({ ...current, recentRuns: kept })
  }
}
