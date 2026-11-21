/**
 * One backup run, start to finish: collect the sources, zip them into a staging
 * file, upload the archive, prune older archives, and append the run record.
 * Runs are single-flight, so a second request answers `busy` instead of
 * queueing behind work it cannot see. The phase counters are the only live
 * state; everything durable lives in the run record.
 * @module @prism/prism-backup/run
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeArchive, type BackupManifest } from './archive.ts'
import { bytesOf, planBackup } from './collect.ts'
import { resolveBackup, type Config, type ResolvedBackup, type SecretReader } from './config.ts'
import { BackupError, asBackupError } from './error.ts'
import type { BackupHistory } from './history.ts'
import { createTransport, type Transport, type TransportDeps } from './transports.ts'
import type { BackupCounts, BackupPhase, BackupRunRecord, BackupState } from './types.ts'

/** Archive names this feature owns below the remote directory. */
const ARCHIVE_NAME = /^prism-backup-\d{8}-\d{6}\.zip$/u

/** Product name recorded in every manifest. */
export const BACKUP_APP_NAME = 'Prism Agent'

/** Counts recorded before any source was read. */
const EMPTY_COUNTS: BackupCounts = { settings: 0, memoryFiles: 0, projects: 0, projectFiles: 0 }

/** Everything one runner reads and writes. */
export interface BackupRunnerInput {
  /** Harness home (`~/.prism`). */
  readonly home: string
  /** Active profile's patch file, when the launcher supplied one. */
  readonly profilePatch?: string
  /** Directory staging archives live in until upload settles. */
  readonly stagingDir: string
  /** Product version recorded in the manifest. */
  readonly version: string
  /** The plugin's live configuration references. */
  readonly config: Config
  /** Stored-secret reader backed by the credential service. */
  readonly readSecret: SecretReader
  /** Durable history. */
  readonly history: BackupHistory
  /** Transport construction, injectable for tests. */
  readonly transport?: (target: ResolvedBackup['target']) => Transport
  /** Edges the transports accept (carrier, clock, platform). */
  readonly transportDeps?: TransportDeps
  /** Clock; defaults to the wall clock. */
  readonly now?: () => Date
  /** Host platform recorded in the manifest; defaults to the running one. */
  readonly platform?: string
}

/**
 * `YYYYMMDD-HHMMSS` in UTC, the archive-name stamp.
 * @param date - instant to name.
 * @returns the stamp.
 */
export function archiveStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15)
}

/**
 * The archive filename for one instant.
 * @param date - instant to name.
 * @returns the filename.
 */
export function archiveName(date: Date): string {
  return `prism-backup-${archiveStamp(date)}.zip`
}

/** Single-flight runner behind the route. */
export class BackupRunner {
  private active: Promise<BackupRunRecord> | undefined
  private phase: BackupPhase | undefined

  /** @param input - sources, policy, history, and injectable edges. */
  constructor(private readonly input: BackupRunnerInput) {}

  private now(): Date {
    return this.input.now?.() ?? new Date()
  }

  private transportFor(target: ResolvedBackup['target']): Transport {
    return this.input.transport?.(target) ?? createTransport(target, this.input.transportDeps)
  }

  /**
   * Read the state the settings page renders on every poll.
   * @returns whether a run is active, its phase, and the finished history newest first.
   */
  state(): BackupState {
    const running = this.active !== undefined
    return {
      running,
      ...running && this.phase !== undefined ? { phase: this.phase } : {},
      history: this.input.history.list(),
    }
  }

  /**
   * Prove the active target answers with the stored credential.
   * @returns the transport's success sentence.
   * @throws {BackupError} with the feature's codes.
   */
  async test(): Promise<string> {
    const resolved = await this.resolve()
    return await this.transportFor(resolved.target).test()
  }

  /**
   * Start one run. A run already in flight rejects with `busy` rather than
   * queueing.
   * @returns the finished run's record, success or failure.
   * @throws {BackupError} with `busy` when a run is already in flight, or
   *   `not-configured` before any work starts.
   */
  async run(): Promise<BackupRunRecord> {
    if (this.active !== undefined) {
      throw new BackupError('prism-backup/busy', 'A backup is already running; wait for it to finish.')
    }
    // Claim the slot in the same synchronous step as the guard: resolving the
    // policy awaits the credential service, and a second caller arriving in
    // that window would otherwise start a second run.
    const started = (async (): Promise<BackupRunRecord> => {
      const resolved = await this.resolve()
      return await this.execute(resolved)
    })()
    this.active = started
    try {
      return await started
    } finally {
      this.active = undefined
      this.phase = undefined
    }
  }

  /**
   * Resolve the live policy; a missing field fails before a run is claimed.
   * @returns the resolved target and content policy.
   */
  private async resolve(): Promise<ResolvedBackup> {
    return await resolveBackup(this.input.config, this.input.readSecret)
  }

