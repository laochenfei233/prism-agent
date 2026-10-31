import { describe, expect, it } from 'vitest'
import { sanitizeProjectDirectoryName, uniqueDirectoryName } from '../src/naming.ts'

describe('sanitizeProjectDirectoryName', () => {
  it('strips Windows-forbidden and control characters', () => {
    expect(sanitizeProjectDirectoryName('a<b>c:"d/e\\f|g?h*i', 'fallback')).toBe('a b c d e f g h i')
    expect(sanitizeProjectDirectoryName('log\u0007file', 'fallback')).toBe('log file')
  })

  it('collapses whitespace and trims trailing dots and spaces', () => {
    expect(sanitizeProjectDirectoryName('  many   spaces  ', 'fallback')).toBe('many spaces')
    expect(sanitizeProjectDirectoryName('name...', 'fallback')).toBe('name')
    expect(sanitizeProjectDirectoryName('name. . ', 'fallback')).toBe('name')
  })

  it('bounds the length without splitting a surrogate pair', () => {
    const long = 'x'.repeat(100)
    expect(sanitizeProjectDirectoryName(long, 'fallback')).toHaveLength(80)
    const emoji = '🙂'.repeat(60)
    const bounded = sanitizeProjectDirectoryName(emoji, 'fallback')
    expect(bounded.length).toBeLessThanOrEqual(80)
    expect(() => new TextEncoder().encode(bounded)).not.toThrow()
  })

  it('backs the 80-unit cut off a split surrogate pair', () => {
    // 79 ASCII units followed by a two-unit emoji: the cut lands between
    // the pair's halves, so the boundary backs off to 79 units.
    const bounded = sanitizeProjectDirectoryName('x'.repeat(79) + '🙂', 'fallback')
    expect(bounded).toBe('x'.repeat(79))
    expect(() => new TextEncoder().encode(bounded)).not.toThrow()
  })

  it('guards Windows reserved device names', () => {
    expect(sanitizeProjectDirectoryName('con', 'fallback')).toBe('_con')
    expect(sanitizeProjectDirectoryName('COM1', 'fallback')).toBe('_COM1')
  })

  it('falls back when nothing survives, and refuses an empty fallback', () => {
    expect(sanitizeProjectDirectoryName('???', 'imported project')).toBe('imported project')
    expect(() => sanitizeProjectDirectoryName('???', '')).toThrow()
  })
})

describe('uniqueDirectoryName', () => {
  it('returns the base when free', () => {
    expect(uniqueDirectoryName(candidate => candidate !== 'taken', 'project')).toBe('project')
  })

  it('suffixes numeric alternatives and refuses after the budget', () => {
    const taken = new Set(['project', 'project (2)', 'project (3)'])
    const free = (candidate: string): boolean => !taken.has(candidate)
    expect(uniqueDirectoryName(free, 'project')).toBe('project (4)')
    const onlyLastFree = (candidate: string): boolean => candidate === 'project (100)'
    expect(uniqueDirectoryName(onlyLastFree, 'project')).toBe('project (100)')
    expect(() => uniqueDirectoryName(() => false, 'project')).toThrow(/numbered alternative/)
  })
})
