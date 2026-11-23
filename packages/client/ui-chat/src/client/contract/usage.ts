/**
 * Shared cost vocabulary: unit prices, stored overrides, and the injected
 * faces that publish them to renderers.
 *
 * @module contract/usage
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

/** Unit prices in USD per one million tokens, at the off-peak rate. */
export interface ModelUnitPrice {
  /** Cache-miss prompt tokens. */
  readonly miss: number
  /** Cache-hit prompt tokens. */
  readonly hit: number
  /** Output tokens, reasoning included. */
  readonly output: number
}

/** Stored per-model unit prices, replacing the built-in price for that model. */
export type UnitPriceOverrides = Readonly<Record<string, ModelUnitPrice>>

/** Custom unit prices for renderers that only read them. */
export interface UsagePriceInjected {
  hooks: {
    /** Live custom unit prices, keyed by model id. */
    unitPrices: ObservableSnapshot<UnitPriceOverrides>
  }
}

/** Custom unit prices plus the write face for the dashboard editor. */
export interface UsagePriceEditorInjected extends UsagePriceInjected {
  /**
   * Store one model's custom price.
   * @param model - model id the price applies to.
   * @param price - unit price, or null to drop the override.
   */
  setUnitPrice(model: string, price: ModelUnitPrice | null): void
}
