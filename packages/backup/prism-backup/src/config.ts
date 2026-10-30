/**
 * The editable backup policy: volatile fields the settings form is projected
 * from, and the resolution that turns the active target's fields plus the
 * stored secrets into a validated target spec. Field ranges are schema
 * invariants; a missing required field is a run-time `not-configured` failure
 * naming the field, so the page can save a half-filled target while the user
 * switches protocols.
 * @module @prism/prism-backup/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BackupError } from './error.ts'
import { BACKUP_SECRET_REFS, type BackupSecretId, type BackupTargetType } from './types.ts'

/** Default remote directory below the target's root. */
export const DEFAULT_REMOTE_DIR = 'prism-backup'

/** Default number of archives kept; `0` keeps every archive. */
export const DEFAULT_MAX_BACKUPS = 10

/** Path segments never walked inside a project folder. */
export const DEFAULT_PROJECT_EXCLUDES: readonly string[] = [
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__',
  '.venv', 'venv', '.next', '.turbo', '.cache', '.DS_Store',
]

/** Backup policy as the plugin receives it: every field is a live reference. */
export interface Config {
  /** Active remote protocol. @default 'webdav' */
  targetType: Volatile<BackupTargetType>
  /** WebDAV base URL including the server's collection path. */
  webdavUrl: Volatile<string>
  /** S3 endpoint origin; empty means the AWS endpoint for {@link s3Region}. */
  s3Endpoint: Volatile<string>
  /** S3 signing region. @default 'us-east-1' */
  s3Region: Volatile<string>
  /** S3 bucket that receives archives. */
  s3Bucket: Volatile<string>
  /** Address the bucket as `endpoint/bucket` instead of `bucket.endpoint`. @default false */
  s3PathStyle: Volatile<boolean>
  /** UNC path (`\\server\share\folder`) or mounted directory receiving archives. */
  smbPath: Volatile<string>
  /** WebDAV or SMB user name; unused by S3. */
  username: Volatile<string>
  /** S3 access key id; the secret key lives in the credential store. */
  s3AccessKeyId: Volatile<string>
  /** Directory below the target root that holds archives. @default 'prism-backup' */
  remoteDir: Volatile<string>
  /** Archive the configuration files. @default true */
  includeSettings: Volatile<boolean>
  /** Archive the long-term memory store. @default true */
  includeMemory: Volatile<boolean>
  /** Archive the registered project folders. @default true */
  includeProjects: Volatile<boolean>
  /** Newline- or comma-separated path segments never walked. */
  projectExcludes: Volatile<string>
  /** Archives kept after a successful run; `0` keeps every archive. @default 10 */
  maxBackups: Volatile<number>
}

/** The plugin's configuration schema; the settings form is projected from it. */
export const Config = z.object({
  targetType: z.union(['webdav', 's3', 'smb'] as const).default('webdav').volatile(),
  webdavUrl: z.string().default('').volatile(),
  s3Endpoint: z.string().default('').volatile(),
  s3Region: z.string().default('us-east-1').volatile(),
  s3Bucket: z.string().default('').volatile(),
  s3PathStyle: z.boolean().default(false).volatile(),
  smbPath: z.string().default('').volatile(),
  username: z.string().default('').volatile(),
  s3AccessKeyId: z.string().default('').volatile(),
  remoteDir: z.string().default(DEFAULT_REMOTE_DIR).volatile(),
  includeSettings: z.boolean().default(true).volatile(),
  includeMemory: z.boolean().default(true).volatile(),
  includeProjects: z.boolean().default(true).volatile(),
  projectExcludes: z.string().default(DEFAULT_PROJECT_EXCLUDES.join('\n')).volatile(),
  maxBackups: z.number().step(1).min(0).default(DEFAULT_MAX_BACKUPS).volatile(),
})

/** One resolved remote: everything a transport needs, and nothing secret in a record. */
export type BackupTarget =
  | {
    readonly type: 'webdav'
    /** Base URL, trailing slashes removed. */
    readonly baseUrl: string
    /** Basic-auth user name. */
    readonly username: string
    /** Basic-auth password. */
    readonly password: string
  }
  | {
    readonly type: 's3'
    /** Endpoint origin without a trailing slash. */
    readonly endpoint: string
    readonly region: string
    readonly bucket: string
    readonly pathStyle: boolean
    readonly accessKeyId: string
    readonly secretAccessKey: string
  }
  | {
    readonly type: 'smb'
    /** Absolute directory archives are written below. */
    readonly root: string
    readonly username: string
    readonly password: string
  }

/** What one run archives and how many archives survive it. */
export interface BackupContent {
  readonly settings: boolean
  readonly memory: boolean
  readonly projects: boolean
  readonly excludes: ReadonlySet<string>
  readonly maxBackups: number
  readonly remoteDir: string
}

/** A target plus the content policy, both validated for this run. */
export interface ResolvedBackup {
  readonly target: BackupTarget
  readonly content: BackupContent
}

