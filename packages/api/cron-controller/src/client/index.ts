/**
 * Scheduled-task-specific adapter for the Gateway-owned snapshot stream lifecycle.
 *
 * One generation is one subscription: a complete baseline, then the increments
 * committed after it. A reconnect opens a new generation with a replacement
 * baseline, so no consumer depends on having received every increment while the
 * carrier was down.
 * @module @deepseek-ai/dsh-api-cron-controller/client
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  RemoteSnapshotStream,
  RemoteStreamCarrierError,
} from '@deepseek-ai/dsh-api-gateway/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { CronFollowFrame, CronFollowIncrement } from '../types.ts'
import type { CronFollowSink } from './model.ts'
import { ClientCronModel } from './model.ts'
import { CronJobs } from './service.ts'

/**
 * The stream factory this package's state stream needs.
 *
 * This is the generated Client Remote's own `$stream` member, named so a spec
 * can hand in one scripted generation instead of a Gateway stream.
 */
export type CronStreamFactory = Pick<ClientRemote, '$stream'>

export { ClientCronModel } from './model.ts'
export type { CronFollowSink, CronListPhase, CronRemote, CronSnapshot } from './model.ts'
export { CronCommandError, CronJobs } from './service.ts'
export type { CronSource, ICronJobs } from './service.ts'
export type {
  CronFollowBaseline, CronFollowFrame, CronFollowIncrement, CronJobId, CronJobView, CronRunOutcome,
  CronRunRecord, CronTarget, CronTargetView, CronViewCreateRequest, CronViewJobRequest,
  CronViewRunNowValue, CronViewUpdateRequest, CronViewValue,
} from '../types.ts'

type CronBaselineFrame = Extract<CronFollowFrame, { type: 'baseline' }>

/** Gateway-owned snapshot stream configured for scheduled-task state. */
export type CronStateStream = RemoteSnapshotStream<CronBaselineFrame, CronFollowIncrement>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** React-free Client scheduled-task state and commands. */
    cronJobs: import('./service.ts').ICronJobs
  }
}

/** Required Client Remote services. */
export const inject = ['remote', 'remote.cron']

/**
 * Install Client scheduled-task state, commands, and reconnecting follow control.
 * @param ctx - Client root Context.
 */
export function apply(ctx: Context): void {
  const model = new ClientCronModel(ctx.remote.cron)
  new CronJobs(ctx, model)
  const control = createCronStateStream(ctx.remote, destinationsFor(model))
  control.start()
  ctx.effect(
    () => async () => { await control.dispose() },
    'cron-controller.client.control',
  )
}

/**
 * The state-stream destinations one projection publishes through.
 * @param model - the projection this Client owns.
 * @returns the sinks the stream delivers baselines, increments, and failures to.
 */
function destinationsFor(model: ClientCronModel): CronStateStreamOptions {
  return {
    accept: model,
    carrierFailed: () => { model.handleCarrierFailure() },
    failed: (error) => { model.handleStreamFailure(error) },
  }
}

/** Domain sinks used by the scheduled-task state stream. */
export interface CronStateStreamOptions {
  /** Destinations for decoded scheduled-task operations. */
  readonly accept: CronFollowSink
  /** Observe a retryable carrier loss before reconnection. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  /** Publish a terminal business or protocol failure. */
  readonly failed: (error: unknown) => void
}

/**
 * Create the reconnecting scheduled-task state stream.
 * @param remote - Client Remote face carrying the scheduled-task namespace and the stream factory.
 * @param options - scheduled-task state destinations.
 * @returns an unstarted stream owned by the Client scheduled-task runtime.
 */
export function createCronStateStream(
  remote: CronStreamFactory & Pick<ClientRemote, 'cron'>,
  options: CronStateStreamOptions,
): CronStateStream {
  const stream = remote.$stream<CronBaselineFrame | CronFollowIncrement>({
    name: 'Cron state stream',
    open: signal => remote.cron.follow(signal),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('Cron state stream ended without a terminal result')
      : new Error('Cron state stream ended before its opening snapshot'),
    ...(options.carrierFailed === undefined ? {} : { carrierFailed: options.carrierFailed }),
  })
  return new RemoteSnapshotStream<CronBaselineFrame, CronFollowIncrement>(
    stream,
    {
      name: 'Cron state stream',
      isSnapshot: (frame): frame is CronBaselineFrame => frame.type === 'baseline',
      replace: (frame) => { options.accept.replaceBaseline(frame.value) },
      update: (frame) => { acceptIncrement(options.accept, frame) },
      failed: options.failed,
    },
  )
}

function acceptIncrement(accept: CronFollowSink, frame: CronFollowIncrement): void {
  switch (frame.type) {
    case 'upsert':
      accept.upsertView(frame.job)
      return
    case 'remove':
      accept.removeView(frame.jobId)
      return
    /* v8 ignore next -- the generated Remote codec validates this closed union */
    default:
      return assertNever(frame)
  }
}

/* v8 ignore next 3 -- closed-union backstop after generated Remote validation */
function assertNever(value: never): never {
  throw new Error(`unreachable scheduled-task increment: ${JSON.stringify(value)}`)
}
