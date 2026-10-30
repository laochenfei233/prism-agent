/**
 * Durable run history: one record per finished run in the `prism_backup`
 * storage domain, pruned to the newest entries so the settings page always
 * reads a bounded list. The domain is the Host's ordinary non-session storage,
 * so history survives a restart without any file format of its own.
 * @module @prism/prism-backup/history
 */

import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { BackupRunRecord } from './types.ts'

/** How many finished runs the history keeps. */
export const HISTORY_LIMIT = 20

const countsSchema = z.object({
  settings: z.number().int().min(0),
  memoryFiles: z.number().int().min(0),
  projects: z.number().int().min(0),
  projectFiles: z.number().int().min(0),
}).strict()

const recordSchema = z.object({
  id: z.string().min(1),
  startedAt: z.number().int().min(0),
  finishedAt: z.number().int().min(0),
  status: z.enum(['success', 'failed']),
  targetType: z.enum(['webdav', 's3', 'smb']),
  endpoint: z.string(),
  archiveName: z.string().min(1).optional(),
  sizeBytes: z.number().int().min(0).optional(),
  counts: countsSchema,
  failure: z.object({
    code: z.enum([
      'prism-backup/bad-request',
      'prism-backup/not-configured',
      'prism-backup/busy',
      'prism-backup/connection-failed',
      'prism-backup/auth-failed',
      'prism-backup/upload-failed',
      'prism-backup/collect-failed',
      'prism-backup/failed',
    ]),
    message: z.string(),
  }).strict().optional(),
}).strict()

/** Authoritative backup history storage; a malformed record rejects opening. */
export const backupDomain = defineDomain({
  name: 'prism_backup',
  version: 1,
  tables: { runs: domainTable<string, BackupRunRecord>(recordSchema) },
})

/** The read/write face the run pipeline and the route share. */
export interface BackupHistory {
  /**
   * Wait until the durable store is readable.
   * @returns settlement once history can be read and written.
   */
  ensure(): Promise<void>
  /**
   * @returns finished runs, newest first.
   */
  list(): readonly BackupRunRecord[]
  /**
   * Append one record and prune the oldest beyond the retention limit.
   * @param record - the finished run.
   */
  append(record: BackupRunRecord): Promise<void>
}

/** History over an opened {@link backupDomain}. */
export class DomainBackupHistory implements BackupHistory {
  /**
   * @param domain - the opened backup domain.
   * @param limit - records kept, newest first.
   */
  constructor(private readonly domain: Domain<typeof backupDomain>, private readonly limit = HISTORY_LIMIT) {}

  /** @returns settlement once history can be read and written. */
  async ensure(): Promise<void> {}

  /** @returns finished runs, newest first. */
  list(): readonly BackupRunRecord[] {
    return [...this.domain.table('runs').entries()]
      .map(([, record]) => record)
      .sort((left, right) => right.startedAt - left.startedAt)
  }

  /**
   * Append one record and prune the oldest beyond the retention limit.
   * @param record - the finished run.
   */
  async append(record: BackupRunRecord): Promise<void> {
    const runs = this.domain.table('runs')
    await runs.put(record.id, record)
    const ordered = this.list()
    for (const stale of ordered.slice(this.limit)) await runs.delete(stale.id)
  }
}
