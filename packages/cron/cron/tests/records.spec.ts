import { describe, expect, it } from 'vitest'
import { CronRecordError, decodeStoredCronJob } from '@deepseek-ai/dsh-cron'

/** One valid stored job; each case below changes exactly one thing about it. */
function storedJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'cron-1',
    expression: '0 9 * * 1-5',
    timeZone: 'Asia/Shanghai',
    enabled: true,
    target: {
      kind: 'new-session',
      workspacePath: '/work/repo',
      agentPreset: 'default',
      permissionPreset: 'read-only',
    },
    prompt: 'Report the overnight build.',
    overlapPolicy: 'skip',
    misfirePolicy: 'run-once-late',
    maxRunMs: 600_000,
    createdAt: 1_000,
    updatedAt: 2_000,
    nextDueAt: 1_800_000_000_000,
    recentRuns: [{ startedAt: 1_500, finishedAt: 1_600, outcome: 'completed' }],
    ...overrides,
  }
}

describe('decodeStoredCronJob', () => {
  it('admits a well-formed record and brands its identity', () => {
    const job = decodeStoredCronJob(storedJob())
    expect(job.id).toBe('cron-1')
    expect(job.target).toMatchObject({ kind: 'new-session', permissionPreset: 'read-only' })
    expect(job.recentRuns).toHaveLength(1)
  })

  it('admits a session target and an empty run history', () => {
    const job = decodeStoredCronJob(storedJob({
      target: { kind: 'session', sessionId: 'session-7' },
      recentRuns: [],
    }))
    expect(job.target).toMatchObject({ kind: 'session', sessionId: 'session-7' })
    expect(job.recentRuns).toEqual([])
  })

  it('refuses an unknown key, an unknown version, and an unknown union member', () => {
    const cases: readonly Record<string, unknown>[] = [
      storedJob({ surprise: true }),
      storedJob({ version: 2 }),
      storedJob({ finalSay: 'yes' }),
      storedJob({ target: { kind: 'shell', command: 'rm -rf /' } }),
      storedJob({ overlapPolicy: 'parallel' }),
      storedJob({ misfirePolicy: 'replay-all' }),
      storedJob({ recentRuns: [{ startedAt: 1, finishedAt: 2, outcome: 'exploded' }] }),
      storedJob({ target: { kind: 'session', sessionId: 's' , extra: 1 } }),
    ]
    for (const value of cases) expect(() => decodeStoredCronJob(value), JSON.stringify(value)).toThrow(CronRecordError)
  })

  it('refuses a record whose text no longer means anything', () => {
    expect(() => decodeStoredCronJob(storedJob({ expression: 'not a cron' })))
      .toThrow(/no longer parses/)
    expect(() => decodeStoredCronJob(storedJob({ timeZone: 'Not/A_Zone' })))
      .toThrow(/IANA zone/)
  })

  it('refuses a record whose instants contradict each other', () => {
    expect(() => decodeStoredCronJob(storedJob({ updatedAt: 999 })))
      .toThrow(/updated before it was created/)
    // Instant 0 is 1970, which is inside the four-digit-year range the vocabulary
    // represents; only a value past its upper bound is out of range.
    expect(() => decodeStoredCronJob(storedJob({ nextDueAt: Date.parse('9999-12-31T23:59:59.999Z') + 1 })))
      .toThrow(/outside the representable range/)
    expect(() => decodeStoredCronJob(storedJob({
      recentRuns: [
        { startedAt: 900, finishedAt: 950, outcome: 'completed' },
        { startedAt: 100, finishedAt: 150, outcome: 'completed' },
      ],
    }))).toThrow(/not in ascending order/)
    expect(() => decodeStoredCronJob(storedJob({
      recentRuns: [{ startedAt: 900, finishedAt: 800, outcome: 'completed' }],
    }))).toThrow(/finished before it started/)
  })

  it('refuses a ceiling that is not a positive whole number', () => {
    expect(() => decodeStoredCronJob(storedJob({ maxRunMs: 0 }))).toThrow(CronRecordError)
    expect(() => decodeStoredCronJob(storedJob({ maxRunMs: -1 }))).toThrow(CronRecordError)
    expect(() => decodeStoredCronJob(storedJob({ maxRunMs: 1.5 }))).toThrow(CronRecordError)
    expect(() => decodeStoredCronJob(storedJob({ enabled: 'yes' }))).toThrow(CronRecordError)
    expect(() => decodeStoredCronJob(storedJob({ prompt: '' }))).toThrow(CronRecordError)
  })
})
