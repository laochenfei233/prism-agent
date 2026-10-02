import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CronRunner, CronRuntime } from '@deepseek-ai/dsh-cron'
import type { CronJob, CronJobId, CronRunBody, CronRunOutcome } from '@deepseek-ai/dsh-cron'
import { cronJob, memoryStore } from './fixtures.ts'
import type { StoreFaults } from './fixtures.ts'

/** One hour in milliseconds: every rule here fires on an hour boundary. */
const HOUR = 3_600_000

/** A run body that settles with the outcome the test names. */
function settles(outcome: CronRunOutcome): CronRunBody {
  return () => Promise.resolve(outcome)
}

/** The runtime under test plus everything a spec drives it with. */
interface RuntimeHarness {
  readonly runtime: CronRuntime
  readonly rows: Map<CronJobId, CronJob>
  readonly warnings: string[]
  /** Set the wall clock both the runtime and the runner sample. */
  setNow(value: number): void
  /** Replace the run body, for a spec that decides its behaviour after construction. */
  setBody(value: CronRunBody): void
  /** Whether the store source still reports a store this process leads. */
  live: boolean
  /**
   * Move the wall clock to `to`, then let every timer armed for it fire.
   * @param to - the instant to move to.
   */
  advanceTo(to: number): Promise<void>
}

/**
 * Build a runtime and its runner over an in-memory store.
 * @param initial - the rows the store opens with.
 * @param body - the run body, defaulting to one that settles `completed`.
 * @param faults - an object a spec fills in later to fail one write.
 * @returns the harness.
 */
