import { afterEach, describe, expect, it, vi } from 'vitest'
import { CronRunner, CronServiceError } from '@deepseek-ai/dsh-cron'
import type { CronRunOutcome } from '@deepseek-ai/dsh-cron'
import { cronJob, memoryStore } from './fixtures.ts'

/** A run body that settles with the outcome the test names. */
function settles(outcome: CronRunOutcome) {
  return () => Promise.resolve(outcome)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('CronRunner', () => {
  it('records a completed run in the job history', async () => {
    const job = cronJob()
    const { store, rows } = memoryStore([job])
    const runner = new CronRunner({
      store: () => store,
      body: settles('completed'),
      maxRunsPerJob: 5,
      now: () => 7,
    })

    await expect(runner.run(job)).resolves.toEqual({ startedAt: 7, finishedAt: 7, outcome: 'completed' })
    expect(rows.get(job.id)?.recentRuns).toEqual([{ startedAt: 7, finishedAt: 7, outcome: 'completed' }])
  })

  it('records a rejecting run body as failed', async () => {
    const job = cronJob()
    const { store, rows } = memoryStore([job])
    const runner = new CronRunner({
      store: () => store,
      body: () => Promise.reject(new Error('delivery refused')),
      maxRunsPerJob: 5,
      now: () => 1,
    })

    await expect(runner.run(job)).resolves.toMatchObject({ outcome: 'failed' })
    expect(rows.get(job.id)?.recentRuns).toEqual([{ startedAt: 1, finishedAt: 1, outcome: 'failed' }])
  })

  it('records timeout and aborts the body once the ceiling passes', async () => {
    vi.useFakeTimers()
    const job = cronJob({ maxRunMs: 1_000 })
    const { store, rows } = memoryStore([job])
    let aborted = false
    const runner = new CronRunner({
      store: () => store,
      body: (_job, signal) => new Promise<CronRunOutcome>(() => {
        signal.addEventListener('abort', () => { aborted = true })
      }),
      maxRunsPerJob: 5,
      now: () => Date.now(),
    })

    const pending = runner.run(job)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).resolves.toMatchObject({ outcome: 'timeout' })
    expect(aborted).toBe(true)
    expect(rows.get(job.id)?.recentRuns).toHaveLength(1)
  })

  it('reports a run in flight until it settles', async () => {
    const job = cronJob()
    const { store } = memoryStore([job])
    const gate = Promise.withResolvers<CronRunOutcome>()
    const runner = new CronRunner({
      store: () => store,
      body: () => gate.promise,
      maxRunsPerJob: 5,
      now: () => 0,
    })

    const pending = runner.run(job)
    expect(runner.isRunning(job.id)).toBe(true)
    gate.resolve('completed')
    await pending
    expect(runner.isRunning(job.id)).toBe(false)
  })

  it('keeps only the newest runs the bound admits', async () => {
    const job = cronJob()
    const { store, rows } = memoryStore([job])
    let clock = 0
    const runner = new CronRunner({
      store: () => store,
      body: settles('completed'),
      maxRunsPerJob: 2,
      now: () => clock++,
    })

    for (let run = 0; run < 3; run += 1) await runner.run(job)
    expect(rows.get(job.id)?.recentRuns).toEqual([
      { startedAt: 2, finishedAt: 3, outcome: 'completed' },
      { startedAt: 4, finishedAt: 5, outcome: 'completed' },
    ])
  })

  it('appends to the job as stored now rather than as the run started', async () => {
    const job = cronJob()
    const { store, rows } = memoryStore([job])
    const runner = new CronRunner({
      store: () => store,
      body: async () => {
        await store.put({ ...job, prompt: 'edited while the run was in flight' })
        return 'completed'
      },
      maxRunsPerJob: 5,
      now: () => 0,
    })

    await runner.run(job)
    expect(rows.get(job.id)?.prompt).toBe('edited while the run was in flight')
    expect(rows.get(job.id)?.recentRuns).toHaveLength(1)
  })

  it('records a run whose job was removed while it was in flight', async () => {
    const job = cronJob()
    const { store, rows } = memoryStore([])
    const runner = new CronRunner({
      store: () => store,
      body: settles('completed'),
      maxRunsPerJob: 5,
      now: () => 0,
    })

    await runner.run(job)
    expect(rows.get(job.id)?.recentRuns).toHaveLength(1)
  })

  it('refuses to record a run after this process stopped leading', async () => {
    const job = cronJob()
    const { store } = memoryStore([job])
    let holding = true
    const runner = new CronRunner({
      store: () => (holding ? store : undefined),
      body: () => {
        holding = false
        return Promise.resolve<CronRunOutcome>('completed')
      },
      maxRunsPerJob: 5,
      now: () => 0,
    })

    await expect(runner.run(job)).rejects.toBeInstanceOf(CronServiceError)
    await expect(runner.run(job)).rejects.toMatchObject({ code: 'cron_not_leader' })
  })
})
