/**
 * Cron capability plugin.
 *
 * The package owns the calendar vocabulary a scheduled task is written in
 * ({@link ./expression.ts}), the instant rule that resolves it in an explicit
 * zone ({@link ./occurrence.ts}), the durable record a task is stored as
 * ({@link ./records.ts}), the store and its single-leader lease
 * ({@link ./store.ts}, {@link ./lease.ts}), the `ctx.cron` management surface
 * ({@link ./provider.ts}), and the delivery of one firing into a Session
 * ({@link ./delivery.ts}).
 *
 * This module is the package entry and the Cordis plugin: it takes the leader
 * lease, opens the `cron` domain only while holding it, publishes the management
 * service over whatever store this process leads, and composes the run body that
 * delivers a firing.
 * @module @deepseek-ai/dsh-cron
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { Config, resolveCronConfig } from './config.ts'
import { CronDelivery } from './delivery.ts'
import type { CronLoadedAgent } from './delivery.ts'
import { CronOwnership } from './ownership.ts'
import { CronProvider } from './provider.ts'
import { CronRunner } from './run.ts'
import { CronRuntime } from './runtime.ts'
import { cronDomainSpec } from './spec.ts'
import { CronStore } from './store.ts'

export { Config, resolveCronConfig }
export type { CronConfig } from './config.ts'
export { CronServiceError } from './error.ts'
export { CronExpressionError, matchesCronDay, parseCronExpression } from './expression.ts'
export type { CronExpression, CronField } from './expression.ts'
export { MAX_SEARCH_DAYS, nextCronOccurrence } from './occurrence.ts'
export { CRON_RECORD_VERSION, CronRecordError, cronJobSchema, decodeStoredCronJob } from './records.ts'
export { CronLeadership, LEADER_LOCK_FILENAME } from './lease.ts'
export { cronDomainSpec, cronDomainState } from './spec.ts'
export type { CronDomainState } from './spec.ts'
export { CronStore } from './store.ts'
export { CronOwnership } from './ownership.ts'
export type { CronOwnershipOptions } from './ownership.ts'
export { CronService } from './service.ts'
export type { CronJobRequest, CronJobUpdate } from './service.ts'
export { CronProvider } from './provider.ts'
export type { CronProviderOptions } from './provider.ts'
export { CronRunner, MAX_TIMER_DELAY_MS } from './run.ts'
export type { CronRunBody, CronRunnerOptions } from './run.ts'
export { CronRuntime } from './runtime.ts'
export type { CronRuntimeOptions } from './runtime.ts'
export { CronDelivery, renderCronTaskFraming } from './delivery.ts'
export type {
  CronDeliveredAgent,
  CronDeliveryOptions,
  CronLoadedAgent,
  CronNewSessionRequest,
} from './delivery.ts'
export type {
  CronErrorCode,
  CronExistingSessionTarget,
  CronJob,
  CronJobId,
  CronMisfirePolicy,
  CronModelSelection,
  CronNewSessionTarget,
  CronOverlapPolicy,
  CronRunOutcome,
  CronRunRecord,
  CronTarget,
} from './types.ts'

/** Cordis plugin name. */
export const name = 'cron'

/**
 * The plugin's dependencies: the storage domain form that owns the durable job
 * table, the timer service whose effect-scoped helper owns the leadership
 * retry, and the Agents service every delivery reaches a Session through.
 */
export const inject = ['storageDomain', 'timer', 'agents']

