/**
 * The segmented timer runtime: one timer at a time, the wall clock re-sampled
 * after every wake, and one run per job at a time.
 *
 * A wake settles every enabled job whose stored occurrence is due and then arms a
 * single timer for the earliest occurrence any of them still owes. The stored
 * `nextDueAt` decides only whether a job is due; the instant the job moves to is
 * re-derived from that job's own rule, so a stale target cannot park the timer on
 * a past instant and spin it. An occurrence the runtime was armed for but woke
 * after is coalesced into the one run that wake produces, while the occurrences
 * that passed with no scheduler running at all are what the job's
 * `misfirePolicy` decides.
 *
 * The runtime owns no Session, no authority, and no durable state of its own: it
 * starts the runs the composition's runner performs.
 * @module @deepseek-ai/dsh-cron/runtime
 */

import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { parseCronExpression } from './expression.ts'
import type { CronExpression } from './expression.ts'
import { nextCronOccurrence } from './occurrence.ts'
import { MAX_TIMER_DELAY_MS } from './run.ts'
import type { CronRunner } from './run.ts'
import type { CronStore } from './store.ts'
import type { CronJob, CronJobId } from './types.ts'

/** One job's rule, after this build parsed the expression and canonicalized the zone. */
interface ScheduledRule {
  readonly expression: CronExpression
  readonly timeZone: string
}

/** Everything the runtime needs from the composition that mounted it. */
export interface CronRuntimeOptions {
  /** The store this process leads, or `undefined` while it does not lead. */
  readonly store: () => CronStore | undefined
  /** The runs this runtime starts. */
  readonly runner: CronRunner
  /** The wall clock; every wake re-samples it. */
  readonly now: () => number
  /** Sink for a contained failure, so one job cannot stop the timer. */
  readonly warn: (message: string) => void
}

