import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CronProvider, CronRunner, CronService, CronServiceError } from '@deepseek-ai/dsh-cron'
import type { CronJob, CronJobId, CronRunOutcome } from '@deepseek-ai/dsh-cron'
import { cronJob, memoryStore } from './fixtures.ts'

const ANY_ID = brandString<CronJobId>('cron-9')

/** One cron job's stored fields a request can state. */
const REQUEST = {
  expression: '0 9 * * *',
  timeZone: 'UTC',
  target: { kind: 'session', sessionId: 'session-1' },
  prompt: 'check the build',
} as const

/** Everything one provider under test needs beyond its store. */
interface Harness {
  readonly provider: CronProvider
  readonly rows: Map<CronJobId, CronJob>
}

/**
 * Build a provider over an in-memory store at a fixed instant.
 * @param initial - the rows the store opens with.
 * @param now - the wall-clock sample the provider uses, defaulting to the epoch.
 * @param body - the run body, defaulting to one that settles `completed`.
 * @returns the provider and the rows behind it.
 */
function harness(
  initial: readonly CronJob[] = [],
  now = 0,
  body: (job: CronJob, signal: AbortSignal) => Promise<CronRunOutcome> = () => Promise.resolve('completed'),
): Harness {
  const { store, rows } = memoryStore(initial)
  const ctx = new Context()
  const provider = new CronProvider(ctx, {
    store: () => store,
    runner: new CronRunner({ store: () => store, body, maxRunsPerJob: 5, now: () => now }),
    now: () => now,
    defaultMaxRunMs: 60_000,
  })
  return { provider, rows }
}

/** The refusal code one call reports. */
async function refusalOf(call: () => unknown): Promise<string> {
  try {
    await call()
  } catch (error: unknown) {
    if (error instanceof CronServiceError) return error.code
    throw error
  }
  throw new Error('the call was expected to be refused')
}