/**
 * Mount the cron capability.
 *
 * The plugin takes the leader lease and opens the `cron` domain only while
 * holding it, so a process that is not the scheduler serves no stale rows and
 * answers `cron_not_leader` instead.
 *
 * The lease, the store, and the timer are owned by one effect: disposal cancels
 * a pending takeover attempt, closes the store, and releases the lease, in that
 * order. Delivery is owned beside them and registered before the timer, so
 * disposal stops scheduling first, then aborts a delivery in flight, and only
 * then closes the store that records it. A load that cannot take the lease for a
 * reason other than contention fails here, which is the earliest point that can
 * report it.
 * @param ctx - the context the lease, its retry timer, and the service belong to.
 * @param config - the validated plugin config.
 * @returns resolution after the first leadership attempt settled.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const settings = resolveCronConfig(config)
  // Every domain this composition opened. The ownership holds at most one store
  // at a time, so closing all of them is closing the one it named.
  const domains = new Map<CronStore, Domain<typeof cronDomainSpec>>()
  const led: { runtime: CronRuntime | undefined } = { runtime: undefined }
  const started = Promise.withResolvers<CronOwnership>()

  ctx.effect(async () => {
    try {
      const ownership = await CronOwnership.start({
        lockPath: settings.leaderLockPath,
        retryMs: settings.leaderRetryMs,
        openStore: async () => {
          const domain = await ctx.storageDomain.open(cronDomainSpec)
          const store = new CronStore(domain.table('jobs'), domain.global)
          domains.set(store, domain)
          return store
        },
        closeStore: async () => {
          const opened = [...domains.values()]
          domains.clear()
          await Promise.all(opened.map(async domain => domain.close()))
        },
        // A takeover is the only later transition: once this process leads it
        // keeps leading until disposal, and disposal stops the runtime first.
        onStore: () => { led.runtime?.start() },
        // The fiber owns the retry timer, so unloading this plugin cancels a
        // pending takeover attempt before the lease is touched.
        scheduleRetry: (attempt, delayMs) => ctx.timeout(attempt, delayMs),
      })
      started.resolve(ownership)
      return async () => { await ownership.dispose() }
    } catch (error: unknown) {
      // The load must settle either way: the caller of `apply` waits for this
      // attempt, and an unsettled promise would hang activation instead of
      // reporting the failure.
      started.reject(error)
      throw error
    }
  }, 'cron.ownership')

  const ownership = await started.promise
  const clock = (): number => Date.now()
  const delivery = new CronDelivery({
    liveAgent: id => ctx.agents.get(id),
    createSession: async (request, signal) => {
      const agentPresets = ctx.get('agentPresets')
      const permissionPresets = ctx.get('permissionPresets')
      if (agentPresets === undefined || permissionPresets === undefined) {
        throw new Error(
          'cron: a new-session target requires the agentPresets and permissionPresets services; the run would not compose the Session the job declared',
        )
      }
      const preset = await agentPresets.resolve(request.agentPreset)
      await using scope = await agentPresets.acquireScope(preset.id)
      void scope
      const handle = await ctx.agents.create({
        sessionId: request.sessionId,
        signal,
        meta: { cwd: request.workspacePath, agentPreset: preset.id },
        ...request.model === undefined
          ? {}
          : { agentOptions: { provider: request.model.provider, model: request.model.model } },
        setup: async (agentCtx) => { await agentPresets.mount(agentCtx, preset.id) },
      })
      try {
        // A created Session that cannot take its declared permission preset is
        // not the Session the job asked for, so it is rolled back here rather
        // than delivered into.
        permissionPresets.set(handle.agent.session, request.permissionPreset)
      } catch (error: unknown) {
        await handle.dispose()
        throw error
      }
      return deliverable(handle)
    },
    resumeSession: async (id, signal) => {
      if (ctx.get('sessionPersistence') === undefined) {
        throw new Error(
          `cron: resuming the cold Session '${id}' requires the sessionPersistence service; the run would not survive this process`,
        )
      }
      return deliverable(await ctx.agents.resume({ resumeSessionId: id, signal }))
    },
    warn: (message) => { ctx.logger.warn(message) },
  })
  // Registered before the runtime, so disposal stops the timer first, then
  // aborts a delivery in flight, and only then lets the store close.
  ctx.effect(() => () => delivery.dispose(), 'cron.delivery')
  const runner = new CronRunner({
    store: () => ownership.current,
    body: (job, signal) => delivery.deliver(job, signal),
    maxRunsPerJob: settings.maxRunsPerJob,
    now: clock,
  })
  const runtime = new CronRuntime({
    store: () => ownership.current,
    runner,
    now: clock,
    warn: (message) => { ctx.logger.warn(message) },
  })
  led.runtime = runtime
  // Registered after the ownership effect, so disposal stops the timer before the
  // store it reads is closed.
  ctx.effect(() => () => runtime.dispose(), 'cron.runtime')
  // Constructing the provider is the registration: a Cordis service publishes
  // itself through an effect on this fiber, so disposal unregisters it.
  new CronProvider(ctx, {
    store: () => ownership.current,
    runner,
    now: clock,
    defaultMaxRunMs: settings.defaultMaxRunMs,
  })
  // Leadership may already have been taken while this load was awaiting it, in
  // which case the takeover callback above had no runtime to start.
  if (ownership.current !== undefined) runtime.start()
}

/**
 * The delivery's view of one Agent this composition created or resumed.
 * @param handle - the owned handle the Agent was published under.
 * @returns the follow-up a delivery queues and the disposal its rollback uses.
 */
function deliverable(handle: AgentHandle): CronLoadedAgent {
  return {
    followup: (message) => { handle.agent.followup(message) },
    dispose: async () => { await handle.dispose() },
  }
}
