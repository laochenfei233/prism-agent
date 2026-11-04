/**
 * Stored custom unit prices, shared by the cost pill, the dashboard, and the
 * completed-Turn panel.
 *
 * @module usage-price-policy
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelUnitPrice, UnitPriceOverrides } from '../contract/usage.ts'

/** Browser-storage key holding the custom unit prices. */
export const USAGE_PRICE_STORAGE_KEY = 'dsh.usage-billing.prices.v1'

/** Largest accepted price per million tokens, in USD. */
const MAX_UNIT_PRICE = 1_000_000

/**
 * Validate one stored price entry.
 * @param value - stored value.
 * @returns whether the value is a usable unit price.
 */
function isUnitPrice(value: unknown): value is ModelUnitPrice {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (['miss', 'hit', 'output'] as const).every((key) => {
    const price = entry[key]
    return typeof price === 'number' && Number.isFinite(price) && price >= 0 && price <= MAX_UNIT_PRICE
  })
}

/**
 * Parse stored custom prices, dropping every malformed entry.
 * @param raw - browser-storage value, or null when nothing is stored.
 * @returns the accepted overrides.
 */
export function parseUnitPriceOverrides(raw: string | null): UnitPriceOverrides {
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Unparsable storage is stale or foreign: no override applies.
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const accepted: [string, ModelUnitPrice][] = []
  for (const [model, entry] of Object.entries(parsed)) {
    if (model === '' || !isUnitPrice(entry)) continue
    accepted.push([model, { miss: entry.miss, hit: entry.hit, output: entry.output }])
  }
  // fromEntries defines own properties, so a stored "__proto__" key cannot rewrite the map prototype.
  return Object.fromEntries(accepted)
}

/** Storage face the policy needs; absent when the browser exposes none. */
function browserStorage(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

/**
 * Live custom unit prices, persisted per browser.
 *
 * A failed read yields no overrides and a failed write keeps the in-memory
 * value: storage problems never break the display.
 *
 * shortcut: overrides live in this browser's storage rather than the Host
 * settings document, so they do not follow the account across browsers; move
 * them into a settings namespace when multi-browser totals matter.
 */
export class UsagePricePolicy {
  /** Current overrides; every entry replaces the built-in price for its model. */
  readonly prices = createSnapshotStore<UnitPriceOverrides>({})

  /** @param storage - browser storage, defaulting to this page's localStorage. */
  constructor(private readonly storage: Storage | undefined = browserStorage()) {
    if (this.storage === undefined) return
    let raw: string | null
    try {
      raw = this.storage.getItem(USAGE_PRICE_STORAGE_KEY)
    } catch {
      // Private mode and blocked storage disable persistence only.
      return
    }
    this.prices.set(parseUnitPriceOverrides(raw))
  }

  /**
   * Store or remove one model's price.
   * @param model - model id the price applies to.
   * @param price - unit price, or null to return the model to its built-in price.
   */
  set(model: string, price: ModelUnitPrice | null): void {
    const kept = Object.entries(this.prices.getSnapshot()).filter(([key]) => key !== model)
    const next = Object.fromEntries(price === null ? kept : [...kept, [model, price] as const])
    this.prices.set(next)
    if (this.storage === undefined) return
    try {
      this.storage.setItem(USAGE_PRICE_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // The accepted value stays live; only its persistence is lost.
    }
  }
}
