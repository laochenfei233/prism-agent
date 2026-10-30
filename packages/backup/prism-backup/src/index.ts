/**
 * Prism backup: archive the configuration, the long-term memory store, and the
 * registered project folders, then upload the archive to a WebDAV, SMB, or S3
 * server. The Host half owns collection, archiving, transports, rotation, and
 * history; the settings page reaches it through one POST route because that
 * work is a file transfer rather than a JSON Remote call. Settings ride the
 * existing `remote.settings` surface and passwords ride `remote.credentials`,
 * so this plugin adds no namespace of its own.
 * @module @prism/prism-backup
 */

import type { Context } from '@deepseek-ai/cordis'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-connection'
import { dshCachePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { Config, SecretReader } from './config.ts'
import { BackupError, asBackupError, statusOf } from './error.ts'
import { DomainBackupHistory, backupDomain, type BackupHistory } from './history.ts'
import { BackupRunner } from './run.ts'
import {
  BACKUP_ROUTE_PATH, BACKUP_SECRET_REFS,
  type BackupFailure, type BackupRequest, type BackupResponse, type BackupRunRecord, type BackupSecretId,
  type BackupState, type BackupTestValue,
} from './types.ts'

export { Config } from './config.ts'
export type { BackupContent, BackupTarget, ResolvedBackup } from './config.ts'
export {
  DEFAULT_MAX_BACKUPS, DEFAULT_PROJECT_EXCLUDES, DEFAULT_REMOTE_DIR, parseExcludes, resolveBackup,
} from './config.ts'
export { BackupError } from './error.ts'
export { HISTORY_LIMIT, backupDomain, DomainBackupHistory } from './history.ts'
export type { BackupHistory } from './history.ts'
export { BackupRunner, archiveName, archiveStamp } from './run.ts'
export type { BackupRunnerInput } from './run.ts'
export { planBackup, projectPathsOf } from './collect.ts'
export { createTransport, uncShareOf } from './transports.ts'
export type { Transport, TransportDeps } from './transports.ts'
export { signHeaders, amzDate, UNSIGNED_PAYLOAD } from './sigv4.ts'
export type { AwsCredentials, SignInput } from './sigv4.ts'
export { BACKUP_ROUTE_PATH, BACKUP_ROUTE, BACKUP_SECRET_REFS } from './types.ts'
export type * from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'prism-backup'

/** Services this plugin requires: the API route carrier and durable history. */
export const inject = ['connection', 'storageDomain', 'credentials']

/** History over a storage domain opened on first use, so activation stays synchronous. */
export class BackupHistoryStore implements BackupHistory {
  private opening: Promise<DomainBackupHistory> | undefined
  private opened: DomainBackupHistory | undefined

  /** @param ctx - the plugin's context, whose storage domain owns the records. */
  constructor(private readonly ctx: Context) {}

  /** @returns settlement once history can be read and written. */
  async ensure(): Promise<void> {
    await this.open()
  }

  /** @returns finished runs, newest first; empty until the store opens. */
  list(): readonly BackupRunRecord[] {
    return this.opened?.list() ?? []
  }

  /** @param record - the finished run. */
  async append(record: BackupRunRecord): Promise<void> {
    await (await this.open()).append(record)
  }

  private async open(): Promise<DomainBackupHistory> {
    this.opening ??= this.ctx.storageDomain.open(backupDomain).then((domain) => {
      this.opened = new DomainBackupHistory(domain)
      return this.opened
    })
    return await this.opening
  }
}

/**
 * Read one stored password through the credential service.
 * @param ctx - host context carrying `credentials`.
 * @returns the reader the config resolver uses.
 */
function secretReader(ctx: Context): SecretReader {
  return async (id: BackupSecretId) => {
    const resolved = await ctx.credentials.resolve(credentialRef(BACKUP_SECRET_REFS[id]))
    return resolved?.value
  }
}

/**
 * Answer one call with a JSON body and the status its code implies.
 * @param body - success or failure envelope.
 * @param status - HTTP status.
 * @returns the response.
 */
function jsonResponse(body: BackupResponse<unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Failure envelope for one thrown value.
 * @param error - thrown value.
 * @returns the envelope and the status it implies.
 */
function failure(error: unknown): { body: BackupFailure; status: number } {
  const classified = asBackupError(error, 'prism-backup/failed', 'The backup failed')
  return {
    body: { ok: false, error: { code: classified.code, message: classified.message } },
    status: statusOf(classified.code),
  }
}

/**
 * Parse one request body into a known action.
 * @param request - the POST request.
 * @returns the action.
 * @throws {BackupError} with `bad-request` for a body this route does not serve.
 */
async function requestOf(request: Request): Promise<BackupRequest> {
  let body: unknown
  try {
    body = await request.json()
  } catch (error: unknown) {
    throw new BackupError('prism-backup/bad-request', 'The request body is not JSON.', { cause: error })
  }
  if (typeof body !== 'object' || body === null) {
    throw new BackupError('prism-backup/bad-request', 'The request body must be a JSON object.')
  }
  const action = (body as { readonly action?: unknown }).action
  if (action === 'state' || action === 'run' || action === 'test') return { action }
  throw new BackupError(
    'prism-backup/bad-request',
    'The request action must be "state", "run", or "test".',
  )
}

/** The two faces the route drives; tests supply doubles, `apply` supplies the real ones. */
export interface BackupRouteDeps {
  /** Runs and probes the active target. */
  readonly runner: Pick<BackupRunner, 'run' | 'test' | 'state'>
  /** Durable history; awaited before a `state` answer. */
  readonly history: Pick<BackupHistory, 'ensure'>
}

/**
 * Build the POST handler behind the settings page.
 * @param deps - the runner and history the actions drive.
 * @returns the Fetch-shaped handler `ctx.connection.fetch.register` accepts.
 */
export function createBackupRoute(deps: BackupRouteDeps): ConnectionFetchRoute['fetch'] {
  return async (request) => {
    try {
      const action = await requestOf(request)
      if (action.action === 'state') {
        await deps.history.ensure()
        const value: BackupState = deps.runner.state()
        return jsonResponse({ ok: true, value }, 200)
      }
      if (action.action === 'test') {
        const value: BackupTestValue = { message: await deps.runner.test() }
        return jsonResponse({ ok: true, value }, 200)
      }
      const record = await deps.runner.run()
      if (record.status === 'failed' && record.failure !== undefined) {
        const refused = failure(new BackupError(record.failure.code, record.failure.message))
        return jsonResponse(refused.body, refused.status)
      }
      return jsonResponse({ ok: true, value: record }, 200)
    } catch (error: unknown) {
      const { body, status } = failure(error)
      return jsonResponse(body, status)
    }
  }
}

/**
 * Mount the backup service and its settings route.
 * @param ctx - Host context carrying the route carrier and storage domain.
 * @param config - live backup policy.
 */
export function apply(ctx: Context, config: Config): void {
  const profile = ctx.get('profileContext')
  const home = profile?.home ?? resolveDshHome()
  const history = new BackupHistoryStore(ctx)
  void history.ensure()
  const runner = new BackupRunner({
    home,
    ...profile === undefined ? {} : { profilePatch: profile.patchPath },
    stagingDir: dshCachePath('backups'),
    version: getDshRuntimeVersion(),
    config,
    readSecret: secretReader(ctx),
    history,
  })
  const route: ConnectionFetchRoute = {
    path: BACKUP_ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: createBackupRoute({ runner, history }),
  }
  ctx.effect(() => ctx.connection.fetch.register(route), 'prism-backup: settings route')
}
