/**
 * Shared fixtures for the cron specs: a real store over an in-memory table, and
 * a complete job record to vary one field at a time.
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { CronStore } from '@deepseek-ai/dsh-cron'
import type { CronDomainState, CronJob, CronJobId } from '@deepseek-ai/dsh-cron'
import type { DomainGlobal, KvTable } from '@deepseek-ai/dsh-storage-domain'

/**
 * Hooks a spec uses to make one write fail, or to change a row around it.
 *
 * `put` is mutable because a spec installs it once the store is already
 * running: the table reads it at write time, so a fault that must fire only
 * after an earlier write lands is stated that way.
 */
export interface StoreFaults {
  /**
   * Inspect one value about to be written, and change the rows it lands beside.
   * @param value - the record the write would store.
   * @param rows - every row currently stored.
   * @throws to fail that write.
   */
  put?: (value: CronJob, rows: Map<CronJobId, CronJob>) => void
}

/** The store the fixture builds, plus the rows behind it for assertions. */
export interface FixtureStore {
  readonly store: CronStore
  /** Every row currently stored, keyed by identity. */
  readonly rows: Map<CronJobId, CronJob>
}

/**
 * Build a real {@link CronStore} over an in-memory table and id allocator, so a
 * spec exercises the store's own contract without a storage backend.
 * @param initial - the rows the store opens with.
 * @param faults - the write hook, absent when the spec needs no failure.
 * @returns the store and the rows behind it.
 */
export function memoryStore(initial: readonly CronJob[] = [], faults: StoreFaults = {}): FixtureStore {
  const rows = new Map<CronJobId, CronJob>(initial.map(job => [job.id, job]))
  const table: KvTable<CronJobId, CronJob> = {
    get: key => rows.get(key),
    entries: () => rows.entries(),
    keys: () => rows.keys(),
    size: rows.size,
    put: async (key, value) => {
      faults.put?.(value, rows)
      rows.set(key, value)
    },
    delete: async key => rows.delete(key),
    deleteMany: async keys => {
      let removed = 0
      for (const key of keys) if (rows.delete(key)) removed += 1
      return removed
    },
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
  return { store: new CronStore(table, global), rows }
}

/**
 * One complete stored job.
 * @param overrides - the fields this fixture varies.
 * @returns the record.
 */
export function cronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    version: 1,
    id: brandString<CronJobId>('cron-1'),
    expression: '0 9 * * *',
    timeZone: 'UTC',
    enabled: true,
    target: { kind: 'session', sessionId: 'session-1' },
    prompt: 'check the build',
    overlapPolicy: 'skip',
    misfirePolicy: 'skip',
    maxRunMs: 1_000,
    createdAt: 0,
    updatedAt: 0,
    nextDueAt: 32_400_000,
    recentRuns: [],
    ...overrides,
  }
}
