/** Copy-parity guards for the About section's dictionaries. */
import { describe, expect, it } from 'vitest'
import { en, NS, zh } from '../src/client/locales.ts'

describe('settings.about dictionaries', () => {
  it('exposes one namespace and complete key parity', () => {
    expect(NS).toBe('settings.about')
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const [key, value] of Object.entries(zh)) {
      expect(en[key], `en misses ${key}`).not.toBeUndefined()
      expect(value.length, `zh ${key} is empty`).toBeGreaterThan(0)
      expect(en[key].length, `en ${key} is empty`).toBeGreaterThan(0)
    }
  })

  it('keeps interpolation placeholders paired across locales', () => {
    for (const [key, value] of Object.entries(zh)) {
      const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
      expect(placeholders(en[key]), `placeholder drift on ${key}`).toEqual(placeholders(value))
    }
  })
})
