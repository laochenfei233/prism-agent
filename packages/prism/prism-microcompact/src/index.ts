/**
 * Prism microcompact service (`ctx.microcompact`): a model-free microcompact pass
 * that clears stale tool results when context pressure crosses its arming
 * threshold — delaying full summarization compaction — plus a pressure query
 * for threshold tracking. Composes beside `dsh-compaction-basic`, whose
 * pre-step listener must register after this one so the cheap pass runs first.
 * @module @prism/prism-microcompact
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
// Type-only: the `compaction/prune` SessionEventMap merge used by replacements.
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { MicrocompactPressureConfigError, resolveConfig, resolveThreshold } from './config.ts'
import { microcompactSurface } from './microcompact.ts'
import type { MicrocompactResult, PressureSnapshot, PrismMicrocompactConfig, ResolvedConfig } from './types.ts'

export { DEFAULTS, MicrocompactPressureConfigError, resolveConfig, resolveThreshold } from './config.ts'
export { microcompactSurface, stubText } from './microcompact.ts'
export type {
  ClearedEntry,
  MicrocompactResult,
  PressureSnapshot,
  PrismMicrocompactConfig,
  ResolvedConfig,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Model-free microcompact guard and pressure tracking (one per host context). */
    microcompact: PrismMicrocompact
  }
}

/** Minimal agent surface the guard needs, satisfied by the loop's `Agent`. */
interface MicrocompactAgent {
  /** Session whose surface is measured and rewritten. */
  session: Session
}

/** Resolved measurement envelope behind both the arming check and `pressure()`. */
interface PressureEnvelope {
  measurement: { totalTokens: number }
  contextWindow: number
  thresholdTokens: number
}

/**
 * Durable routing facts of the latest request: the exact provider/model pair
 * and the per-request output cap when the header declared one.
 */
function routedCapacity(
  session: Session,
): { target: Pick<LlmCallConfig, 'provider' | 'model'>; requestMaxTokens: number | undefined } | undefined {
  const header = session.requestHeader()?.config
  if (header === undefined || header.provider.length === 0 || header.model.length === 0) {
    return undefined
  }
  return {
    target: { provider: header.provider, model: header.model },
    requestMaxTokens: header.maxTokens,
  }
}

/**
 * Model-free context guard. Above its arming threshold it clears stale tool
 * results in place (no model call), which can hold a conversation below
 * `dsh-compaction-basic`'s summarization threshold indefinitely. Guard
 * failures log a warning and never block the step.
 */
export class PrismMicrocompact extends Service {
  static inject = ['llm', 'tokenMeter']

  static Config: z<PrismMicrocompactConfig> = z.object({
    thresholdRatio: z.number(),
    headroomTokens: z.number().step(1).min(0),
    keepRecentResults: z.number().step(1).min(1),
    tools: z.array(z.string()),
  })

  /** Resolved and immutable guard configuration. */
  readonly config: ResolvedConfig

  private readonly warnedThresholdTargets = new Set<string>()

  constructor(ctx: Context, config: PrismMicrocompactConfig = {}) {
    super(ctx, 'microcompact')
    this.config = resolveConfig(config)
    this.registerPreStep()
  }

  private registerPreStep(): void {
    this.ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = await this.microcompactIfNeeded(agent, signal)
          if (result !== null) {
            this.ctx.logger.info(
              `microcompact: cleared ${result.cleared.length} stale tool results `
              + `(~${result.estimatedTokensFreed} estimated tokens freed)`,
            )
          }
        } catch (error: unknown) {
          if (error instanceof MicrocompactPressureConfigError) {
            if (!this.warnedThresholdTargets.has(error.targetKey)) {
              this.warnedThresholdTargets.add(error.targetKey)
              this.ctx.logger.warn(`microcompact failed: ${error.message}; continuing the turn`)
            }
          } else {
            const message = error instanceof Error ? error.message : String(error)
            this.ctx.logger.warn(`microcompact failed: ${message}; continuing the turn`)
          }
        }
      }
      return next()
    })
  }

  /**
   * Run one microcompact pass when the routed conversation is at or above the
   * configured arming threshold.
   * @param agent - agent owning the measured session surface.
   * @param signal - live turn cancellation signal forwarded to route resolution.
   * @returns the landed pass, or `null` when no durable routed request exists,
   * the routed model declares no context capacity, or pressure is below threshold.
   */
  async microcompactIfNeeded(
    agent: MicrocompactAgent,
    signal: AbortSignal,
  ): Promise<MicrocompactResult | null> {
    const envelope = await this.resolveEnvelope(agent, signal)
    if (envelope === null) return null
    if (envelope.measurement.totalTokens < envelope.thresholdTokens) return null
    return microcompactSurface(agent.session, this.ctx.tokenMeter, this.config)
  }

  /**
   * Measure the routed conversation against the microcompact arming threshold.
   * @param agent - agent owning the measured session surface.
   * @returns a detached snapshot, or `null` when no durable routed request
   * exists yet or the routed model declares no context capacity.
   */
  async pressure(agent: MicrocompactAgent): Promise<PressureSnapshot | null> {
    const envelope = await this.resolveEnvelope(agent, new AbortController().signal)
    if (envelope === null) return null
    return {
      totalTokens: envelope.measurement.totalTokens,
      contextWindow: envelope.contextWindow,
      thresholdTokens: envelope.thresholdTokens,
      willMicrocompact: envelope.measurement.totalTokens >= envelope.thresholdTokens,
    }
  }

  /** Shared routed-target resolution for the arming check and tracking. */
  private async resolveEnvelope(
    agent: MicrocompactAgent,
    signal: AbortSignal,
  ): Promise<PressureEnvelope | null> {
    const routed = routedCapacity(agent.session)
    if (routed === undefined) return null
    const info = await this.ctx.llm.resolveModelInfo(routed.target.provider, routed.target.model, signal)
    if (info.context === undefined) return null
    const reserved = routed.requestMaxTokens ?? info.defaultMaxTokens ?? 0
    const thresholdTokens = resolveThreshold(
      this.config,
      `${routed.target.provider}/${routed.target.model}`,
      info.context.contextWindow,
      reserved,
    )
    return {
      measurement: this.ctx.tokenMeter.measure(agent.session),
      contextWindow: info.context.contextWindow,
      thresholdTokens,
    }
  }
}

export default PrismMicrocompact
