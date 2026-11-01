/**
 * Configuration: schema defaults, load-time rejection of out-of-range values,
 * and the per-search snapshot that clamps a configured integer.
 */
import { describe, expect, it } from 'vitest'
import { Config, resolveOptions, type Config as ConfigShape } from '../src/config.ts'

/** A volatile field the Loader would hand to `apply`. */
function field<T>(value: T): { get(): T } {
  return { get: () => value }
}

/** A complete field set built from one override object. */
function configOf(overrides: Partial<ConfigShape> = {}): ConfigShape {
  return {
    rerankProvider: field(''),
    rerankModel: field(''),
    fetchTopN: field(8),
    engineTimeoutMs: field(8000),
    fetchTimeoutMs: field(8000),
    rerankTimeoutMs: field(20000),
    maxSnippetChars: field(1200),
    maxRerankCandidates: field(12),
    ...overrides,
  }
}

describe('Config', () => {
  it('resolves the shipped defaults', () => {
    const resolved = resolveOptions(Config({}))
    expect(resolved).toEqual({
      rerankProvider: '',
      rerankModel: '',
      fetchTopN: 8,
      engineTimeoutMs: 8000,
      fetchTimeoutMs: 8000,
      rerankTimeoutMs: 20000,
      maxSnippetChars: 1200,
      maxRerankCandidates: 12,
    })
  })

  it('validates bounds at load instead of silently accepting them', () => {
    expect(() => Config({ fetchTopN: -1 })).toThrow()
    expect(() => Config({ maxRerankCandidates: 500 })).toThrow()
  })
})

describe('resolveOptions', () => {
  it('trims the model route and clamps a non-integer back to its default', () => {
    const resolved = resolveOptions(configOf({
      rerankProvider: field('  provider-a  '),
      rerankModel: field(' model-a '),
      fetchTopN: field(2.5),
    }))
    expect(resolved.rerankProvider).toBe('provider-a')
    expect(resolved.rerankModel).toBe('model-a')
    expect(resolved.fetchTopN).toBe(8)
  })

  it('clamps an integer outside the accepted range', () => {
    expect(resolveOptions(configOf({ maxSnippetChars: field(999999) })).maxSnippetChars).toBe(20000)
    expect(resolveOptions(configOf({ engineTimeoutMs: field(1) })).engineTimeoutMs).toBe(500)
  })
})