/**
 * Split the exclude text on newlines and commas.
 * @param text - stored exclusion text.
 * @returns the trimmed, non-empty segments in stored order.
 */
export function parseExcludes(text: string): readonly string[] {
  return text.split(/[\n,]/u).map(segment => segment.trim()).filter(segment => segment !== '')
}

/**
 * Normalize the remote directory: forward slashes, no leading or trailing slash.
 * @param text - stored directory.
 * @returns the normalized directory.
 * @throws {BackupError} when a segment would escape the target root.
 */
export function normalizeRemoteDir(text: string): string {
  const normalized = text.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
  if (normalized.split('/').some(segment => segment === '..')) {
    throw new BackupError('prism-backup/not-configured', 'The remote directory must not contain "..".')
  }
  return normalized
}

/** Reads one stored secret, or `undefined` when the page never stored it. */
export type SecretReader = (id: BackupSecretId) => Promise<string | undefined>

/**
 * Require one secret, naming the credential reference in the failure.
 * @param read - stored-secret reader.
 * @param id - which secret this target needs.
 * @returns the secret value.
 * @throws {BackupError} with code `not-configured` when nothing is stored.
 */
async function requireSecret(read: SecretReader, id: BackupSecretId): Promise<string> {
  const value = await read(id)
  if (value === undefined || value === '') {
    throw new BackupError(
      'prism-backup/not-configured',
      `Store the password first: set credential ${BACKUP_SECRET_REFS[id]} on this page.`,
    )
  }
  return value
}

/**
 * Require one non-empty text field.
 * @param value - field value.
 * @param field - field name used in the failure.
 * @returns the trimmed value.
 * @throws {BackupError} with code `not-configured` when the field is blank.
 */
function requireText(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new BackupError('prism-backup/not-configured', `Fill in ${field} before running a backup.`)
  }
  return trimmed
}

/**
 * Resolve the live policy into a validated target and content selection.
 * @param config - the plugin's live configuration references.
 * @param readSecret - stored-secret reader; the host supplies the credential service.
 * @returns the resolved target and content policy.
 * @throws {BackupError} with code `not-configured` naming the first missing field.
 */
export async function resolveBackup(config: Config, readSecret: SecretReader): Promise<ResolvedBackup> {
  const target = await resolveTarget(config, readSecret)
  return {
    target,
    content: {
      settings: config.includeSettings.get(),
      memory: config.includeMemory.get(),
      projects: config.includeProjects.get(),
      excludes: new Set(parseExcludes(config.projectExcludes.get())),
      maxBackups: config.maxBackups.get(),
      remoteDir: normalizeRemoteDir(config.remoteDir.get()),
    },
  }
}

/**
 * Resolve the active protocol's target fields.
 * @param config - the plugin's live configuration references.
 * @param readSecret - stored-secret reader.
 * @returns the target spec.
 * @throws {BackupError} with code `not-configured` naming the first missing field.
 */
export async function resolveTarget(config: Config, readSecret: SecretReader): Promise<BackupTarget> {
  const type = config.targetType.get()
  if (type === 'webdav') {
    return {
      type,
      baseUrl: withoutUserinfo(requireText(config.webdavUrl.get(), 'the WebDAV URL').replace(/\/+$/u, '')),
      username: config.username.get().trim(),
      password: await requireSecret(readSecret, 'webdav-password'),
    }
  }
  if (type === 's3') {
    const region = requireText(config.s3Region.get(), 'the S3 region')
    const endpoint = config.s3Endpoint.get().trim().replace(/\/+$/u, '')
    return {
      type,
      endpoint: endpoint === '' ? `https://s3.${region}.amazonaws.com` : withoutUserinfo(endpoint),
      region,
      bucket: requireText(config.s3Bucket.get(), 'the S3 bucket'),
      pathStyle: config.s3PathStyle.get(),
      accessKeyId: requireText(config.s3AccessKeyId.get(), 'the S3 access key id'),
      secretAccessKey: await requireSecret(readSecret, 's3-secret-key'),
    }
  }
  return {
    type: 'smb',
    root: requireText(config.smbPath.get(), 'the SMB path'),
    username: config.username.get().trim(),
    password: (await readSecret('smb-password')) ?? '',
  }
}

/**
 * Sanitized label a run record keeps for one target: the endpoint without any
 * credential, user name, or secret.
 * @param target - resolved target.
 * @returns the label shown in the history list.
 */
export function targetLabel(target: BackupTarget): string {
  if (target.type === 'webdav') return target.baseUrl
  if (target.type === 's3') return `${target.endpoint}/${target.bucket}`
  return target.root
}

/**
 * Drop any `user:password@` from one URL before it becomes a target, so no
 * phase line, failure message, or durable record can carry a credential.
 * @param url - a configured endpoint.
 * @returns the same endpoint without userinfo.
 */
function withoutUserinfo(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString().replace(/\/$/u, '')
  } catch (_notAUrl) {
    return url
  }
}
