import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { CronLeadership, CronOwnership, CronStore, LEADER_LOCK_FILENAME } from '@deepseek-ai/dsh-cron'
import type { CronDomainState, CronJob, CronJobId } from '@deepseek-ai/dsh-cron'

const roots: string[] = []
const followers: CronOwnership[] = []

afterEach(async () => {
  await Promise.allSettled(followers.splice(0).map(ownership => ownership.dispose()))
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function lockPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cron-ownership-'))
  roots.push(dir)
  return join(dir, LEADER_LOCK_FILENAME)
}

/** A real store over an empty in-memory table; the ownership never inspects it. */
function anyStore(): CronStore {
  const rows = new Map<CronJobId, CronJob>()
  const table: KvTable<CronJobId, CronJob> = {
    get: key => rows.get(key),
    entries: () => rows.entries(),
    keys: () => rows.keys(),
    size: 0,
    put: async (key, value) => { rows.set(key, value) },
    delete: async key => rows.delete(key),
    update: async (key, change) => {
      const current = rows.get(key)
      if (current === undefined) throw new Error('missing row')
      return change(current)
    },
  }
  const state: CronDomainState = { nextJobNumber: 1 }
  const global: DomainGlobal<CronDomainState> = {
    get: () => state,
    set: async (value) => { state.nextJobNumber = value.nextJobNumber },
  }
  return new CronStore(table, global)
}

/** A manual retry scheduler: the test decides when the next attempt runs. */
function manualRetry(): {
  schedule: (attempt: () => void, delayMs: number) => () => void
  delays: number[]
  fire(): void
  cancelled: number
} {
  const pending: Array<() => void> = []
  const delays: number[] = []
  const state = { cancelled: 0 }
  return {
    delays,
    get cancelled() { return state.cancelled },
    schedule: (attempt, delayMs) => {
      delays.push(delayMs)
      pending.push(attempt)
      return () => { state.cancelled += 1; pending.pop() }
    },
    fire: () => { pending.shift()?.() },
  }
}

describe('CronOwnership', () => {
  it('opens the store only after taking the lock', async () => {
    const path = await lockPath()
    const opened: CronStore[] = []
    const seen: Array<CronStore | undefined> = []
    const ownership = await CronOwnership.start({
      lockPath: path,
      retryMs: 1_000,
      openStore: async () => { const store = anyStore(); opened.push(store); return store },
      closeStore: async () => { throw new Error('must not close while leading') },
      onStore: (store) => { seen.push(store) },
      scheduleRetry: manualRetry().schedule,
    })
    followers.push(ownership)
    expect(opened).toHaveLength(1)
    expect(ownership.current).toBe(opened[0])
    expect(seen).toEqual([opened[0]])
  })

  it('opens nothing while another process leads, and takes over when it goes', async () => {
    const path = await lockPath()
    const leader = await CronLeadership.take(path)
    const opened: CronStore[] = []
    const retry = manualRetry()
    const ownership = await CronOwnership.start({
      lockPath: path,
      retryMs: 2_500,
      openStore: async () => { const store = anyStore(); opened.push(store); return store },
      closeStore: async () => undefined,
      onStore: () => undefined,
      scheduleRetry: retry.schedule,
    })
    followers.push(ownership)
    expect(opened).toHaveLength(0)
    expect(ownership.current).toBeUndefined()
    expect(retry.delays).toEqual([2_500])
    // The leader leaves, and the follower's next attempt is the one that opens.
    await leader?.release()
    retry.fire()
    // The attempt does real filesystem work, so wait for its effect rather than
    // for a guessed number of microtasks.
    await expect.poll(() => opened.length).toBe(1)
  })

  it('closes the store and frees the lock on disposal', async () => {
    const path = await lockPath()
    const closed: CronStore[] = []
    const seen: Array<CronStore | undefined> = []
    const ownership = await CronOwnership.start({
      lockPath: path,
      retryMs: 1_000,
      openStore: async () => anyStore(),
      closeStore: async (store) => { closed.push(store) },
      onStore: (store) => { seen.push(store) },
      scheduleRetry: manualRetry().schedule,
    })
    followers.push(ownership)
    await ownership.dispose()
    expect(closed).toHaveLength(1)
    expect(seen).toEqual([expect.any(CronStore), undefined])
    expect(ownership.current).toBeUndefined()
    // Nobody holds it now, so a successor can lead.
    const successor = await CronLeadership.take(path)
    expect(successor).toBeDefined()
    await successor?.release()
  })

  it('cancels a pending retry on disposal', async () => {
    const path = await lockPath()
    const leader = await CronLeadership.take(path)
    const retry = manualRetry()
    const opened: CronStore[] = []
    const ownership = await CronOwnership.start({
      lockPath: path,
      retryMs: 1_000,
      openStore: async () => { const store = anyStore(); opened.push(store); return store },
      closeStore: async () => undefined,
      onStore: () => undefined,
      scheduleRetry: retry.schedule,
    })
    await ownership.dispose()
    expect(retry.cancelled).toBe(1)
    await leader?.release()
    retry.fire()
    await Promise.resolve()
    expect(opened).toHaveLength(0)
  })

  it('ignores a retry that fires after disposal', async () => {
    // The class does not assume the caller's canceller removed the timer, so an
    // attempt that starts anyway opens nothing.
    const path = await lockPath()
    const leader = await CronLeadership.take(path)
    const pending: Array<() => void> = []
    const opened: CronStore[] = []
    const ownership = await CronOwnership.start({
      lockPath: path,
      retryMs: 1_000,
      openStore: async () => { const store = anyStore(); opened.push(store); return store },
      closeStore: async () => undefined,
      onStore: () => undefined,
      // A canceller that leaves the timer in place.
      scheduleRetry: (attempt) => { pending.push(attempt); return () => undefined },
    })
    await ownership.dispose()
    await leader?.release()
    for (const attempt of pending) attempt()
    expect(opened).toHaveLength(0)
  })

  it('closes a store that finished opening after disposal', async () => {
    // The race a follower can hit: its retry opens the store while disposal is
    // already running, so leadership must not survive into the opened store.
    const path = await lockPath()
    const leader = await CronLeadership.take(path)
    const retry = manualRetry()
    const gate = Promise.withResolvers<CronStore>()
    const closed: CronStore[] = []
    let openCalls = 0
    const ownership = await CronOwnership.start({
      lockPath: path,
      retryMs: 1_000,
      openStore: async () => { openCalls += 1; return await gate.promise },
      closeStore: async (store) => { closed.push(store) },
      onStore: () => undefined,
      scheduleRetry: retry.schedule,
    })
    await leader?.release()
    retry.fire()
    await expect.poll(() => openCalls).toBe(1)
    await ownership.dispose()
    const store = anyStore()
    gate.resolve(store)
    await expect.poll(() => closed.length).toBe(1)
    expect(closed[0]).toBe(store)
    expect(ownership.current).toBeUndefined()
  })

  it('releases the lock when the store cannot be opened', async () => {
    const path = await lockPath()
    const failure = new Error('backend unavailable')
    await expect(CronOwnership.start({
      lockPath: path,
      retryMs: 1_000,
      openStore: async () => { throw failure },
      closeStore: async () => undefined,
      onStore: () => undefined,
      scheduleRetry: manualRetry().schedule,
    })).rejects.toBe(failure)
    // Holding leadership without a store would stop every other process from
    // ever becoming the scheduler.
    const successor = await CronLeadership.take(path)
    expect(successor).toBeDefined()
    await successor?.release()
  })
})
