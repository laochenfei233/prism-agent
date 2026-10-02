/**
 * Host scheduled-task Remote owner: explicit management verbs and a
 * reconnect-safe projection of the tasks this process's scheduler holds.
 *
 * The owner adds no policy of its own. It reads `ctx.cron` at call time, so a
 * process that does not hold the scheduler lease answers `cron/not-leader` for
 * every verb and opens every follow generation with that same refusal, and it
 * publishes the stored record as a decoded projection rather than a rendered
 * row: what a panel shows is the browser's decision.
 * @module @deepseek-ai/dsh-api-cron-controller
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cron'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { CronCommands } from './commands.ts'
import { CronFeed } from './feed.ts'
import type {
  CronFollowFrame,
  CronViewCreateRequest,
  CronViewJobRequest,
  CronViewRunNowValue,
  CronViewUpdateRequest,
  CronViewValue,
} from './types.ts'

export type * from './types.ts'
export { CronCommands } from './commands.ts'
export { CronFeed, cronJobView } from './feed.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host scheduled-task business API and Remote namespace owner. */
    cronController: CronController
  }
}

/** Host service backing the generated `ctx.remote.cron` namespace. */
export class CronController extends TypertRemoteService {
  static inject = ['cron', 'typert']

  private readonly commands: CronCommands
  private readonly feed: CronFeed

  /**
   * @param ctx - Host context containing the authoritative `ctx.cron` capability.
   */
  constructor(ctx: Context) {
    super(ctx, 'cronController', { namespace: 'cron' })
    this.commands = new CronCommands(ctx)
    this.feed = new CronFeed(ctx)
  }

  /**
   * Store one new task.
   * @param request - the stated rule, destination, and message.
   * @returns the stored task, including its minted identity and next occurrence.
   */
  @Remote('create')
  create(request: CronViewCreateRequest): Promise<CronViewValue> {
    return this.commands.create(request)
  }

  /**
   * Replace the stated fields of one stored task.
   * @param request - the target identity and the fields to replace.
   * @returns the stored task after the change.
   */
  @Remote('update')
  update(request: CronViewUpdateRequest): Promise<CronViewValue> {
    return this.commands.update(request)
  }

  /**
   * Remove one stored task.
   * @param request - the target identity.
   * @returns the removed task's projection.
   */
  @Remote('delete')
  delete(request: CronViewJobRequest): Promise<CronViewValue> {
    return this.commands.delete(request)
  }

  /**
   * Run one stored task once, now, without changing its schedule.
   * @param request - the target identity.
   * @returns the finished run's bounded record.
   */
  @Remote('runNow')
  runNow(request: CronViewJobRequest): Promise<CronViewRunNowValue> {
    return this.commands.runNow(request)
  }

  /**
   * Stream a complete task baseline followed by ordered stored-task increments.
   * @param signal - generation cancellation owned by the Remote stream carrier.
   * @returns the baseline, then one frame per committed task write.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<CronFollowFrame> {
    return this.feed.follow(signal)
  }
}

export default CronController
