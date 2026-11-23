/** Configuration resolution and threshold math for the microcompact guard. */

import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { PrismMicrocompactConfig, ResolvedConfig } from './types.ts'

/**
 * Low-friction defaults. On the default 1,000,000-token window with 256,000
 * reserved output tokens, the arming threshold lands at 612,928 — below
 * `dsh-compaction-basic`'s 678,464 arm point, so the model-free pass runs first.
 */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  thresholdRatio: 0.7,
  headroomTokens: 131_072,
  keepRecentResults: 4,
  tools: undefined,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'thresholdRatio',
  'headroomTokens',
  'keepRecentResults',
  'tools',
])

/**
 * Resolve and validate the guard configuration.
 * @param config - raw plugin configuration.
 * @returns a detached deeply immutable configuration.
 */
export function resolveConfig(config: PrismMicrocompactConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `PrismMicrocompactConfig: unknown key "${key}" `
        + '(allowed: thresholdRatio, headroomTokens, keepRecentResults, tools)',
      )
    }
  }

  const resolved: ResolvedConfig = {
    thresholdRatio: config.thresholdRatio ?? DEFAULTS.thresholdRatio,
    headroomTokens: config.headroomTokens ?? DEFAULTS.headroomTokens,
    keepRecentResults: config.keepRecentResults ?? DEFAULTS.keepRecentResults,
    // Schemastery turns an omitted array field into `[]`; treat that like the
    // documented omission so an unconfigured filter clears every tool's results.
    tools: config.tools === undefined || config.tools.length === 0 ? undefined : deepFreeze([...config.tools]),
  }
  if (!Number.isFinite(resolved.thresholdRatio) || resolved.thresholdRatio <= 0 || resolved.thresholdRatio > 1) {
    throw new Error(`PrismMicrocompactConfig: thresholdRatio (${resolved.thresholdRatio}) must be within (0, 1]`)
  }
  assertNonNegativeInteger('headroomTokens', resolved.headroomTokens)
  assertPositiveInteger('keepRecentResults', resolved.keepRecentResults)
  if (resolved.tools !== undefined) {
    for (const tool of resolved.tools) {
      if (tool.length === 0) {
        throw new Error('PrismMicrocompactConfig: tools entries must be non-empty strings')
      }
    }
  }
  return deepFreeze(resolved)
}

/**
 * Resolve the token threshold at which microcompact arms for one routed capacity.
 *
 * The envelope mirrors `dsh-compaction-basic`'s shape with the guard's own
 * headroom so the result can land below compaction's arm point; a threshold at
 * or above compaction's makes this pass unreachable.
 * @param config - resolved guard configuration.
 * @param targetKey - routed provider/model pair for error reporting.
 * @param contextWindow - positive adapter-owned capacity for the routed model.
 * @param reservedCompletionTokens - output tokens one routed request reserves.
 * @returns the arming threshold in estimated tokens.
 * @throws {@link MicrocompactPressureConfigError} when the capacity leaves no usable budget.
 */
export function resolveThreshold(
  config: ResolvedConfig,
  targetKey: string,
  contextWindow: number,
  reservedCompletionTokens: number,
): number {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    throw new MicrocompactPressureConfigError(
      targetKey,
      `prism-microcompact: contextWindow (${contextWindow}) for ${targetKey} must be a positive integer`,
    )
  }
  if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) {
    throw new MicrocompactPressureConfigError(
      targetKey,
      `prism-microcompact: reservedCompletionTokens (${reservedCompletionTokens}) for ${targetKey} `
      + 'must be a non-negative integer',
    )
  }
  const messageBudgetTokens = contextWindow - reservedCompletionTokens
  if (messageBudgetTokens <= 0) {
    throw new MicrocompactPressureConfigError(
      targetKey,
      `prism-microcompact: ${targetKey} reserves ${reservedCompletionTokens} completion tokens `
      + `of its ${contextWindow}-token context window, leaving no message budget; configure `
      + "the adapter model's contextWindow above the effective request maxTokens",
    )
  }
  const pressureBudgetTokens = messageBudgetTokens - config.headroomTokens
  if (pressureBudgetTokens <= 0) {
    throw new MicrocompactPressureConfigError(
      targetKey,
      `prism-microcompact: ${targetKey} reserves ${reservedCompletionTokens} completion tokens `
      + `and ${config.headroomTokens} headroom tokens of its ${contextWindow}-token context `
      + 'window, leaving no microcompact budget; reduce the effective request maxTokens or '
      + "the guard's headroomTokens, or configure a larger adapter model contextWindow",
    )
  }
  const threshold = Math.floor(Math.min(contextWindow * config.thresholdRatio, pressureBudgetTokens))
  if (threshold <= 0) {
    throw new MicrocompactPressureConfigError(
      targetKey,
      `prism-microcompact: arming threshold computed for ${targetKey} is ${threshold}; `
      + 'raise thresholdRatio or lower headroomTokens',
    )
  }
  return threshold
}

/**
 * Expected configuration failure for one routed capacity. The pre-step listener
 * warns once per target instead of failing the turn.
 */
export class MicrocompactPressureConfigError extends Error {
  override readonly name = 'MicrocompactPressureConfigError'

  /**
   * Create one classified guard threshold failure.
   * @param targetKey - routed provider/model pair the failure applies to.
   * @param message - full diagnostic retained as the Error message.
   */
  constructor(
    readonly targetKey: string,
    message: string,
  ) {
    super(message)
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`PrismMicrocompactConfig: ${name} (${value}) must be a non-negative integer`)
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`PrismMicrocompactConfig: ${name} (${value}) must be a positive integer`)
  }
}
