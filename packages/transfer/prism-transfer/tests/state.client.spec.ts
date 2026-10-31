import { describe, expect, it } from 'vitest'
import { en } from '../src/client/locales.ts'
import { exportSkippedNotices, failureOf, formatBytes, phaseKeyOf, snapshotOf } from '../src/client/state.ts'

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
      finishedAt: 6,
    })
    expect(snapshot).toMatchObject({
      jobId: 'j1',
      kind: 'unknown',
      state: 'running',
      phase: 'restoring',
      duplicates: 1,
      startedAt: 5,
      finishedAt: 6,
    })
    expect(snapshot?.result).toBeUndefined()
    expect(snapshot?.error).toBeUndefined()
  })

  it('answers undefined for idle, foreign, and malformed bodies', () => {
    expect(snapshotOf({ state: 'idle' })).toBeUndefined()
    expect(snapshotOf({ jobId: 'j', state: 'idle' })).toBeUndefined()
    expect(snapshotOf({ jobId: 'j', state: 'nope' })).toBeUndefined()
    expect(snapshotOf('text')).toBeUndefined()
    expect(snapshotOf(undefined)).toBeUndefined()
    expect(snapshotOf(['j'])).toBeUndefined()
  })

  it('defaults every typed field a foreign body omits', () => {
    const snapshot = snapshotOf({ jobId: 'j4', state: 'running', phase: 'somewhere-new', startedAt: 'nope' })
    expect(snapshot).toEqual({
      jobId: 'j4',
      kind: 'unknown',
      state: 'running',
      phase: 'validating',
      name: '',
      archiveBytes: 0,
      files: 0,
      bytes: 0,
      sessionsDone: 0,
      sessionsTotal: 0,
      projectsDone: 0,
      projectsTotal: 0,
      duplicates: 0,
      startedAt: 0,
    })
  })

  it('keeps only recognizable result entries and settings outcomes', () => {
    const snapshot = snapshotOf({
      jobId: 'j5',
      state: 'done',
      result: {
        projects: [
          'junk',
          { name: 'A', path: '/a', sessions: 'nope', duplicates: 'nope', registerError: 'registration refused' },
          { name: 'B', path: '/b' },
        ],
        settings: [
          'junk',
          { outcome: 'applied' },
          { ns: 'web', outcome: 'weird' },
          { ns: 'web', outcome: 'failed', reason: 'nope' },
        ],
      },
    })
    expect(snapshot?.result?.projects).toEqual([
      { name: 'A', path: '/a', sessions: 0, duplicates: 0, registerError: 'registration refused' },
      { name: 'B', path: '/b', sessions: 0, duplicates: 0 },
    ])
    expect(snapshot?.result?.settings).toEqual([{ ns: 'web', outcome: 'failed', reason: 'nope' }])
  })

  it('answers undefined for result blocks without a project array and settings arrays without entries', () => {
    const withoutProjects = snapshotOf({ jobId: 'j6', state: 'done', result: { projects: 'nope' } })
    expect(withoutProjects?.result).toBeUndefined()
    const withoutSettings = snapshotOf({
      jobId: 'j7',
      state: 'done',
      result: { projects: [{ name: 'A', path: '/a' }] },
    })
    expect(withoutSettings?.result?.settings).toBeUndefined()
  })

  it('defaults the error detail when the body omits it', () => {
    const snapshot = snapshotOf({ jobId: 'j8', state: 'failed', error: { code: 'crc-mismatch' } })
    expect(snapshot?.error).toEqual({ code: 'crc-mismatch', detail: '' })
    expect(snapshotOf({ jobId: 'j9', state: 'failed', error: 'plain text' })?.error).toBeUndefined()
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
    expect(phaseKeyOf('restoring')).toBe('phaseRestoring')
    expect(phaseKeyOf('applying-settings')).toBe('phaseApplyingSettings')
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
    expect(failureOf({ code: 'busy', message: 7 })).toEqual({ code: 'busy', message: '' })
  })
})

describe('exportSkippedNotices', () => {
  const t = (key: 'exportSkipped' | 'exportSecretsSkipped', params: Record<string, string>): string => {
    let out: string = en[key]
    for (const [name, value] of Object.entries(params)) out = out.replaceAll(`{${name}}`, value)
    return out
  }

  it('joins the skip counts and answers null when nothing to report', () => {
    expect(exportSkippedNotices({ skippedLinks: 2, skippedUnreadable: 1, skippedSecrets: 3 }, t))
      .toBe('Skipped 2 links and 1 unreadable files. 3 secret fields were not exported.')
    expect(exportSkippedNotices({ skippedLinks: 0, skippedUnreadable: 0, skippedSecrets: 0 }, t)).toBeNull()
  })

  it('treats non-number fields as zero and foreign bodies as nothing', () => {
    expect(exportSkippedNotices({ skippedLinks: '2', skippedUnreadable: null, skippedSecrets: true }, t)).toBeNull()
    expect(exportSkippedNotices('nope', t)).toBeNull()
    expect(exportSkippedNotices(undefined, t)).toBeNull()
  })
})

describe('formatBytes', () => {
  it('formats bytes, KiB, and MiB without trailing noise', () => {
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(2048)).toBe('2.0 KiB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB')
    expect(formatBytes(3 * 1024 ** 3 + 500 * 1024 ** 2)).toBe('3.5 GiB')
  })

  it('rounds hundred-scale units instead of decimals', () => {
    expect(formatBytes(200 * 1024)).toBe('200 KiB')
    expect(formatBytes(200 * 1024 * 1024)).toBe('200 MiB')
    expect(formatBytes(150 * 1024 ** 3)).toBe('150 GiB')
  })
})
