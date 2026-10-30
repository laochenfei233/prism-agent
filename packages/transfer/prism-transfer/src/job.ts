/**
 * Single-flight import job store. The route reserves a slot synchronously (no
 * await between the check and the claim), so two requests in one tick cannot
 * both run; the finished snapshot is retained until the next job starts or
 * ten minutes pass, and a poll for an unknown, expired, or foreign job id
 * answers `idle`.
 *
 * @module @prism/prism-transfer/job
 */

import { randomUUID } from 'node:crypto'
import type { TransferJobPhase, TransferJobSnapshot } from './types.ts'

/** How long a finished snapshot stays pollable after its job ends. */
const RETENTION_MILLISECONDS = 10 * 60 * 1000

/** Progress surface the import engine drives. */
export interface TransferJobProgress {
  /** Set the archive layout once the manifest names it. */
  setKind(kind: 'project' | 'combined'): void
  /** Advance the phase marker. */
  setPhase(phase: TransferJobPhase): void
  /** Count extracted files and consumed bytes. */
  addFiles(count: number): void
  addBytes(count: number): void
  /** Session counters; totals arrive once the archive is scanned. */
  setSessionsTotal(total: number): void
  addSessionsDone(count: number): void
  addDuplicates(count: number): void
  /** Project counters; totals arrive once the manifest dispatch is done. */
  setProjectsTotal(total: number): void
  addProjectDone(count: number): void
  /** Export-side skip counters mirrored into the import snapshot. */
  setSkippedLinks(count: number): void
  setSkippedUnreadable(count: number): void
}

/** Mutable store entry behind one running or finished job. */
interface JobEntry {
  readonly jobId: string
  readonly startedAt: number
  name: string
  archiveBytes: number
  kind: TransferJobSnapshot['kind']
  state: TransferJobSnapshot['state']
  phase: TransferJobPhase
  files: number
  bytes: number
  sessionsDone: number
  sessionsTotal: number
  projectsDone: number
  projectsTotal: number
  duplicates: number
  skippedLinks: number
  skippedUnreadable: number
  skippedSecrets: number
  result: TransferJobSnapshot['result']
  error: TransferJobSnapshot['error']
  finishedAt: number | undefined
}

/** Owner side of one reserved job slot. */
export interface ReservedJob extends TransferJobProgress {
  readonly jobId: string
}

/** Single-flight import job state. */
export class TransferJobStore {
  private current: JobEntry | undefined

  /**
   * Reserve the single job slot synchronously.
   * @param name - source archive filename.
   * @param archiveBytes - spooled archive size.
   * @returns the progress handle, or `undefined` when a job is running.
   */
  tryBegin(name: string, archiveBytes: number): ReservedJob | undefined {
    if (this.current?.state === 'running') return undefined
    const entry: JobEntry = {
      jobId: randomUUID(),
      startedAt: Date.now(),
      name,
      archiveBytes,
      kind: 'unknown',
      state: 'running',
      phase: 'validating',
      files: 0,
      bytes: 0,
      sessionsDone: 0,
      sessionsTotal: 0,
      projectsDone: 0,
      projectsTotal: 0,
      duplicates: 0,
      skippedLinks: 0,
      skippedUnreadable: 0,
      skippedSecrets: 0,
      result: undefined,
      error: undefined,
      finishedAt: undefined,
    }
    this.current = entry
    return {
      jobId: entry.jobId,
      setKind: (kind) => {
        entry.kind = kind
      },
      setPhase: (phase) => {
        entry.phase = phase
      },
      addFiles: (count) => {
        entry.files += count
      },
      addBytes: (count) => {
        entry.bytes += count
      },
      setSessionsTotal: (total) => {
        entry.sessionsTotal = total
      },
      addSessionsDone: (count) => {
        entry.sessionsDone += count
      },
      addDuplicates: (count) => {
        entry.duplicates += count
      },
      setProjectsTotal: (total) => {
        entry.projectsTotal = total
      },
      addProjectDone: (count) => {
        entry.projectsDone += count
      },
      setSkippedLinks: (count) => {
        entry.skippedLinks = count
      },
      setSkippedUnreadable: (count) => {
        entry.skippedUnreadable = count
      },
    }
  }

  /**
   * Mark one job done with its outcomes.
   * @param jobId - the reservation's id.
   * @param name - source archive filename.
   * @param archiveBytes - spooled archive size.
   * @param result - per-project and settings outcomes.
   */
  finish(
    jobId: string,
    name: string,
    archiveBytes: number,
    result: NonNullable<TransferJobSnapshot['result']>,
  ): void {
    const entry = this.owned(jobId)
    if (entry === undefined) return
    entry.state = 'done'
    entry.phase = 'done'
    entry.name = name
    entry.archiveBytes = archiveBytes
    entry.result = result
    entry.finishedAt = Date.now()
  }

  /**
   * Mark one job failed; the detail rides the snapshot for copy mapping.
   * @param jobId - the reservation's id.
   * @param error - the typed refusal.
   */
  fail(jobId: string, error: { readonly code: string; readonly detail: string }): void {
    const entry = this.owned(jobId)
    if (entry === undefined) return
    entry.state = 'failed'
    entry.error = { code: error.code, detail: error.detail }
    entry.finishedAt = Date.now()
  }

  /**
   * Read the pollable state.
   * @param jobId - the caller's job id; anything else answers idle.
   * @param now - clock override for retention tests.
   * @returns the frozen snapshot, or `idle`.
   */
  snapshot(jobId: string, now: number = Date.now()): { state: 'idle' } | TransferJobSnapshot {
    const entry = this.current
    if (entry === undefined || entry.jobId !== jobId) return { state: 'idle' }
    if (entry.finishedAt !== undefined && now - entry.finishedAt > RETENTION_MILLISECONDS) {
      this.current = undefined
      return { state: 'idle' }
    }
    return {
      jobId: entry.jobId,
      kind: entry.kind,
      state: entry.state,
      phase: entry.phase,
      name: entry.name,
      archiveBytes: entry.archiveBytes,
      files: entry.files,
      bytes: entry.bytes,
      sessionsDone: entry.sessionsDone,
      sessionsTotal: entry.sessionsTotal,
      projectsDone: entry.projectsDone,
      projectsTotal: entry.projectsTotal,
      duplicates: entry.duplicates,
      skippedLinks: entry.skippedLinks,
      skippedUnreadable: entry.skippedUnreadable,
      skippedSecrets: entry.skippedSecrets,
      ...entry.result !== undefined ? { result: entry.result } : {},
      ...entry.error !== undefined ? { error: entry.error } : {},
      startedAt: entry.startedAt,
      ...entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {},
    }
  }

  /** The owned entry for a job id, when it is still the current one. */
  private owned(jobId: string): JobEntry | undefined {
    const entry = this.current
    return entry !== undefined && entry.jobId === jobId ? entry : undefined
  }
}
