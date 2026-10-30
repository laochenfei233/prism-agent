/**
 * Shared vocabulary of the backup feature: the route the settings page calls,
 * the target protocols, the run records the page renders, and the failure codes
 * every layer throws. Client-safe — no Node or Cordis value is imported, so the
 * browser half reads exactly what the Host produces.
 * @module @prism/prism-backup/types
 */

/** Absolute pathname the Host owns the settings page's JSON calls under. */
export const BACKUP_ROUTE_PATH = '/api/prism.backup'

/** Document-relative form of {@link BACKUP_ROUTE_PATH} the browser addresses. */
export const BACKUP_ROUTE = BACKUP_ROUTE_PATH.slice(1)

/** Remote protocol a backup targets. */
export type BackupTargetType = 'webdav' | 's3' | 'smb'

/** Password-type value the settings page writes through the credential surface. */
export type BackupSecretId = 'webdav-password' | 'smb-password' | 's3-secret-key'

/** Credential reference carrying each secret, resolved once per run. */
export const BACKUP_SECRET_REFS: Readonly<Record<BackupSecretId, string>> = {
  'webdav-password': 'PRISM_BACKUP_WEBDAV_PASSWORD',
  'smb-password': 'PRISM_BACKUP_SMB_PASSWORD',
  's3-secret-key': 'PRISM_BACKUP_S3_SECRET_KEY',
}

/** Machine code carried by every backup failure. */
export type BackupErrorCode =
  | 'prism-backup/bad-request'
  | 'prism-backup/not-configured'
  | 'prism-backup/busy'
  | 'prism-backup/connection-failed'
  | 'prism-backup/auth-failed'
  | 'prism-backup/upload-failed'
  | 'prism-backup/collect-failed'
  | 'prism-backup/failed'

/** How much of each source one run archived. */
export interface BackupCounts {
  /** Configuration files copied (0–4 depending on which exist). */
  readonly settings: number
  /** Files under the memory store. */
  readonly memoryFiles: number
  /** Registered project folders found in the workspace registry. */
  readonly projects: number
  /** Files archived from those folders. */
  readonly projectFiles: number
}

/** One finished run, as the settings page lists it. */
export interface BackupRunRecord {
  /** Run identity, also the storage key. */
  readonly id: string
  /** Epoch milliseconds when the run started. */
  readonly startedAt: number
  /** Epoch milliseconds when the run settled. */
  readonly finishedAt: number
  /** Terminal state; a cancelled or failed run is `failed`. */
  readonly status: 'success' | 'failed'
  /** Active target protocol at the time of the run. */
  readonly targetType: BackupTargetType
  /** Sanitized endpoint label (never carries a credential). */
  readonly endpoint: string
  /** Archive filename, when one was produced. */
  readonly archiveName?: string | undefined
  /** Destination key below the target root, when the upload started. */
  readonly objectKey?: string | undefined
  /** Archive size in bytes, when one was produced. */
  readonly sizeBytes?: number | undefined
  /** Per-source counts, as far as the run got. */
  readonly counts: BackupCounts
  /** Failure code and message; absent on success. */
  readonly failure?: { readonly code: BackupErrorCode; readonly message: string } | undefined
}

/** Phase the active run is in, with the counters the page shows while it polls. */
export interface BackupPhase {
  /** Current pipeline stage. */
  readonly phase: 'collect' | 'zip' | 'upload' | 'rotate'
  /** One line naming what this stage is doing. */
  readonly detail: string
  /** Files handled so far in this stage. */
  readonly files: number
  /** Bytes handled so far in this stage. */
  readonly bytes: number
}

/** Everything the settings page needs to render run state and history. */
export interface BackupState {
  /** Whether a run is active right now. */
  readonly running: boolean
  /** Active run's phase; absent when nothing runs. */
  readonly phase?: BackupPhase | undefined
  /** Finished runs, newest first, capped at the retention the Host keeps. */
  readonly history: readonly BackupRunRecord[]
}

/** One call the settings page makes. */
export type BackupRequest =
  | { readonly action: 'state' }
  | { readonly action: 'run' }
  | { readonly action: 'test' }

/** Successful answer body. */
export interface BackupSuccess<T> {
  /** Discriminant. */
  readonly ok: true
  /** Action's result. */
  readonly value: T
}

/** Failed answer body; the HTTP status is 400 for `bad-request`, 409 for `busy`, and 502 otherwise. */
export interface BackupFailure {
  /** Discriminant. */
  readonly ok: false
  /** Machine code and a sentence the page can show as-is. */
  readonly error: { readonly code: BackupErrorCode; readonly message: string }
}

/** Answer body of every call on {@link BACKUP_ROUTE_PATH}. */
export type BackupResponse<T> = BackupSuccess<T> | BackupFailure

/** Value of a successful `test` call. */
export interface BackupTestValue {
  /** Sentence naming what the target answered. */
  readonly message: string
}