function runtimeHarness(
  initial: readonly CronJob[] = [],
  body: CronRunBody = settles('completed'),
  faults: StoreFaults = {},
): RuntimeHarness {
  const { store, rows } = memoryStore(initial, faults)
  const clock = { now: 0 }
  const state = { live: true }
  const warnings: string[] = []
  const held = (): ReturnType<typeof memoryStore>['store'] | undefined => (state.live ? store : undefined)
  const runBody = { current: body }
  const runner = new CronRunner({
    store: held,
    body: (job, signal) => runBody.current(job, signal),
    maxRunsPerJob: 5,
    now: () => clock.now,
  })
  const runtime = new CronRuntime({ store: held, runner, now: () => clock.now, warn: (message) => { warnings.push(message) } })
  return {
    runtime,
    rows,
    warnings,
    setNow: (value) => { clock.now = value },
    setBody: (value) => { runBody.current = value },
    get live() { return state.live },
    set live(value: boolean) { state.live = value },
    advanceTo: async (to) => {
      // Let a drive still in flight arm its timer before the clock moves.
      await vi.advanceTimersByTimeAsync(0)
      const elapsed = Math.max(to - clock.now, 0)
      clock.now = to
      await vi.advanceTimersByTimeAsync(elapsed)
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('CronRuntime', () => {
  it('fires a due job and advances its stored occurrence', async () => {
    vi.useFakeTimers()
    const job = cronJob({ expression: '0 * * * *', nextDueAt: HOUR })
    const harness = runtimeHarness([job])

    harness.runtime.start()
    await harness.advanceTo(HOUR)

    expect(harness.rows.get(job.id)?.recentRuns).toEqual([expect.objectContaining({ outcome: 'completed' })])
    expect(harness.rows.get(job.id)?.nextDueAt).toBe(2 * HOUR)
  })

  it('waits for the stored occurrence instead of firing early', async () => {
    vi.useFakeTimers()
    const job = cronJob({ expression: '0 * * * *', nextDueAt: HOUR })
    const harness = runtimeHarness([job])

    harness.runtime.start()
    await harness.advanceTo(HOUR - 1)
    expect(harness.rows.get(job.id)?.recentRuns).toHaveLength(0)
    await harness.advanceTo(HOUR)
    expect(harness.rows.get(job.id)?.recentRuns).toHaveLength(1)
  })

  it('arms one timer for the earliest occurrence any enabled job owes', async () => {
    vi.useFakeTimers()
    const far = cronJob({ id: brandString<CronJobId>('cron-far'), expression: '0 * * * *', nextDueAt: 2 * HOUR })
    const near = cronJob({ id: brandString<CronJobId>('cron-near'), expression: '0 * * * *', nextDueAt: HOUR })
    const harness = runtimeHarness([far, near])

    harness.runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    await harness.advanceTo(HOUR)

    expect(harness.rows.get(near.id)?.recentRuns).toHaveLength(1)
    expect(harness.rows.get(far.id)?.recentRuns).toHaveLength(0)
  })

  it('skips an occurrence that passed while no scheduler ran under misfirePolicy skip', async () => {
    vi.useFakeTimers()
    const job = cronJob({ expression: '0 * * * *', nextDueAt: HOUR, misfirePolicy: 'skip' })
    const harness = runtimeHarness([job])

    harness.setNow(10 * HOUR)
    harness.runtime.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.rows.get(job.id)?.recentRuns).toHaveLength(0)
    expect(harness.rows.get(job.id)?.nextDueAt).toBe(11 * HOUR)
  })

  it('runs one late occurrence under misfirePolicy run-once-late', async () => {
    vi.useFakeTimers()
    const job = cronJob({ expression: '0 * * * *', nextDueAt: HOUR, misfirePolicy: 'run-once-late' })
    const harness = runtimeHarness([job])

    harness.setNow(10 * HOUR)
    harness.runtime.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.rows.get(job.id)?.recentRuns).toHaveLength(1)
    expect(harness.rows.get(job.id)?.nextDueAt).toBe(11 * HOUR)
  })

  it('coalesces a wake that arrives after several occurrences into one run', async () => {
    vi.useFakeTimers()
    const job = cronJob({ expression: '0 * * * *', nextDueAt: HOUR })
    const harness = runtimeHarness([job])

    harness.runtime.start()
    await harness.advanceTo(10 * HOUR)

    expect(harness.rows.get(job.id)?.recentRuns).toHaveLength(1)
    expect(harness.rows.get(job.id)?.nextDueAt).toBe(11 * HOUR)
  })

  it('drops a due occurrence while the same job still runs under overlapPolicy skip', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<CronRunOutcome>()
    const job = cronJob({ expression: '0 * * * *', nextDueAt: HOUR, overlapPolicy: 'skip', maxRunMs: 100_000_000 })
    const harness = runtimeHarness([job], () => gate.promise)

    harness.runtime.start()
    await harness.advanceTo(HOUR)
    await harness.advanceTo(2 * HOUR)
    expect(harness.rows.get(job.id)?.recentRuns).toHaveLength(0)
    expect(harness.rows.get(job.id)?.nextDueAt).toBe(3 * HOUR)

    gate.resolve('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.rows.get(job.id)?.recentRuns).toHaveLength(1)
  })

  it('starts exactly one held occurrence under overlapPolicy queue-one', async () => {
    vi.useFakeTimers()
    const gates = [Promise.withResolvers<CronRunOutcome>(), Promise.withResolvers<CronRunOutcome>()]
    let started = 0
    const job = cronJob({ expression: '0 * * * *', nextDueAt: HOUR, overlapPolicy: 'queue-one', maxRunMs: 100_000_000 })
    const harness = runtimeHarness([job], () => gates[started++]!.promise)

    harness.runtime.start()
    await harness.advanceTo(HOUR)
    await harness.advanceTo(2 * HOUR)
    await harness.advanceTo(3 * HOUR)
    expect(started).toBe(1)

    gates[0]!.resolve('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toBe(2)

    gates[1]!.resolve('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toBe(2)
    expect(harness.rows.get(job.id)?.recentRuns).toHaveLength(2)
  })

  it('drops a held occurrence when the runtime was disposed first', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<CronRunOutcome>()
    const job = cronJob({ expression: '0 * * * *', nextDueAt: HOUR, overlapPolicy: 'queue-one', maxRunMs: 100_000_000 })
    const harness = runtimeHarness([job], () => gate.promise)

    harness.runtime.start()
    await harness.advanceTo(HOUR)
    await harness.advanceTo(2 * HOUR)
    await harness.runtime.dispose()

    gate.resolve('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.rows.get(job.id)?.recentRuns).toHaveLength(1)
  })

  it('drops a held occurrence when this process no longer leads', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<CronRunOutcome>()
    const job = cronJob({ expression: '0 * * * *', nextDueAt: HOUR, overlapPolicy: 'queue-one', maxRunMs: 100_000_000 })
    const harness = runtimeHarness([job], () => gate.promise)

    harness.runtime.start()
    await harness.advanceTo(HOUR)
    await harness.advanceTo(2 * HOUR)
    harness.live = false

    gate.resolve('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.warnings).toEqual([expect.stringContaining('recording the run')])
  })

  it('drops a held occurrence whose job was removed while it waited', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<CronRunOutcome>()
    const faults: StoreFaults = {}
    const job = cronJob({ expression: '0 * * * *', nextDueAt: HOUR, overlapPolicy: 'queue-one', maxRunMs: 100_000_000 })
    const harness = runtimeHarness([job], () => gate.promise, faults)

    harness.runtime.start()
    await harness.advanceTo(HOUR)
    await harness.advanceTo(2 * HOUR)
    faults.put = (value: CronJob, rows: Map<CronJobId, CronJob>) => {
      if (value.recentRuns.length === 0) return
      // The job goes away as the run holding its occurrence settles.
      rows.delete(job.id)
      throw new Error('the job was removed mid-run')
    }

    gate.resolve('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.warnings).toEqual([expect.stringContaining('recording the run')])
    expect(harness.rows.has(job.id)).toBe(false)
  })

  it('does not advance a job that was removed while the drive dispatched it', async () => {
    vi.useFakeTimers()
    const job = cronJob({ expression: '0 * * * *', nextDueAt: 0, misfirePolicy: 'run-once-late' })
    const harness = runtimeHarness([job])
    harness.setBody(() => {
      // The run body is entered synchronously, before the drive reads the row
      // back to advance it.
      harness.rows.delete(job.id)
      return Promise.resolve<CronRunOutcome>('completed')
    })

    harness.runtime.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.rows.get(job.id)?.nextDueAt).toBe(0)
  })

  it('reports a job whose expression this build cannot read', async () => {
    vi.useFakeTimers()
    const job = cronJob({ expression: 'every other tuesday', nextDueAt: 0 })
    const harness = runtimeHarness([job])

    harness.setNow(HOUR)
    harness.runtime.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.rows.get(job.id)?.recentRuns).toHaveLength(0)
    expect(harness.warnings).toEqual([expect.stringContaining('cannot be scheduled')])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a job whose zone this platform does not resolve', async () => {
    vi.useFakeTimers()
    const job = cronJob({ expression: '0 * * * *', timeZone: 'Mars/Olympus', nextDueAt: 0 })
    const harness = runtimeHarness([job])

    harness.setNow(HOUR)
    harness.runtime.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.rows.get(job.id)?.recentRuns).toHaveLength(0)
    expect(harness.warnings).toEqual([expect.stringContaining('cannot be scheduled')])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a rule that fires nowhere within the search bound', async () => {
    vi.useFakeTimers()
    const job = cronJob({ expression: '0 0 30 2 *', nextDueAt: 0 })
    const harness = runtimeHarness([job])

    harness.setNow(HOUR)
    harness.runtime.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.rows.get(job.id)?.recentRuns).toHaveLength(0)
    expect(harness.warnings).toEqual([expect.stringContaining('no occurrence')])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a failed occurrence write and retries at the next occurrence', async () => {
    vi.useFakeTimers()
    const job = cronJob({ expression: '0 * * * *', nextDueAt: HOUR })
    const harness = runtimeHarness([job], settles('completed'), {
      put: (value) => {
        if (value.recentRuns.length === 0) throw new Error('the medium is unavailable')
      },
    })

    harness.runtime.start()
    await harness.advanceTo(HOUR)

    expect(harness.warnings).toEqual([expect.stringContaining('settling job')])
    // The runtime armed the next occurrence rather than a zero delay, so a
    // failed write cannot spin the timer.
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.warnings).toHaveLength(1)
  })

  it('reports a run whose record could not be written', async () => {
    vi.useFakeTimers()
    const job = cronJob({ expression: '0 * * * *', nextDueAt: HOUR })
    const harness = runtimeHarness([job], settles('completed'), {
      put: (value) => {
        if (value.recentRuns.length > 0) throw new Error('the medium is unavailable')
      },
    })

    harness.runtime.start()
    await harness.advanceTo(HOUR)

    expect(harness.warnings).toEqual([expect.stringContaining('recording the run')])
    expect(harness.rows.get(job.id)?.nextDueAt).toBe(2 * HOUR)
  })

  it('drives nothing while this process leads no store', async () => {
    vi.useFakeTimers()
    const harness = runtimeHarness([cronJob({ nextDueAt: 0 })])
    harness.live = false

    harness.runtime.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(vi.getTimerCount()).toBe(0)
    expect(harness.warnings).toEqual([])
  })

  it('arms nothing while no enabled job owes an occurrence', async () => {
    vi.useFakeTimers()
    const job = cronJob({ enabled: false, nextDueAt: 0 })
    const harness = runtimeHarness([job])

    harness.runtime.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(vi.getTimerCount()).toBe(0)
    expect(harness.rows.get(job.id)?.recentRuns).toHaveLength(0)
  })

  it('stops before arming when disposal lands during a drive, and then stays stopped', async () => {
    vi.useFakeTimers()
    const job = cronJob({ expression: '0 * * * *', nextDueAt: 0 })
    const harness = runtimeHarness([job])

    harness.runtime.start()
    // A request that lands while the drive is suspended on its own write is
    // coalesced into that drive instead of starting a second one.
    harness.runtime.start()
    await harness.runtime.dispose()
    await harness.runtime.dispose()

    expect(vi.getTimerCount()).toBe(0)
    harness.runtime.start()
    await harness.advanceTo(HOUR)
    expect(vi.getTimerCount()).toBe(0)
    expect(harness.rows.get(job.id)?.recentRuns).toHaveLength(0)
  })

  it('cancels an armed timer on disposal', async () => {
    vi.useFakeTimers()
    const job = cronJob({ expression: '0 * * * *', nextDueAt: HOUR })
    const harness = runtimeHarness([job])

    harness.runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)

    await harness.runtime.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
