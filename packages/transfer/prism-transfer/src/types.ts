/**
 * Wire and archive vocabulary shared by the host routes and the browser
 * section: the three version-1 archive formats with their validators, the
 * export request, and the import job snapshot.
 *
 * @module @prism/prism-transfer/types
 */

import { TransferError } from './errors.ts'

/** Root manifest of a single-project archive. */
export const PROJECT_MANIFEST_NAME = '.prism-project.json'
/** Root manifest of a combined archive. */
export const TRANSFER_MANIFEST_NAME = '.prism-transfer.json'
/** Settings body inside a combined archive. */
export const SETTINGS_ENTRY_NAME = 'settings.json'
/** Archive prefix holding one workspace folder's contents. */
export const PROJECT_FOLDER_PREFIX = 'project/'
/** Archive prefix holding every exported session of one project. */
export const SESSIONS_FOLDER_PREFIX = 'sessions/'

/** Self-description at the root of a single-project archive. */
export interface PrismProjectManifest {
  format: 'prism-project'
  version: 1
  /** Display title; the import sanitizes it into a directory name. */
  title: string
  exportedAt: string
  /** Absolute project path on the exporting machine; informational only. */
  originalPath?: string
  /** Sessions the exporter attempted to include. */
  sessions: number
  /** Whether the archive carries `project/**` (false for an empty folder). */
  hasProjectFolder: boolean
}

/** One project inside a combined archive. */
export interface PrismTransferProject {
  /** Child directory under `projects/`, unique within the archive. */
  dir: string
  title: string
  sessions: number
}

/** Self-description at the root of a combined archive. */
export interface PrismTransferManifest {
  format: 'prism-transfer'
  version: 1
  exportedAt: string
  projects: readonly PrismTransferProject[]
  /** Whether the archive embeds a `settings.json`. */
  settings: boolean
}

/** The settings document, standalone or embedded as `settings.json`. */
export interface PrismSettingsFile {
  format: 'prism-settings'
  version: 1
  exportedAt: string
  /** Whether secret-role fields carry their real values. */
  includeSecrets: boolean
  /** Volatile projection per active settings namespace. */
  namespaces: Readonly<Record<string, unknown>>
}

/** Whether a parsed value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Required string field read with a typed refusal. */
function stringField(record: Record<string, unknown>, key: string, code: 'bad-manifest' | 'settings-format'): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new TransferError(code, `field "${key}" must be a non-empty string`)
  }
  return value
}

/** Required boolean field read with a typed refusal. */
function booleanField(record: Record<string, unknown>, key: string, code: 'bad-manifest' | 'settings-format'): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new TransferError(code, `field "${key}" must be a boolean`)
  return value
}

/**
 * Validate one parsed root manifest as a single-project description.
 * @param value - the parsed manifest JSON.
 * @returns the typed manifest.
 */
export function parseProjectManifest(value: unknown): PrismProjectManifest {
  if (!isRecord(value)) throw new TransferError('bad-manifest', 'project manifest must be a JSON object')
  if (value['format'] !== 'prism-project') {
    throw new TransferError('bad-manifest', `unsupported manifest format ${String(value['format'])}`)
  }
  if (value['version'] !== 1) {
    throw new TransferError('bad-manifest', `unsupported manifest version ${String(value['version'])}`)
  }
  return {
    format: 'prism-project',
    version: 1,
    title: stringField(value, 'title', 'bad-manifest'),
    exportedAt: stringField(value, 'exportedAt', 'bad-manifest'),
    ...(typeof value['originalPath'] === 'string' ? { originalPath: value['originalPath'] } : {}),
    sessions: typeof value['sessions'] === 'number' ? value['sessions'] : 0,
    hasProjectFolder: booleanField(value, 'hasProjectFolder', 'bad-manifest'),
  }
}

/**
 * Validate one parsed root manifest as a combined-archive description.
 * @param value - the parsed manifest JSON.
 * @returns the typed manifest.
 */
