/**
 * Scheduled-task Remote verbs: the management writes and `runNow`, each answered
 * over the `ctx.cron` capability or refused with a stable code.
 *
 * Every refusal this file raises comes from {@link CronServiceError}, whose code
 * set is already stable and closed, so the mapping is total: a code with no
 * Remote spelling would be a declaration this file forgot, not a state a caller
 * meets.
 * @module @deepseek-ai/dsh-api-cron-controller/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CronJob, CronJobId, CronJobUpdate, CronServiceError } from '@deepseek-ai/dsh-cron'
import type { RemoteErrorCode } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { cronJobView } from './feed.ts'
import type {
  CronTargetView,
  CronViewCreateRequest,
  CronViewJobRequest,
  CronViewRunNowValue,
  CronViewUpdateRequest,
  CronViewValue,
} from './types.ts'

/** The Remote code that stands for one service refusal, so a caller branches once. */
const CODES: Record<CronServiceError['code'], RemoteErrorCode> = {
  cron_invalid_expression: 'cron/invalid-expression',
  cron_invalid_time_zone: 'cron/invalid-time-zone',
  cron_not_found: 'cron/not-found',
  cron_not_leader: 'cron/not-leader',
  cron_run_in_progress: 'cron/run-in-progress',
}

/** Implements scheduled-task management writes against the authoritative capability. */
export class CronCommands {
  /** @param ctx - Host context carrying the `ctx.cron` capability. */
  constructor(private readonly ctx: Context) {}

  /**
   * Store one new task.
   * @param request - the caller's stated rule, destination, and message.
   * @returns the stored task, including its minted identity and next occurrence.
   * @throws {RemoteError} a stable code when the capability refuses, or
   * `gateway/bad-request` for a run ceiling that is not a positive whole number
   * of milliseconds.
   */
  async create(request: CronViewCreateRequest): Promise<CronViewValue> {
    return this.mapped(async () => ({
      job: cronJobView(await this.ctx.cron.create({
        expression: request.expression,
        timeZone: request.timeZone,
        target: storedTarget(request.target),
        prompt: request.prompt,
        ...request.overlapPolicy === undefined ? {} : { overlapPolicy: request.overlapPolicy },
        ...request.misfirePolicy === undefined ? {} : { misfirePolicy: request.misfirePolicy },
        ...boundedRun(request.maxRunMs),
      })),
    }))
  }

  /**
   * Replace the stated fields of one stored task.
   * @param request - the target identity and the fields to replace.
   * @returns the stored task after the change.
   * @throws {RemoteError} a stable code when the capability refuses, or
   * `gateway/bad-request` for a run ceiling that is not a positive whole number
   * of milliseconds.
   */
  async update(request: CronViewUpdateRequest): Promise<CronViewValue> {
    const update: CronJobUpdate = {
      ...request.expression === undefined ? {} : { expression: request.expression },
      ...request.timeZone === undefined ? {} : { timeZone: request.timeZone },
      ...request.target === undefined ? {} : { target: storedTarget(request.target) },
      ...request.prompt === undefined ? {} : { prompt: request.prompt },
      ...request.overlapPolicy === undefined ? {} : { overlapPolicy: request.overlapPolicy },
      ...request.misfirePolicy === undefined ? {} : { misfirePolicy: request.misfirePolicy },
      ...request.enabled === undefined ? {} : { enabled: request.enabled },
      ...boundedRun(request.maxRunMs),
    }
    return this.mapped(async () => ({
      job: cronJobView(await this.ctx.cron.update(jobId(request.jobId), update)),
    }))
  }

  /**
   * Remove one stored task.
   * @param request - the target identity.
   * @returns the removed task's projection, so a surface settles the row it showed.
   * @throws {RemoteError} `cron/not-found` when no task is stored under that identity.
   */
  async delete(request: CronViewJobRequest): Promise<CronViewValue> {
    return this.mapped(async () => {
      const id = jobId(request.jobId)
      // The record is read before the removal because the capability answers a
      // removal with whether it happened, and the surface that asked needs the
      // row it showed, not only that the row is gone.
      const current = this.ctx.cron.get(id)
      if (current === undefined) throw notFound(request.jobId)
      if (!await this.ctx.cron.remove(id)) throw notFound(request.jobId)
      return { job: cronJobView(current) }
    })
  }

  /**
   * Run one stored task once, now, without changing its schedule.
   * @param request - the target identity.
   * @returns the finished run's bounded record.
   * @throws {RemoteError} a stable code when the capability refuses.
   */
  async runNow(request: CronViewJobRequest): Promise<CronViewRunNowValue> {
    return this.mapped(async () => ({ run: await this.ctx.cron.runNow(jobId(request.jobId)) }))
  }

  private async mapped<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error: unknown) {
      const code = (error as { code?: unknown }).code
      if (typeof code === 'string' && code in CODES) {
        const refusal = error as CronServiceError
        throw new RemoteError(CODES[refusal.code], refusal.message, {})
      }
      // A failure the capability did not declare is not a state a caller can
      // branch on, so it reaches the carrier unclassified instead of acquiring
      // a code this package would then have to keep stable.
      throw error
    }
  }
}

function jobId(value: string): CronJobId {
  // The identity is opaque to this package; branding is the only step that turns
  // the wire's text into the durable identity type.
  return value as CronJobId
}

/**
 * The stored form of one stated destination.
 *
 * A browser states the deployment default as an explicit `null`, because an
 * absent key and a stated default read the same over JSON; the stored record
 * omits the selection instead, so a reader tells "no selection" from "empty".
 * @param target - the destination a surface stated.
 * @returns the destination the capability stores.
 */
function storedTarget(target: CronTargetView): CronJob['target'] {
  if (target.kind === 'session') return { kind: 'session', sessionId: target.sessionId }
  return {
    kind: 'new-session',
    workspacePath: target.workspacePath,
    agentPreset: target.agentPreset,
    permissionPreset: target.permissionPreset,
    ...target.model === null ? {} : { model: target.model },
  }
}

/**
 * The run ceiling one write states, validated because it is the only bound a
 * surface supplies that nothing downstream re-checks.
 * @param maxRunMs - the stated ceiling, or `undefined` to leave the provider's default in force.
 * @returns the field to pass to the capability.
 * @throws {RemoteError} `gateway/bad-request` when the value is not a positive whole number of milliseconds.
 */
function boundedRun(maxRunMs: number | undefined): { maxRunMs?: number } {
  if (maxRunMs === undefined) return {}
  if (!Number.isSafeInteger(maxRunMs) || maxRunMs <= 0) {
    throw new RemoteError('gateway/bad-request', 'a run ceiling must be a positive whole number of milliseconds', {})
  }
  return { maxRunMs }
}

function notFound(value: string): RemoteError<'cron/not-found'> {
  return new RemoteError('cron/not-found', `no cron job is stored under '${value}'`, {})
}