describe('CronProvider management', () => {
  it('answers every verb with cron_not_leader while this process leads none', async () => {
    const ctx = new Context()
    const provider = new CronProvider(ctx, {
      store: () => undefined,
      runner: new CronRunner({ store: () => undefined, body: () => Promise.resolve('completed'), maxRunsPerJob: 5, now: () => 0 }),
      now: () => 0,
      defaultMaxRunMs: 60_000,
    })

    expect(provider).toBeInstanceOf(CronService)
    expect(ctx.get('cron')).toBeDefined()
    for (const call of [
      () => provider.list(),
      () => provider.get(ANY_ID),
      () => provider.create({ ...REQUEST }),
      () => provider.update(ANY_ID, { prompt: 'later' }),
      () => provider.remove(ANY_ID),
      () => provider.runNow(ANY_ID),
    ]) {
      expect(await refusalOf(call)).toBe('cron_not_leader')
    }
  })

  it('lists and reads the stored jobs', async () => {
    const job = cronJob()
    const { provider } = harness([job])
    expect(provider.list()).toEqual([job])
    expect(provider.get(job.id)).toEqual(job)
    expect(provider.get(ANY_ID)).toBeUndefined()
  })

  it('creates a job with the policies, ceiling, and occurrence it must state itself', async () => {
    const { provider, rows } = harness()
    const job = await provider.create({ ...REQUEST })

    expect(job).toMatchObject({
      version: 1,
      id: 'cron-1',
      expression: '0 9 * * *',
      timeZone: 'UTC',
      enabled: true,
      overlapPolicy: 'skip',
      misfirePolicy: 'skip',
      maxRunMs: 60_000,
      createdAt: 0,
      updatedAt: 0,
      nextDueAt: 32_400_000,
      recentRuns: [],
    })
    expect(rows.get(job.id)).toEqual(job)
  })

  it('keeps the policies and ceiling a request states', async () => {
    const { provider } = harness()
    const job = await provider.create({
      ...REQUEST,
      overlapPolicy: 'queue-one',
      misfirePolicy: 'run-once-late',
      maxRunMs: 2_500,
    })
    expect(job).toMatchObject({ overlapPolicy: 'queue-one', misfirePolicy: 'run-once-late', maxRunMs: 2_500 })
  })

  it('stores the canonical spelling of the zone', async () => {
    const { provider } = harness()
    const job = await provider.create({ ...REQUEST, timeZone: 'US/Eastern' })
    expect(job.timeZone).toBe('America/New_York')
  })

  it('refuses an expression the grammar cannot read', async () => {
    const { provider } = harness()
    await expect(provider.create({ ...REQUEST, expression: '0 25 * * *' })).rejects.toMatchObject({
      code: 'cron_invalid_expression',
    })
  })

  it('refuses a rule that fires nowhere within the search bound', async () => {
    const { provider } = harness()
    await expect(provider.create({ ...REQUEST, expression: '0 0 30 2 *' })).rejects.toMatchObject({
      code: 'cron_invalid_expression',
    })
  })

  it('refuses a zone this platform does not resolve', async () => {
    const { provider } = harness()
    await expect(provider.create({ ...REQUEST, timeZone: 'Mars/Olympus' })).rejects.toMatchObject({
      code: 'cron_invalid_time_zone',
    })
  })

  it('replaces the fields an update states and stamps the change', async () => {
    const job = cronJob()
    const { provider, rows } = harness([job], 5_000)
    const updated = await provider.update(job.id, {
      prompt: 'recheck',
      enabled: false,
      target: { kind: 'new-session', workspacePath: '/work', agentPreset: 'default', permissionPreset: 'read-only' },
      overlapPolicy: 'queue-one',
      misfirePolicy: 'run-once-late',
      maxRunMs: 4_000,
    })

    expect(updated).toEqual({
      ...job,
      prompt: 'recheck',
      enabled: false,
      target: { kind: 'new-session', workspacePath: '/work', agentPreset: 'default', permissionPreset: 'read-only' },
      overlapPolicy: 'queue-one',
      misfirePolicy: 'run-once-late',
      maxRunMs: 4_000,
      updatedAt: 5_000,
    })
    expect(rows.get(job.id)).toEqual(updated)
  })

  it('leaves the next occurrence alone when only the other fields change', async () => {
    const job = cronJob()
    const { provider } = harness([job], 5_000)
    const updated = await provider.update(job.id, { prompt: 'recheck' })
    expect(updated.nextDueAt).toBe(job.nextDueAt)
  })

  it('recomputes the next occurrence when the rule changes', async () => {
    const job = cronJob()
    const { provider } = harness([job], 5_000)
    const noon = await provider.update(job.id, { expression: '0 12 * * *' })
    expect(noon.nextDueAt).toBe(43_200_000)
    // The same wall time in a zone eight hours ahead is eight hours earlier in UTC.
    const zoned = await provider.update(job.id, { timeZone: 'Asia/Shanghai' })
    expect(zoned.nextDueAt).toBe(noon.nextDueAt - 8 * 3_600_000)
  })

  it('refuses an update for a job this domain does not hold', async () => {
    const { provider } = harness()
    await expect(provider.update(ANY_ID, { prompt: 'later' })).rejects.toMatchObject({ code: 'cron_not_found' })
  })

  it('removes a job and reports whether it existed', async () => {
    const job = cronJob()
    const { provider, rows } = harness([job])
    await expect(provider.remove(job.id)).resolves.toBe(true)
    expect(rows.size).toBe(0)
    await expect(provider.remove(job.id)).resolves.toBe(false)
  })
})

describe('CronProvider runs', () => {
  it('runs a job now and records the run', async () => {
    const job = cronJob()
    const { provider, rows } = harness([job], 1_000)
    await expect(provider.runNow(job.id)).resolves.toEqual({ startedAt: 1_000, finishedAt: 1_000, outcome: 'completed' })
    expect(rows.get(job.id)?.recentRuns).toEqual([{ startedAt: 1_000, finishedAt: 1_000, outcome: 'completed' }])
    // Running now must not move the schedule.
    expect(rows.get(job.id)?.nextDueAt).toBe(job.nextDueAt)
  })

  it('refuses runNow for a job this domain does not hold', async () => {
    const { provider } = harness()
    await expect(provider.runNow(ANY_ID)).rejects.toMatchObject({ code: 'cron_not_found' })
  })

  it('refuses runNow while that job already runs', async () => {
    const job = cronJob()
    const gate = Promise.withResolvers<CronRunOutcome>()
    const { provider } = harness([job], 0, () => gate.promise)

    const pending = provider.runNow(job.id)
    await expect(provider.runNow(job.id)).rejects.toMatchObject({ code: 'cron_run_in_progress' })
    gate.resolve('completed')
    await expect(pending).resolves.toMatchObject({ outcome: 'completed' })
  })
})
