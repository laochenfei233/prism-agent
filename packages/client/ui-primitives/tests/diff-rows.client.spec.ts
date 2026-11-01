import { describe, expect, it } from 'vitest'
import { hunkRows } from '../src/diff-rows.ts'

describe('hunkRows', () => {
  it('numbers context on both sides, deletions on the old side, and additions on the new side', () => {
    expect(hunkRows({
      oldStart: 1,
      newStart: 1,
      lines: [' a', '-b', '+B', '+c', ' d'],
    })).toEqual([
      { kind: 'context', old: 1, new: 1, text: 'a' },
      { kind: 'del', old: 2, new: undefined, text: 'b' },
      { kind: 'add', old: undefined, new: 2, text: 'B' },
      { kind: 'add', old: undefined, new: 3, text: 'c' },
      { kind: 'context', old: 3, new: 4, text: 'd' },
    ])
  })

  it('starts each side at the hunk header it is given', () => {
    expect(hunkRows({ oldStart: 40, newStart: 52, lines: [' same', '-gone'] })).toEqual([
      { kind: 'context', old: 40, new: 52, text: 'same' },
      { kind: 'del', old: 41, new: undefined, text: 'gone' },
    ])
  })
})