export function parseTransferManifest(value: unknown): PrismTransferManifest {
  if (!isRecord(value)) throw new TransferError('bad-manifest', 'transfer manifest must be a JSON object')
  if (value['format'] !== 'prism-transfer') {
    throw new TransferError('bad-manifest', `unsupported manifest format ${String(value['format'])}`)
  }
  if (value['version'] !== 1) {
    throw new TransferError('bad-manifest', `unsupported manifest version ${String(value['version'])}`)
  }
  const rawProjects = value['projects']
  if (!Array.isArray(rawProjects)) throw new TransferError('bad-manifest', 'field "projects" must be an array')
  const projects = rawProjects.map((entry): PrismTransferProject => {
    if (!isRecord(entry)) throw new TransferError('bad-manifest', 'every project entry must be an object')
    return {
      dir: stringField(entry, 'dir', 'bad-manifest'),
      title: stringField(entry, 'title', 'bad-manifest'),
      sessions: typeof entry['sessions'] === 'number' ? entry['sessions'] : 0,
    }
  })
  return {
    format: 'prism-transfer',
    version: 1,
    exportedAt: stringField(value, 'exportedAt', 'bad-manifest'),
    projects,
    settings: booleanField(value, 'settings', 'bad-manifest'),
  }
}

/**
 * Validate one parsed settings document.
 * @param value - the parsed settings JSON.
 * @returns the typed settings file.
 */
export function parseSettingsFile(value: unknown): PrismSettingsFile {
  if (!isRecord(value)) throw new TransferError('settings-format', 'settings document must be a JSON object')
  if (value['format'] !== 'prism-settings') {
    throw new TransferError('settings-format', `unsupported settings format ${String(value['format'])}`)
  }
  if (value['version'] !== 1) {
    throw new TransferError('settings-format', `unsupported settings version ${String(value['version'])}`)
  }
  const namespaces = value['namespaces']
  if (!isRecord(namespaces)) throw new TransferError('settings-format', 'field "namespaces" must be an object')
  return {
    format: 'prism-settings',
    version: 1,
    exportedAt: stringField(value, 'exportedAt', 'settings-format'),
    includeSecrets: booleanField(value, 'includeSecrets', 'settings-format'),
    namespaces,
  }
}

/** One workspace selected for export, resolved by the host. */
export interface ExportWorkspaceSource {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

/** What the browser asks the export route to produce. */
export interface ExportRequest {
  readonly projectIds: readonly string[]
  readonly includeSettings: boolean
  readonly includeSecrets: boolean
}

/** Per-project outcome of one finished import. */
export interface ImportedProjectResult {
  /** Published directory name (suffix included). */
  readonly name: string
  /** Absolute published path. */
  readonly path: string
  /** Sessions restored for this project. */
  readonly sessions: number
  /** Sessions skipped because their id already existed. */
  readonly duplicates: number
  /** Present when the files are restored but registration failed. */
  readonly registerError?: string
}

/** Per-namespace outcome of one settings application. */
export interface SettingsApplyOutcome {
  readonly ns: string
  readonly outcome: 'applied' | 'skipped' | 'failed'
  readonly reason?: string
}

/** Import phases, in execution order. */
export type TransferJobPhase =
  | 'validating'
  | 'extracting'
  | 'restoring'
  | 'applying-settings'
  | 'registering'
  | 'done'

/** Pollable import job state. */
export interface TransferJobSnapshot {
  readonly jobId: string
  /** `unknown` between job start and manifest dispatch. */
  readonly kind: 'project' | 'combined' | 'unknown'
  readonly state: 'running' | 'done' | 'failed'
  readonly phase: TransferJobPhase
  /** Source archive filename. */
  readonly name: string
  readonly archiveBytes: number
  readonly files: number
  readonly bytes: number
  readonly sessionsDone: number
  readonly sessionsTotal: number
  readonly projectsDone: number
  readonly projectsTotal: number
  readonly duplicates: number
  readonly result?: {
    readonly projects: readonly ImportedProjectResult[]
    readonly settings?: readonly SettingsApplyOutcome[]
  }
  readonly error?: {
    readonly code: string
    readonly detail: string
  }
  readonly startedAt: number
  readonly finishedAt?: number
}
