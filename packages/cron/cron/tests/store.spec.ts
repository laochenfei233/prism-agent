import { describe, expect, it } from 'vitest'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { CronStore } from '@deepseek-ai/dsh-cron'
import type { CronDomainState, CronJob, CronJobId } from '@deepseek-ai/dsh-cron'

/** A map-backed table with the members the store uses. */
function fakeTable(initial: readonly CronJob[] = []): KvTable<CronJobId, CronJob> {
  const rows = new Map<CronJobId, CronJob>(initial.map(job => [job.id, job]))
  return {
    get: key => rows.get(key),
    entries: () => rows.entries(),
    keys: () => rows.keys(),
    get size() { return rows.size },
    put: async (key, value) => { rows.set(key, value) },
    delete: async key => rows.delete(key),
    deleteMany: async keys => {
      let removed = 0
      for (const key of keys) if (rows.delete(key)) removed += 1
      return removed
    },
    update: async (key, change) => {
      const current = rows.get(key)
      if (current === undefined) throw new Error('missing row')
      const next = change(current)
      rows.set(key, next)
      return next
    },
  }
}

/** A global handle whose writes can be made to fail once, for the failure case. */
function fakeGlobal(failNextSet = { value: false }): DomainGlobal<CronDomainState> & { readonly state: CronDomainState } {
  const state: CronDomainState = { nextJobNumber: 1 }
  return {
    state,
    get: () => state,
    set: async (value) => {
      if (failNextSet.value) {
        failNextSet.value = false
        throw new Error('backend refused the write')
      }
      state.nextJobNumber = value.nextJobNumber
    },
  }
}

function job(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    version: 1,
    id: id as CronJobId,
    expression: '0 9 * * *',
    timeZone: 'UTC',
    enabled: true,
    target: { kind: 'session', sessionId: 'session-1' },
    prompt: 'check the build',
    overlapPolicy: 'skip',
    misfirePolicy: 'run-once-late',
    maxRunMs: 60_000,
    createdAt: 1,
    updatedAt: 1,
    nextDueAt: 2_000_000_000_000,
    recentRuns: [],
    ...overrides,
  }
}

describe('CronStore', () => {
  it('stores, reads, lists, and removes jobs', async () => {
    const store = new CronStore(fakeTable(), fakeGlobal())
    const first = job('cron-1')
    const second = job('cron-2')
    await store.put(first)
    await store.put(second)
    expect(store.get(first.id)).toEqual(first)
    expect(store.list()).toHaveLength(2)
    await expect(store.remove(first.id)).resolves.toBe(true)
    await expect(store.remove(first.id)).resolves.toBe(false)
    expect(store.get(first.id)).toBeUndefined()
    expect(store.list()).toEqual([second])
  })

  it('replaces a job in place when it is written again', async () => {
    const store = new CronStore(fakeTable(), fakeGlobal())
    await store.put(job('cron-1'))
    await store.put(job('cron-1', { enabled: false, updatedAt: 99 }))
    expect(store.list()).toHaveLength(1)
    expect(store.get('cron-1' as CronJobId)?.enabled).toBe(false)
  })

  it('mints advancing identities and records the allocator', async () => {
    const global = fakeGlobal()
    const store = new CronStore(fakeTable(), global)
    await expect(store.allocateId()).resolves.toBe('cron-1')
    await expect(store.allocateId()).resolves.toBe('cron-2')
    expect(global.state.nextJobNumber).toBe(3)
  })

  it('never mints one number twice under concurrent allocation', async () => {
    const store = new CronStore(fakeTable(), fakeGlobal())
    const minted = await Promise.all([store.allocateId(), store.allocateId(), store.allocateId()])
    expect(new Set(minted).size).toBe(3)
  })

  it('keeps allocating after one allocation fails', async () => {
    // The write chain continues from a settled continuation, so a refused write
    // cannot leave every later allocation waiting on a rejected promise.
    const failNext = { value: true }
    const store = new CronStore(fakeTable(), fakeGlobal(failNext))
    await expect(store.allocateId()).rejects.toThrow('backend refused the write')
    await expect(store.allocateId()).resolves.toBe('cron-1')
  })
})
