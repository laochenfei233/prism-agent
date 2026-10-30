import { describe, expect, it } from 'vitest'
import { failureOf, formatBytes, phaseKeyOf, snapshotOf } from '../src/client/state.ts'

describe('snapshotOf', () => {
  it('parses a running snapshot and defaults unknown kinds', () => {
    const snapshot = snapshotOf({
      jobId: 'j1',
      kind: 'weird',
      state: 'running',
      phase: 'restoring',
      name: 'a.zip',
      archiveBytes: 10,
      files: 2,
      bytes: 200,
      sessionsDone: 1,
      sessionsTotal: 3,
      projectsDone: 0,
      projectsTotal: 1,
      duplicates: 1,
      startedAt: 5,
    })
    expect(snapshot).toMatchObject({
      jobId: 'j1',
      kind: 'unknown',
      state: 'running',
      phase: 'restoring',
      duplicates: 1,
    })
    expect(snapshot?.result).toBeUndefined()
    expect(snapshot?.error).toBeUndefined()
  })

  it('answers undefined for idle, foreign, and malformed bodies', () => {
    expect(snapshotOf({ state: 'idle' })).toBeUndefined()
    expect(snapshotOf({ jobId: 'j', state: 'nope' })).toBeUndefined()
    expect(snapshotOf('text')).toBeUndefined()
    expect(snapshotOf(undefined)).toBeUndefined()
  })

  it('parses the result and error blocks', () => {
    const snapshot = snapshotOf({
      jobId: 'j2',
      kind: 'combined',
      state: 'failed',
      phase: 'restoring',
      name: 'a.zip',
      startedAt: 1,
      result: { projects: [{ name: 'A', path: '/a', sessions: 2, duplicates: 1 }] },
      error: { code: 'crc-mismatch', detail: 'bad entry' },
    })
    expect(snapshot?.result?.projects).toEqual([{ name: 'A', path: '/a', sessions: 2, duplicates: 1 }])
    expect(snapshot?.error).toEqual({ code: 'crc-mismatch', detail: 'bad entry' })
    const withSettings = snapshotOf({
      jobId: 'j3',
      kind: 'combined',
      state: 'done',
      phase: 'done',
      startedAt: 1,
      result: {
        projects: [],
        settings: [
          { ns: 'web', outcome: 'applied' },
          { ns: 'gone', outcome: 'skipped' },
          { ns: 'bad', outcome: 'failed', reason: 'nope' },
        ],
      },
    })
    expect(withSettings?.result?.settings).toHaveLength(3)
  })

  it('keeps only the recognized phases', () => {
    expect(phaseKeyOf('validating')).toBe('phaseValidating')
    expect(phaseKeyOf('extracting')).toBe('phaseExtracting')
    expect(phaseKeyOf('registering')).toBe('phaseRegistering')
    expect(phaseKeyOf('done')).toBe('phaseValidating')
  })
})

describe('failureOf', () => {
  it('reads code and message from a failure body and refuses the rest', () => {
    expect(failureOf({ code: 'busy', message: 'another import is running' })).toEqual({
      code: 'busy',
      message: 'another import is running',
    })
    expect(failureOf({ message: 'no code' })).toBeUndefined()
    expect(failureOf(null)).toBeUndefined()
  })
})

describe('formatBytes', () => {
  it('formats bytes, KiB, and MiB without trailing noise', () => {
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(2048)).toBe('2.0 KiB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB')
    expect(formatBytes(3 * 1024 ** 3 + 500 * 1024 ** 2)).toBe('3.5 GiB')
  })
})
