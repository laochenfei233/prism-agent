import { describe, expect, it } from 'vitest'
import type { ModelUnitPrice } from '../src/client/contract/usage.ts'
import {
  USAGE_PRICE_STORAGE_KEY, UsagePricePolicy, parseUnitPriceOverrides,
} from '../src/client/chat/usage-price-policy.ts'

/** In-memory storage double with the browser's Storage surface. */
class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>()

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.entries.set(key, value)
  }

  get length(): number { return this.entries.size }
  clear(): void { this.entries.clear() }
  getItem(key: string): string | null { return this.entries.get(key) ?? null }
  key(index: number): string | null { return [...this.entries.keys()][index] ?? null }
  removeItem(key: string): void { this.entries.delete(key) }
  setItem(key: string, value: string): void { this.entries.set(key, value) }
}

const PRICE: ModelUnitPrice = { miss: 1, hit: 0.1, output: 2 }

describe('stored price parsing', () => {
  it('accepts complete non-negative prices and drops every malformed entry', () => {
    const raw = JSON.stringify({
      good: PRICE,
      zero: { miss: 0, hit: 0, output: 0 },
      missing: { miss: 1, hit: 2 },
      negative: { miss: -1, hit: 0, output: 0 },
      notNumber: { miss: '1', hit: 0, output: 0 },
      huge: { miss: 1_000_001, hit: 0, output: 0 },
      '': PRICE,
      scalar: 3,
    })
    expect(parseUnitPriceOverrides(raw)).toEqual({ good: PRICE, zero: { miss: 0, hit: 0, output: 0 } })
  })

  it('reads absent, unparsable, and non-object values as no overrides', () => {
    expect(parseUnitPriceOverrides(null)).toEqual({})
    expect(parseUnitPriceOverrides('{')).toEqual({})
    expect(parseUnitPriceOverrides('[]')).toEqual({})
    expect(parseUnitPriceOverrides('42')).toEqual({})
  })

  it('keeps a stored __proto__ key as data instead of rewriting the map prototype', () => {
    const parsed = parseUnitPriceOverrides('{"__proto__":{"miss":1,"hit":0.1,"output":2},"ok":{"miss":1,"hit":0.1,"output":2}}')
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true)
    expect(parsed.ok).toEqual(PRICE)
  })
})

describe('price policy', () => {
  it('adopts stored overrides at construction', () => {
    const storage = new MemoryStorage({ [USAGE_PRICE_STORAGE_KEY]: JSON.stringify({ model: PRICE }) })
    expect(new UsagePricePolicy(storage).prices.getSnapshot()).toEqual({ model: PRICE })
  })

  it('persists a stored price and removes it again', () => {
    const storage = new MemoryStorage()
    const policy = new UsagePricePolicy(storage)
    policy.set('model', PRICE)
    expect(policy.prices.getSnapshot()).toEqual({ model: PRICE })
    expect(JSON.parse(storage.getItem(USAGE_PRICE_STORAGE_KEY) ?? '')).toEqual({ model: PRICE })
    policy.set('model', null)
    expect(policy.prices.getSnapshot()).toEqual({})
    expect(JSON.parse(storage.getItem(USAGE_PRICE_STORAGE_KEY) ?? '')).toEqual({})
  })

  it('keeps the accepted value live when storage refuses the write', () => {
    const storage = new MemoryStorage()
    storage.setItem = () => { throw new Error('quota') }
    const policy = new UsagePricePolicy(storage)
    policy.set('model', PRICE)
    expect(policy.prices.getSnapshot()).toEqual({ model: PRICE })
  })

  it('works without storage and ignores a storage read failure', () => {
    expect(new UsagePricePolicy(undefined).prices.getSnapshot()).toEqual({})
    const failing = new MemoryStorage()
    failing.getItem = () => { throw new Error('blocked') }
    expect(new UsagePricePolicy(failing).prices.getSnapshot()).toEqual({})
  })
})
