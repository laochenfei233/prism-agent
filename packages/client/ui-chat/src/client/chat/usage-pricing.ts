/**
 * Session and Turn cost estimates over the durable token projections.
 *
 * Prices are the official DeepSeek rates in USD per one million tokens. A peak
 * hour bills at {@link PEAK_MULTIPLIER}, and every other hour bills at the
 * listed rate.
 *
 * @module usage-pricing
 */

import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { TurnTokenUsage } from '../contract/chat-nodes.ts'
import type { ModelUnitPrice, UnitPriceOverrides } from '../contract/usage.ts'

/** Built-in DeepSeek prices (`https://api-docs.deepseek.com/quick_start/pricing`). */
export const BUILTIN_UNIT_PRICES: UnitPriceOverrides = {
  'deepseek-flash': { miss: 0.15, hit: 0.003, output: 0.6 },
  'deepseek-v4-pro': { miss: 0.66, hit: 0.022, output: 1.98 },
}

/** Peak billing multiple over the off-peak rate. */
export const PEAK_MULTIPLIER = 2

/** Billing tier of one instant. */
export type BillingTier = 'peak' | 'offPeak'

/** Peak windows in UTC hours, as `[start, end)`, on weekdays. */
const PEAK_WINDOWS_UTC: readonly (readonly [number, number])[] = [[1, 4], [6, 10]]

/**
 * Billing tier of one instant.
 *
 * shortcut: no Chinese public-holiday calendar ships, so a holiday weekday
 * bills as peak; add the calendar when holiday-day accuracy matters.
 * @param at - instant to classify.
 * @returns the tier the provider bills that minute at.
 */
export function billingTier(at: Date): BillingTier {
  const weekday = at.getUTCDay()
  if (weekday === 0 || weekday === 6) return 'offPeak'
  const hour = at.getUTCHours()
  return PEAK_WINDOWS_UTC.some(([start, end]) => hour >= start && hour < end) ? 'peak' : 'offPeak'
}

/**
 * Price multiple of one tier.
 * @param tier - billing tier.
 * @returns the multiple over the listed off-peak prices.
 */
export function tierMultiplier(tier: BillingTier): number {
  return tier === 'peak' ? PEAK_MULTIPLIER : 1
}

/**
 * Resolve the unit price one model bills at.
 * @param model - model id the Session's requests used.
 * @param overrides - stored custom prices, which replace a built-in price.
 * @returns the unit price, or undefined when the model is unpriced.
 */
export function resolveUnitPrice(model: string | undefined, overrides: UnitPriceOverrides): ModelUnitPrice | undefined {
  if (model === undefined) return undefined
  return overrides[model] ?? BUILTIN_UNIT_PRICES[model]
}

/** Disjoint token buckets a price bills. */
export interface TokenBuckets {
  /** Cache-miss prompt tokens. */
  readonly miss: number
  /** Cache-hit prompt tokens. */
  readonly hit: number
  /** Cache-write prompt tokens; the provider has no separate write price. */
  readonly write: number
  readonly output: number
}

/** One priced token bucket. */
export interface PricedBucket {
  readonly id: keyof TokenBuckets
  readonly tokens: number
  readonly usd: number
}

/** One session's estimated cost. */
export interface UsageCost {
  readonly model: string
  readonly tier: BillingTier
  readonly buckets: readonly PricedBucket[]
  readonly totalUsd: number
}

/**
 * Price every bucket of one usage at one tier.
 * @param buckets - disjoint token buckets.
 * @param price - resolved unit price.
 * @param tier - billing tier applied to every bucket.
 * @returns the bucket rows and their total.
 */
export function priceBuckets(
  buckets: TokenBuckets,
  price: ModelUnitPrice,
  tier: BillingTier,
): { readonly buckets: readonly PricedBucket[]; readonly totalUsd: number } {
  const multiplier = tierMultiplier(tier) / 1_000_000
  const rows: PricedBucket[] = [
    { id: 'miss', tokens: buckets.miss, usd: buckets.miss * price.miss * multiplier },
    { id: 'hit', tokens: buckets.hit, usd: buckets.hit * price.hit * multiplier },
    { id: 'write', tokens: buckets.write, usd: buckets.write * price.miss * multiplier },
    { id: 'output', tokens: buckets.output, usd: buckets.output * price.output * multiplier },
  ]
  return { buckets: rows, totalUsd: rows.reduce((sum, row) => sum + row.usd, 0) }
}

/**
 * Estimate one session's cost.
 *
 * The `tokenUsage` projection carries no time or route split, so every bucket
 * is priced at one model and one tier: the Session's current route and the
 * tier active at `at`.
 * @param usage - durable whole-log token buckets.
 * @param model - model the Session's current selection names.
 * @param at - instant whose tier prices the whole estimate.
 * @param overrides - stored custom prices.
 * @returns the estimate, or undefined without a price or billable tokens.
 */
export function sessionCost(
  usage: TokenUsageProjection,
  model: string | undefined,
  at: Date,
  overrides: UnitPriceOverrides,
): UsageCost | undefined {
  const price = resolveUnitPrice(model, overrides)
  if (price === undefined || model === undefined) return undefined
  if (usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens === 0) {
    return undefined
  }
  const tier = billingTier(at)
  return {
    model,
    tier,
    ...priceBuckets({
      miss: usage.uncachedInputTokens,
      hit: usage.cacheReadTokens,
      write: usage.cacheWriteTokens,
      output: usage.outputTokens,
    }, price, tier),
  }
}

/**
 * Price one completed Turn, whose attempts all report the same route.
 * @param usage - exact Turn accounting.
 * @param at - instants whose tier prices the Turn; the caller passes its end time.
 * @param overrides - stored custom prices.
 * @returns the priced buckets, or undefined for a multi-route or unpriced Turn.
 */
export function turnCost(
  usage: TurnTokenUsage,
  at: Date,
  overrides: UnitPriceOverrides,
): { readonly tier: BillingTier; readonly buckets: readonly PricedBucket[]; readonly totalUsd: number } | undefined {
  const routes = usage.routes
  if (routes === undefined || routes.length !== 1) return undefined
  const price = resolveUnitPrice(routes[0]?.model, overrides)
  if (price === undefined) return undefined
  const tier = billingTier(at)
  return { tier, ...priceBuckets({
    miss: usage.uncachedInputTokens,
    hit: usage.cacheReadTokens ?? 0,
    write: usage.cacheWriteTokens ?? 0,
    output: usage.outputTokens,
  }, price, tier) }
}

/**
 * Format a USD amount into a locale-free number string.
 * @param value - amount in USD.
 * @returns two decimals from one cent up, more precision below it.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0.00'
  if (value >= 0.01) return value.toFixed(2)
  if (value >= 0.0001) return value.toFixed(4)
  return value.toFixed(6)
}
