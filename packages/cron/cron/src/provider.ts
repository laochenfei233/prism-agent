/**
 * The shipped `ctx.cron` provider: every management verb, answered over the
 * store this process leads.
 *
 * A process that does not hold the leader lease holds no store at all — a
 * storage domain keeps memory authoritative after it opens and offers no
 * reload, so a follower that opened one would serve the jobs it read at open
 * time forever. Every verb therefore reads the store at call time and refuses
 * with `cron_not_leader` while there is none, instead of answering from state
 * that may already be stale.
 * @module @deepseek-ai/dsh-cron/provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { canonicalClientTimeZone } from '@deepseek-ai/dsh-util-time'
import { parseCronExpression } from './expression.ts'
import type { CronExpression } from './expression.ts'
import { CronServiceError } from './error.ts'
import { nextCronOccurrence } from './occurrence.ts'
import { CRON_RECORD_VERSION } from './records.ts'
import { CronService } from './service.ts'
import type { CronJobRequest, CronJobUpdate } from './service.ts'
import type { CronStore } from './store.ts'
import type { CronJob, CronJobId, CronRunRecord } from './types.ts'
import type { CronRunner } from './run.ts'

/** Everything the provider needs from the composition that mounted it. */
export interface CronProviderOptions {
  /** The store this process leads, or `undefined` while it leads none. */
  readonly store: () => CronStore | undefined
  /** The runs this provider starts for `runNow`. */
  readonly runner: CronRunner
  /** The wall clock, so a caller can state the samples a test uses. */
  readonly now: () => number
  /** Ceiling on one run, in milliseconds, when the creating caller states none. */
  readonly defaultMaxRunMs: number
}

/** One expression and zone after both were validated and the zone canonicalized. */
interface ResolvedRule {
  readonly expression: CronExpression
  readonly timeZone: string
}

/**
 * Calendar scheduling over the store the leader lease protects.
 *
 * The provider owns no timer and no Session: it decides what a stored job means
 * and what a management write changes, and hands a run to the runner the
 * composition supplied.
 */
export class CronProvider extends CronService {
  /**
   * @param ctx - the context this service is published on.
   * @param options - the store source, the runner, the clock, and the run ceiling default.
   */
  constructor(ctx: Context, private readonly options: CronProviderOptions) {
    super(ctx)
  }

  list(): readonly CronJob[] {
    return this.requireStore().list()
  }

  get(id: CronJobId): CronJob | undefined {
    return this.requireStore().get(id)
  }

  async create(request: CronJobRequest): Promise<CronJob> {
    const store = this.requireStore()
    const rule = this.resolveRule(request.expression, request.timeZone)
    const now = this.options.now()
    const job: CronJob = {
      version: CRON_RECORD_VERSION,
      id: await store.allocateId(),
      expression: request.expression,
      timeZone: rule.timeZone,
      enabled: true,
      target: request.target,
      prompt: request.prompt,
      overlapPolicy: request.overlapPolicy ?? 'skip',
      misfirePolicy: request.misfirePolicy ?? 'skip',
      maxRunMs: request.maxRunMs ?? this.options.defaultMaxRunMs,
      createdAt: now,
      updatedAt: now,
      nextDueAt: this.mintNextDue(rule, now),
      recentRuns: [],
    }
    await store.put(job)
    return job
  }

  async update(id: CronJobId, update: CronJobUpdate): Promise<CronJob> {
    const store = this.requireStore()
    const current = store.get(id)
    if (current === undefined) throw notFound(id)
    const expression = update.expression ?? current.expression
    const timeZone = update.timeZone ?? current.timeZone
    const rule = this.resolveRule(expression, timeZone)
    const now = this.options.now()
    // Only a rule change moves the next occurrence. Editing a prompt or a
    // policy must not postpone an occurrence that is already owed.
    const ruleChanged = update.expression !== undefined || update.timeZone !== undefined
    const next: CronJob = {
      ...current,
      expression,
      timeZone: rule.timeZone,
      enabled: update.enabled ?? current.enabled,
      target: update.target ?? current.target,
      prompt: update.prompt ?? current.prompt,
      overlapPolicy: update.overlapPolicy ?? current.overlapPolicy,
      misfirePolicy: update.misfirePolicy ?? current.misfirePolicy,
      maxRunMs: update.maxRunMs ?? current.maxRunMs,
      updatedAt: now,
      nextDueAt: ruleChanged ? this.mintNextDue(rule, now) : current.nextDueAt,
    }
    await store.put(next)
    return next
  }

  async remove(id: CronJobId): Promise<boolean> {
    return await this.requireStore().remove(id)
  }

  async runNow(id: CronJobId): Promise<CronRunRecord> {
    const store = this.requireStore()
    const job = store.get(id)
    if (job === undefined) throw notFound(id)
    // A run requested now cannot wait behind one already in flight: the caller
    // asked for this instant, and a queued run would answer for a later one.
    if (this.options.runner.isRunning(id)) {
      throw new CronServiceError('cron_run_in_progress', `cron job '${id}' already has a run in flight`)
    }
    return await this.options.runner.run(job)
  }

  /**
   * The store this process leads.
   * @returns the open store.
   * @throws {CronServiceError} `cron_not_leader` when this process leads none.
   */
  private requireStore(): CronStore {
    const store = this.options.store()
    if (store === undefined) {
      throw new CronServiceError('cron_not_leader', 'this process does not hold the cron scheduler lease')
    }
    return store
  }

  /**
   * Validate one expression and zone.
   * @param expression - the expression as the caller wrote it.
   * @param timeZone - the IANA zone the caller named.
   * @returns the parsed expression and the canonical zone spelling.
   * @throws {CronServiceError} `cron_invalid_expression` or `cron_invalid_time_zone`.
   */
  private resolveRule(expression: string, timeZone: string): ResolvedRule {
    let parsed: CronExpression
    try {
      parsed = parseCronExpression(expression)
    } catch (error: unknown) {
      // The grammar is the only refuser here, and its message already names the
      // field it read, so it becomes the reason behind the stable code.
      throw new CronServiceError('cron_invalid_expression', (error as Error).message)
    }
    const canonical = canonicalClientTimeZone(timeZone)
    if (canonical === undefined) {
      throw new CronServiceError('cron_invalid_time_zone', `'${timeZone}' is not an IANA zone this platform resolves`)
    }
    return { expression: parsed, timeZone: canonical }
  }

  /**
   * The first occurrence of a rule strictly after an instant.
   * @param rule - the validated rule.
   * @param afterEpoch - the reference instant.
   * @returns the next occurrence.
   * @throws {CronServiceError} `cron_invalid_expression` when the rule fires nowhere within the search bound.
   */
  private mintNextDue(rule: ResolvedRule, afterEpoch: number): number {
    const next = nextCronOccurrence(rule.expression, rule.timeZone, afterEpoch)
    if (next === undefined) {
      throw new CronServiceError(
        'cron_invalid_expression',
        `${rule.expression.source} has no occurrence in ${rule.timeZone} within the search bound`,
      )
    }
    return next
  }
}

/**
 * The refusal every verb reports for an identity this domain does not hold.
 * @param id - the identity the caller named.
 * @returns the refusal to throw.
 */
function notFound(id: CronJobId): CronServiceError {
  return new CronServiceError('cron_not_found', `no cron job is stored under '${id}'`)
}