/** One segmented timer over the jobs the leader holds. */
export class CronRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined
  private drive: Promise<void> | undefined
  private stopped = false
  private disposal: Promise<void> | undefined
  private misfiresSettled = false
  /** Jobs whose `queue-one` occurrence waits for the run in flight. */
  private readonly queued = new Set<CronJobId>()

  /**
   * @param options - the store, the runner, the clock, and the failure sink.
   */
  constructor(private readonly options: CronRuntimeOptions) {}

  /**
   * Begin driving, or keep driving after a later takeover. Idempotent: a request
   * that lands while a drive is in flight is coalesced into that drive, and a
   * call after disposal does nothing.
   */
  start(): void {
    this.request()
  }

  /**
   * Stop driving and cancel the timer, awaiting the drive in flight. Idempotent.
   * A run already started is not awaited: it settles through its own record.
   * @returns resolution once the drive in flight settled.
   */
  dispose(): Promise<void> {
    return (this.disposal ??= (async () => {
      this.stopped = true
      this.clearTimer()
      await this.drive
    })())
  }

  /** Start one drive unless one is already in flight. */
  private request(): void {
    if (this.stopped) return
    this.clearTimer()
    if (this.drive !== undefined) return
    this.drive = (async () => {
      await this.driveOnce()
      this.drive = undefined
    })()
  }

  /** Settle every due job, then arm the next wake. */
  private async driveOnce(): Promise<void> {
    const store = this.options.store()
    if (store === undefined) return
    const misfire = !this.misfiresSettled
    this.misfiresSettled = true
    const now = this.options.now()
    for (const job of store.list()) {
      if (!job.enabled || job.nextDueAt > now) continue
      try {
        await this.settle(store, job, now, misfire)
      } catch (error: unknown) {
        // One job's durable write failing must not stop the other jobs; the next
        // wake retries it, because its stored occurrence is still in the past.
        this.options.warn(`cron: settling job '${job.id}' failed: ${String(error)}`)
      }
    }
    if (this.stopped) return
    this.arm(store, this.options.now())
  }

  /**
   * Settle one due job: run the occurrence its policy admits, then move the
   * stored occurrence past the wall clock.
   * @param store - the store this drive reads and writes.
   * @param job - the job as the drive read it.
   * @param now - the instant the drive re-sampled.
   * @param misfire - whether this drive is settling occurrences that passed while no scheduler ran.
   */
  private async settle(store: CronStore, job: CronJob, now: number, misfire: boolean): Promise<void> {
    const rule = this.ruleOf(job)
    if (rule === undefined) {
      this.options.warn(`cron: job '${job.id}' cannot be scheduled by this build (expression ${JSON.stringify(job.expression)}, zone ${JSON.stringify(job.timeZone)}); it will not fire`)
      return
    }
    const upcoming = nextCronOccurrence(rule.expression, rule.timeZone, now)
    if (upcoming === undefined) {
      this.options.warn(`cron: job '${job.id}' has no occurrence in ${rule.timeZone} within the search bound; it will not fire`)
      return
    }
    if (!misfire || job.misfirePolicy === 'run-once-late') this.dispatch(job)
    const current = store.get(job.id)
    if (current === undefined) return
    await store.put({ ...current, nextDueAt: upcoming })
  }

  /**
   * Run one due job, or hold its occurrence back while another run of that job
   * is in flight.
   * @param job - the job whose occurrence this wake produced.
   */
  private dispatch(job: CronJob): void {
    if (this.options.runner.isRunning(job.id)) {
      // `queue-one` holds exactly one occurrence for the run in flight; `skip`
      // drops it, and a second queued occurrence would be a second.
      if (job.overlapPolicy === 'queue-one' && !this.queued.has(job.id)) this.queued.add(job.id)
      return
    }
    this.run(job)
  }

  /**
   * Start one run and, when it settles, start the occurrence that waited for it.
   * @param job - the job to run.
   */
  private run(job: CronJob): void {
    void this.options.runner.run(job).then(
      () => { this.settleQueued(job.id) },
      (error: unknown) => {
        // The run itself happened; only its record could not be written, so the
        // runtime reports that and keeps scheduling.
        this.options.warn(`cron: recording the run of job '${job.id}' failed: ${String(error)}`)
        this.settleQueued(job.id)
      },
    )
  }

  /**
   * Start the one occurrence a `queue-one` job held back, if it still has one to
   * start and the world it would run in still exists.
   * @param id - the identity of the job whose run just settled.
   */
  private settleQueued(id: CronJobId): void {
    if (!this.queued.delete(id) || this.stopped) return
    const store = this.options.store()
    if (store === undefined) return
    const job = store.get(id)
    if (job === undefined) return
    this.run(job)
  }

  /**
   * Arm one bounded timer segment for the earliest occurrence any enabled job
   * owes. Nothing is armed when no enabled job has an occurrence this build can
   * resolve, so a job it cannot schedule never spins the timer.
   */
  private arm(store: CronStore, now: number): void {
    let target: number | undefined
    for (const job of store.list()) {
      if (!job.enabled) continue
      const rule = this.ruleOf(job)
      if (rule === undefined) continue
      const upcoming = job.nextDueAt > now
        ? job.nextDueAt
        : nextCronOccurrence(rule.expression, rule.timeZone, now)
      if (upcoming === undefined) continue
      if (target === undefined || upcoming < target) target = upcoming
    }
    if (target === undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.request()
    }, Math.min(target - now, MAX_TIMER_DELAY_MS))
  }

  /** Cancel the armed timer, if one is armed. */
  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /**
   * Read one job's rule as this build understands it.
   * @param job - the stored job.
   * @returns the parsed expression and its canonical zone, or `undefined` when this build cannot schedule the job.
   */
  private ruleOf(job: CronJob): ScheduledRule | undefined {
    let expression: CronExpression
    try {
      expression = parseCronExpression(job.expression)
    } catch {
      // The expression is stored as written so a later grammar can read it
      // again; this build reports the job as unschedulable at its call sites.
      return undefined
    }
    const timeZone = canonicalClientTimeZone(job.timeZone)
    return timeZone === undefined ? undefined : { expression, timeZone }
  }
}