  /**
   * Execute one resolved run and record its outcome.
   * @param resolved - validated target and content policy.
   * @returns the run record.
   */
  private async execute(resolved: ResolvedBackup): Promise<BackupRunRecord> {
    const startedAt = this.now().getTime()
    const name = archiveName(new Date(startedAt))
    const key = resolved.content.remoteDir === '' ? name : `${resolved.content.remoteDir}/${name}`
    const staging = join(this.input.stagingDir, `${randomUUID()}.zip`)
    let counts = EMPTY_COUNTS
    let sizeBytes: number | undefined
    let archiveNameWritten: string | undefined
    let objectKey: string | undefined
    const transport = this.transportFor(resolved.target)
    try {
      await mkdir(this.input.stagingDir, { recursive: true })
      this.setPhase('collect', 'Reading configuration, memory, and project folders', 0, 0)
      const plan = await planBackup({
        home: this.input.home,
        ...this.input.profilePatch === undefined ? {} : { profilePatch: this.input.profilePatch },
        content: resolved.content,
      }).catch((error: unknown) => {
        throw asBackupError(error, 'prism-backup/collect-failed', 'Reading the backup sources failed')
      })
      counts = plan.counts
      this.setPhase('collect', `Collected ${String(plan.members.length)} files`, plan.members.length, 0)

      const manifest: BackupManifest = {
        format: 1,
        createdAt: this.now().toISOString(),
        app: BACKUP_APP_NAME,
        version: this.input.version,
        platform: this.input.platform ?? process.platform,
        counts,
        bytes: bytesOf(plan.members),
        absent: plan.absent,
        warnings: plan.warnings,
      }
      const bytes = plan.members.reduce((total, member) => total + member.size, 0)
      this.setPhase('zip', 'Compressing the archive', plan.members.length, 0)
      const archived = await writeArchive(plan.members, manifest, staging)
      sizeBytes = archived.sizeBytes
      archiveNameWritten = name
      this.setPhase('zip', `Compressed ${String(bytes)} source bytes`, plan.members.length, archived.sizeBytes)

      this.setPhase('upload', `Uploading to ${transport.endpoint}`, 0, archived.sizeBytes)
      await this.upload(transport, staging, key)
      objectKey = key

      this.setPhase('rotate', 'Pruning older archives', 0, 0)
      await this.rotate(transport, resolved.content.remoteDir, name, resolved.content.maxBackups)

      return await this.record({
        startedAt,
        status: 'success',
        targetType: resolved.target.type,
        endpoint: transport.endpoint,
        archiveName: archiveNameWritten,
        objectKey,
        sizeBytes,
        counts,
      })
    } catch (error: unknown) {
      const classified = asBackupError(error, 'prism-backup/failed', 'The backup failed')
      return await this.record({
        startedAt,
        status: 'failed',
        targetType: resolved.target.type,
        endpoint: transport.endpoint,
        ...archiveNameWritten === undefined ? {} : { archiveName: archiveNameWritten },
        ...objectKey === undefined ? {} : { objectKey },
        ...sizeBytes === undefined ? {} : { sizeBytes },
        counts,
        failure: { code: classified.code, message: classified.message },
      })
    } finally {
      this.phase = undefined
      await rm(staging, { force: true })
    }
  }

  /**
   * Upload the staged archive, classifying a provider failure.
   * @param transport - active transport.
   * @param staging - staged archive path.
   * @param key - destination key.
   */
  private async upload(transport: Transport, staging: string, key: string): Promise<void> {
    try {
      await transport.upload(staging, key)
    } catch (error: unknown) {
      throw asBackupError(error, 'prism-backup/upload-failed', `Uploading to ${transport.endpoint} failed`)
    }
  }

  /**
   * Delete the oldest archives beyond the retention the policy asks for.
   * @param transport - active transport.
   * @param remoteDir - directory holding the archives.
   * @param current - the archive this run just wrote, which always survives.
   * @param keep - total archives to leave behind; `0` keeps everything.
   */
  private async rotate(transport: Transport, remoteDir: string, current: string, keep: number): Promise<void> {
    if (keep === 0) return
    const names = (await transport.list(remoteDir))
      .filter(name => ARCHIVE_NAME.test(name) && name !== current)
      .sort()
    const surplus = names.length - Math.max(keep - 1, 0)
    if (surplus <= 0) return
    for (const name of names.slice(0, surplus)) {
      const key = remoteDir === '' ? name : `${remoteDir}/${name}`
      try {
        await transport.remove(key)
      } catch (error: unknown) {
        throw asBackupError(error, 'prism-backup/upload-failed', `Deleting old archive ${name} failed`)
      }
    }
  }

  /**
   * Append one finished record and return it.
   * @param fields - everything except the id and finish time.
   * @returns the stored record.
   */
  private async record(fields: Omit<BackupRunRecord, 'id' | 'finishedAt'>): Promise<BackupRunRecord> {
    const record: BackupRunRecord = {
      ...fields,
      id: randomUUID(),
      finishedAt: this.now().getTime(),
    }
    await this.input.history.append(record)
    return record
  }

  /**
   * Publish the active phase.
   * @param phase - current stage.
   * @param detail - one line naming what it does.
   * @param files - files handled in this stage.
   * @param bytes - bytes handled in this stage.
   */
  private setPhase(phase: BackupPhase['phase'], detail: string, files: number, bytes: number): void {
    this.phase = { phase, detail, files, bytes }
  }
}
