import { describe, expect, it } from 'vitest'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { TurnTokenUsage } from '../src/client/contract/chat-nodes.ts'
import {
  BUILTIN_UNIT_PRICES, billingTier, formatUsd, priceBuckets, resolveUnitPrice, sessionCost, tierMultiplier, turnCost,
} from '../src/client/chat/usage-pricing.ts'

/** Off-peak Monday instant (UTC). */
const OFF_PEAK = new Date('2026-11-02T05:00:00Z')
/** Peak Monday instant inside the 01:00–04:00 UTC window. */
const PEAK = new Date('2026-11-02T02:30:00Z')

const FLASH = BUILTIN_UNIT_PRICES['deepseek-flash']!

function usage(over: Partial<TokenUsageProjection> = {}): TokenUsageProjection {
  return { uncachedInputTokens: 1_000_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000, ...over }
}

function turn(over: Partial<TurnTokenUsage> = {}): TurnTokenUsage {
  return {
    uncachedInputTokens: 1_000_000,
    outputTokens: 1_000_000,
    totalTokens: 2_000_000,
    routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
    ...over,
  }
}

describe('billing tier', () => {
  it('bills the two weekday UTC windows at peak and everything else off-peak', () => {
    expect(billingTier(new Date('2026-11-02T00:59:00Z'))).toBe('offPeak')
    expect(billingTier(new Date('2026-11-02T01:00:00Z'))).toBe('peak')
    expect(billingTier(new Date('2026-11-02T03:59:00Z'))).toBe('peak')
    expect(billingTier(new Date('2026-11-02T04:00:00Z'))).toBe('offPeak')
    expect(billingTier(new Date('2026-11-02T06:00:00Z'))).toBe('peak')
    expect(billingTier(new Date('2026-11-02T09:59:00Z'))).toBe('peak')
    expect(billingTier(new Date('2026-11-02T10:00:00Z'))).toBe('offPeak')
  })

  it('bills weekends off-peak at every hour', () => {
    expect(billingTier(new Date('2026-11-07T02:30:00Z'))).toBe('offPeak')
    expect(billingTier(new Date('2026-11-08T02:30:00Z'))).toBe('offPeak')
  })

  it('doubles the rate at peak and keeps it at off-peak', () => {
    expect(tierMultiplier('peak')).toBe(2)
    expect(tierMultiplier('offPeak')).toBe(1)
  })
})

describe('unit prices', () => {
  it('resolves a built-in price and lets a custom price replace it', () => {
    expect(resolveUnitPrice('deepseek-v4-pro', {})).toEqual(BUILTIN_UNIT_PRICES['deepseek-v4-pro'])
    const custom = { miss: 1, hit: 0.1, output: 2 }
    expect(resolveUnitPrice('deepseek-flash', { 'deepseek-flash': custom })).toEqual(custom)
  })

  it('answers nothing for an unknown or absent model', () => {
    expect(resolveUnitPrice('unlisted', {})).toBeUndefined()
    expect(resolveUnitPrice(undefined, {})).toBeUndefined()
  })

  it('keeps prototype member names unpriced instead of resolving a function', () => {
    expect(resolveUnitPrice('toString', {})).toBeUndefined()
    expect(resolveUnitPrice('constructor', {})).toBeUndefined()
    expect(resolveUnitPrice('__proto__', {})).toBeUndefined()
  })
})

describe('bucket pricing', () => {
  it('prices the disjoint buckets, charging a cache write at the cache-miss rate', () => {
    const off = priceBuckets({ miss: 1_000_000, hit: 2_000_000, write: 1_000_000, output: 1_000_000 }, FLASH, 'offPeak')
    expect(off.buckets.map(bucket => bucket.id)).toEqual(['miss', 'hit', 'write', 'output'])
    expect(off.buckets.map(bucket => bucket.usd)[0]).toBeCloseTo(0.15, 10)
    expect(off.buckets.map(bucket => bucket.usd)[1]).toBeCloseTo(0.006, 10)
    expect(off.buckets.map(bucket => bucket.usd)[2]).toBeCloseTo(0.15, 10)
    expect(off.buckets.map(bucket => bucket.usd)[3]).toBeCloseTo(0.6, 10)
    expect(off.totalUsd).toBeCloseTo(0.906, 10)

    const peak = priceBuckets({ miss: 1_000_000, hit: 2_000_000, write: 1_000_000, output: 1_000_000 }, FLASH, 'peak')
    expect(peak.totalUsd).toBeCloseTo(1.812, 10)
  })
})

describe('session cost', () => {
  it('prices the whole-log buckets at the current route and tier', () => {
    const cost = sessionCost(usage(), 'deepseek-flash', PEAK, {})
    expect(cost?.model).toBe('deepseek-flash')
    expect(cost?.tier).toBe('peak')
    expect(cost?.totalUsd).toBeCloseTo(1.812, 10)
  })

  it('answers nothing without a price or without billable tokens', () => {
    expect(sessionCost(usage(), 'unlisted', OFF_PEAK, {})).toBeUndefined()
    expect(sessionCost(usage({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }), 'deepseek-flash', OFF_PEAK, {})).toBeUndefined()
  })
})

describe('turn cost', () => {
  it('prices a single-route Turn at its end-time tier', () => {
    const off = turnCost(turn(), OFF_PEAK, {})
    expect(off?.tier).toBe('offPeak')
    expect(off?.totalUsd).toBeCloseTo(0.75, 10)
    expect(turnCost(turn(), PEAK, {})?.totalUsd).toBeCloseTo(1.5, 10)
  })

  it('treats absent cache buckets as zero and honors a custom price', () => {
    const cost = turnCost({
      uncachedInputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
    }, OFF_PEAK, { 'deepseek-flash': { miss: 1, hit: 1, output: 2 } })
    expect(cost?.totalUsd).toBeCloseTo(3, 10)
  })

  it('answers nothing when the Turn spans routes or has no route', () => {
    expect(turnCost({
      uncachedInputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
    }, OFF_PEAK, {})).toBeUndefined()
    expect(turnCost(turn({
      routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }],
    }), OFF_PEAK, {})).toBeUndefined()
  })

  it('answers nothing for an unpriced route', () => {
    expect(turnCost(turn({ routes: [{ provider: 'other', model: 'unlisted' }] }), OFF_PEAK, {})).toBeUndefined()
  })
})

describe('amount formatting', () => {
  it('keeps two decimals from one cent up and adds precision below it', () => {
    expect(formatUsd(0)).toBe('0.00')
    expect(formatUsd(-1)).toBe('0.00')
    expect(formatUsd(Number.NaN)).toBe('0.00')
    expect(formatUsd(0.5)).toBe('0.50')
    expect(formatUsd(0.0123)).toBe('0.01')
    expect(formatUsd(0.0005)).toBe('0.0005')
    expect(formatUsd(0.00005)).toBe('0.000050')
  })
})
