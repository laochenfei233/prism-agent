/**
 * React-free Client scheduled-task service and command facade.
 *
 * The service is the panel's whole data surface: the observable state, the
 * management verbs, and the stable failure each verb reports. It decides no
 * presentation, so a browser derives its own rows and an error code stays a
 * code rather than becoming copy here.
 * @module @deepseek-ai/dsh-api-cron-controller/client/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CronJobId,
  CronJobView,
  CronViewCreateRequest,
  CronViewUpdateRequest,
  CronViewValue,
} from '../types.ts'
import type { ClientCronModel, CronSnapshot } from './model.ts'

/** A scheduled-task command the Host refused. `rpcError.code` names the stable reason. */
export class CronCommandError extends Error {
  override readonly name = 'CronCommandError'

  /**
   * @param operation - the refused command, for a caller that reports which action failed.
   * @param rpcError - Host business or folded carrier failure.
   */
  constructor(readonly operation: string, readonly rpcError: RemoteFailure) {
    super(`cron ${operation} failed: ${rpcError.code}: ${rpcError.message}`)
  }
}

/** Bare observable source for the scheduled-task projection. */
export interface CronSource {
  /** Read the identity-stable current snapshot. */
  getSnapshot(): CronSnapshot
  /**
   * Subscribe to snapshot changes.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

/** Cron Controller's Client service face. */
export interface ICronJobs {
  /** Host-authoritative task rows and follow lifecycle. */
  readonly state: CronSource
  /**
   * Store a new task.
   * @param request - the stated rule, destination, and message.
   * @returns the created task.
   */
  create(request: CronViewCreateRequest): Promise<CronJobView>
  /**
   * Replace the stated fields of one task.
   * @param request - the target identity and the fields to replace.
   * @returns the task after the change.
   */
  update(request: CronViewUpdateRequest): Promise<CronJobView>
  /**
   * Remove one task.
   * @param jobId - target task identity.
   */
  remove(jobId: CronJobId): Promise<void>
  /**
   * Run one task once, now, without changing its schedule.
   * @param jobId - target task identity.
   */
  runNow(jobId: CronJobId): Promise<void>
  /**
   * Turn one task's schedule on or off.
   * @param jobId - target task identity.
   * @param enabled - whether the scheduler may fire it.
   * @returns the task after the change.
   */
  setEnabled(jobId: CronJobId, enabled: boolean): Promise<CronJobView>
}

/** Owns the bare scheduled-task snapshot and the scheduled-task commands. */
export class CronJobs extends Service implements ICronJobs {
  readonly state: CronSource

  /**
   * @param ctx - Client root Context.
   * @param model - Remote-backed scheduled-task state model.
   */
  constructor(ctx: Context, private readonly model: ClientCronModel) {
    super(ctx, 'cronJobs')
    this.state = model
  }

  async create(request: CronViewCreateRequest): Promise<CronJobView> {
    return this.value('create', await this.model.create(request))
  }

  async update(request: CronViewUpdateRequest): Promise<CronJobView> {
    return this.value('update', await this.model.update(request))
  }

  async remove(jobId: CronJobId): Promise<void> {
    const result = await this.model.remove({ jobId })
    if (!result.ok) throw new CronCommandError('delete', result.error)
  }

  async runNow(jobId: CronJobId): Promise<void> {
    const result = await this.model.runNow({ jobId })
    if (!result.ok) throw new CronCommandError('run', result.error)
  }

  async setEnabled(jobId: CronJobId, enabled: boolean): Promise<CronJobView> {
    return this.value('enable', await this.model.update({ jobId, enabled }))
  }

  private value(
    operation: string,
    result: { readonly ok: true; readonly value: CronViewValue } | { readonly ok: false; readonly error: RemoteFailure },
  ): CronJobView {
    if (!result.ok) throw new CronCommandError(operation, result.error)
    return result.value.job
  }
}
