/** Durable history over the real storage stack: ordering, pruning, and the lazy store. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { afterEach, describe, expect, it } from 'vitest'
import { backupDomain, DomainBackupHistory, type BackupHistory } from '../src/history.ts'
import { BackupHistoryStore, HISTORY_LIMIT } from '../src/index.ts'
import type { BackupRunRecord } from '../src/types.ts'

const roots: string[] = []

/**
 * Build one mounted storage stack.
 * @returns the context whose `storageDomain` serves {@link backupDomain}.
 */
async function storageContext(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'prism-backup-history-'))
  roots.push(root)
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  return ctx
}

/** One finished run. */
function record(id: string, startedAt: number): BackupRunRecord {
  return {
    id,
    startedAt,
    finishedAt: startedAt + 1,
    status: 'success',
    targetType: 'smb',
    endpoint: 'D:\\remote',
    counts: { settings: 0, memoryFiles: 0, projects: 0, projectFiles: 0 },
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('DomainBackupHistory', () => {
  it('lists newest first and prunes the oldest beyond the limit', async () => {
    const ctx = await storageContext()
    const history = new DomainBackupHistory(await ctx.storageDomain.open(backupDomain), 2)
    await history.ensure()
    await history.append(record('a', 10))
    await history.append(record('b', 30))
    await history.append(record('c', 20))
    expect(history.list().map(entry => entry.id)).toEqual(['b', 'c'])
    expect([...ctx.storageDomain.get('prism_backup')!.table('runs').entries()]).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('ships a twenty-record default limit on the prism_backup domain', () => {
    expect(HISTORY_LIMIT).toBe(20)
    expect(backupDomain.name).toBe('prism_backup')
    expect(backupDomain.version).toBe(1)
  })
})

describe('history persistence', () => {
  it('survives a restart over the same harness home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-backup-history-restart-'))
    roots.push(root)
    const mount = async (): Promise<Context> => {
      const ctx = new Context()
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root: join(root, 'storage') })
      await ctx.plugin(StorageDomain, { backend: 'json' })
      return ctx
    }
    const first = await mount()
    const store = new BackupHistoryStore(first, () => {})
    await store.append(record('kept', 5))
    await first.fiber.dispose()

    const second = await mount()
    const reopened = new BackupHistoryStore(second, () => {})
    await reopened.ensure()
    expect(reopened.list().map(entry => entry.id)).toEqual(['kept'])
    await second.fiber.dispose()
  })
})

describe('BackupHistoryStore degradation', () => {
  it('reports one failure, answers empty history, and drops appends instead of throwing', async () => {
    const ctx = new Context()
    const failures: unknown[] = []
    ctx.provide('storageDomain', { open: async () => { throw new Error('corrupt history') } })
    const store = new BackupHistoryStore(ctx, (error) => { failures.push(error) })
    await store.ensure()
    await store.append(record('a', 1))
    await store.append(record('b', 2))
    expect(store.list()).toEqual([])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(Error)
    await ctx.fiber.dispose()
  })

  it('reports a refused append without failing the caller', async () => {
    const ctx = new Context()
    const failures: unknown[] = []
    ctx.provide('storageDomain', {
      open: async () => ({
        table: () => ({
          entries: () => [][Symbol.iterator](),
          put: async () => { throw new Error('disk full') },
          delete: async () => false,
        }),
      }),
    })
    const store = new BackupHistoryStore(ctx, (error) => { failures.push(error) })
    await store.append(record('a', 1))
    expect(failures).toHaveLength(1)
    expect(store.list()).toEqual([])
    await ctx.fiber.dispose()
  })

})

describe('BackupHistoryStore', () => {
  it('answers an empty list before the store opens and forwards afterwards', async () => {
    const ctx = await storageContext()
    const store: BackupHistory = new BackupHistoryStore(ctx, () => {})
    expect(store.list()).toEqual([])
    await store.ensure()
    expect(store.list()).toEqual([])
    await store.append(record('a', 1))
    expect(store.list().map(entry => entry.id)).toEqual(['a'])
    await ctx.fiber.dispose()
  })
})
