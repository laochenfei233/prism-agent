/** Wire records: what the routes may serve, and the addresses the panel asks for. */
import { describe, expect, it } from 'vitest'
import {
  GIT_DIFF_ROUTE, GIT_STAGE_PATH, GIT_STATUS_ROUTE, gitDiffUrl, gitStatusUrl, isGitDiff, isGitStatus,
} from '../src/contract.ts'

const ENTRY = { path: 'a.txt', index: ' ', worktree: 'M' }

describe('wire validators', () => {
  it('accepts a repository status and rejects every malformed field', () => {
    expect(isGitStatus({ available: true, repo: true, root: '/repo', branch: 'main', ahead: 1, behind: 0, entries: [ENTRY] })).toBe(true)
    expect(isGitStatus({ available: false, repo: false, entries: [] })).toBe(true)
    expect(isGitStatus({ available: true, repo: true, entries: [{ path: 'a', index: 'R', worktree: ' ', origPath: 'old' }] })).toBe(true)
    for (const value of [
      null, [], 'status', {},
      { available: 'yes', repo: true, entries: [] },
      { available: true, repo: 'no', entries: [] },
      { available: true, repo: true, root: '', entries: [] },
      { available: true, repo: true, branch: '', entries: [] },
      { available: true, repo: true, ahead: -1, entries: [] },
      { available: true, repo: true, behind: 1.5, entries: [] },
      { available: true, repo: true, entries: [{ path: '', index: ' ', worktree: 'M' }] },
      { available: true, repo: true, entries: [{ path: 'a', index: 'MM', worktree: 'M' }] },
      { available: true, repo: true, entries: [{ path: 'a', index: ' ', worktree: 'M', origPath: 1 }] },
      { available: true, repo: true, entries: 'nope' },
      { available: true, repo: true, entries: [1] },
    ]) expect(isGitStatus(value)).toBe(false)
  })

  it('accepts hunks, binary, and untracked comparisons and rejects malformed ones', () => {
    const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [' a'] }
    expect(isGitDiff({ kind: 'text', path: 'a.txt', hunks: [hunk] })).toBe(true)
    expect(isGitDiff({ kind: 'binary', path: 'a.bin' })).toBe(true)
    expect(isGitDiff({ kind: 'untracked', path: 'new.txt' })).toBe(true)
    for (const value of [
      null, [], {}, { kind: 'text', path: '', hunks: [] },
      { kind: 'text', path: 'a', hunks: [{ oldStart: -1, oldLines: 1, newStart: 1, newLines: 1, lines: [] }] },
      { kind: 'text', path: 'a', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['x'] }] },
      { kind: 'text', path: 'a', hunks: 'no' },
      { kind: 'text', path: 'a', hunks: [1] },
      { kind: 'other', path: 'a' },
    ]) expect(isGitDiff(value)).toBe(false)
  })
})

describe('route addresses', () => {
  it('builds document-relative addresses the fetch fence serves', () => {
    expect(gitStatusUrl('s-1' as never)).toBe(`${GIT_STATUS_ROUTE}?sessionId=s-1`)
    expect(gitDiffUrl('s-1' as never, 'src/a b.ts', 'index')).toBe(`${GIT_DIFF_ROUTE}?sessionId=s-1&path=src%2Fa+b.ts&side=index`)
    expect(GIT_STAGE_PATH.startsWith('/api/')).toBe(true)
  })
})
