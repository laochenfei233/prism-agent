/**
 * Locale contract: the two dictionaries carry exactly the same key set, and
 * no value is empty.
 */
import { describe, expect, it } from 'vitest'
import { en, NS, zh } from '../src/client/locales.ts'

describe('local-models locale dictionaries', () => {
  it('define identical key sets in en and zh', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('bind every key to non-empty copy', () => {
    for (const [dictionary, name] of [[en, 'en'], [zh, 'zh']] as const) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect(value, `${name} ${key}`).not.toHaveLength(0)
      }
    }
  })

  it('expose a namespaced NS', () => {
    expect(NS).toMatch(/^prism-local-models\./)
  })
})
