/**
 * Export engine: scans registered workspace folders under the export guards,
 * then streams one zip — single-project or combined layout — whose session
 * entries come from the shared session-log exporter and whose settings come
 * from the volatile projection of the live settings document.
 *
 * The archive is built straight onto the response stream; nothing stages on
 * disk and the host never holds a whole archive in memory.
 *
 * @module @prism/prism-transfer/export-engine
 */

import { opendir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Zip, ZipDeflate } from 'fflate'
import {
  flushLiveSessionLog,
  pushArtifactChunks,
  pushBinaryChunks,
  pushStreamChunks,
  readSessionLogText,
  ResponseCapacityGate,
  sessionLogExportDeps,
  sessionLogZipEntries,
  type SessionLogExportReady,
  type SessionLogZipEntry,
} from '@deepseek-ai/dsh-session-log-export'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TransferError } from './errors.ts'
import { sanitizeProjectDirectoryName } from './naming.ts'
import { exportSettingsFile, type SettingsTransferDeps } from './settings-transfer.ts'
import {
  PROJECT_FOLDER_PREFIX,
  PROJECT_MANIFEST_NAME,
  SESSIONS_FOLDER_PREFIX,
  SETTINGS_ENTRY_NAME,
  TRANSFER_MANIFEST_NAME,
  type ExportRequest,
  type ExportWorkspaceSource,
  type PrismProjectManifest,
} from './types.ts'

/** Surfaces the export engine reads (the session trio arrives prebuilt). */
export interface TransferExportDeps extends SessionLogExportReady {
  /** Registered workspaces, for id resolution. */
  readonly workspaces: {
    /**
     * Resolve one registered workspace by id.
     * @param id - workspace id from the browser.
     * @returns the workspace record, or `undefined` when unknown.
     */
    get(id: string): Promise<ExportWorkspaceSource | undefined>
  }
  /** Settings document projection. */
  readonly settings: SettingsTransferDeps
}

/** One scanned workspace folder ready to archive. */
export interface ScannedProjectFolder {
  /** Files in archive order (sorted by relative path). */
  readonly files: readonly {
    readonly relativePath: string
    readonly absolutePath: string
    readonly size: number
  }[]
  readonly totalBytes: number
  /** Symbolic links, junctions, and special entries skipped, never followed. */
  readonly skippedLinks: number
  /** Entries whose stat failed. */
  readonly skippedUnreadable: number
}

/** A resolved export: layout choice, scanned folders, and session selections. */
export interface TransferExportPlan {
  readonly kind: 'project' | 'combined'
  readonly projects: readonly {
    readonly source: ExportWorkspaceSource
    readonly folder: ScannedProjectFolder
  }[]
  readonly includeSettings: boolean
  readonly includeSecrets: boolean
}

/** One byte over the fflate per-entry limit; the guard refuses at or above it. */
const MAXIMUM_FILE_BYTES = 4 * 2 ** 30

/** Optional scan knobs; production always uses the house ceiling. */
export interface ScanProjectFolderOptions {
  /** Cancellation observed between entries. */
  readonly signal?: AbortSignal
  /** Per-file ceiling; defaults to the archive writer's real limit. */
  readonly maxFileBytes?: number
}

/**
 * Walk one workspace folder under the export guards: no link leaves the
 * folder, no name carries a backslash or NUL, and no single file reaches the
 * archive writer's per-entry ceiling.
 * @param root - absolute workspace folder path.
 * @param options - cancellation and the (test-injectable) file ceiling.
 * @returns the scanned folder.
 */
export async function scanProjectFolder(
  root: string,
  options: ScanProjectFolderOptions = {},
): Promise<ScannedProjectFolder> {
  const signal = options.signal
  const maxFileBytes = options.maxFileBytes ?? MAXIMUM_FILE_BYTES
  const files: { relativePath: string; absolutePath: string; size: number }[] = []
  let totalBytes = 0
  let skippedLinks = 0
  let skippedUnreadable = 0
  try {
    await stat(root)
  } catch {
    throw new TransferError('bad-request', `project folder "${root}" does not exist or is not readable`)
  }
  const walk = async (absolute: string, relative: string): Promise<void> => {
    signal?.throwIfAborted()
    let directory
    try {
      directory = await opendir(absolute)
    } catch {
      skippedUnreadable += 1
      return
    }
    try {
      for await (const entry of directory) {
        const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
        // v8 ignore next 2 -- only POSIX directories can list a name carrying a backslash, and no platform lists NUL
        if (entry.name.includes('\\') || entry.name.includes('\u0000')) {
          throw new TransferError('unsafe-path', `"${childRelative}" cannot be archived (backslash or NUL in the name)`)
        }
        if (entry.isSymbolicLink()) {
          skippedLinks += 1
          continue
        }
        const childAbsolute = join(absolute, entry.name)
        if (entry.isDirectory()) {
          await walk(childAbsolute, childRelative)
          continue
        }
        // v8 ignore next 2 -- only POSIX directories can list FIFO or device entries, which are neither directory, file, nor link
        if (!entry.isFile()) {
          skippedLinks += 1
          continue
        }
        let size: number
        try {
          size = (await stat(childAbsolute)).size
        } catch {
          // v8 ignore next 1 -- no Windows composition makes a just-listed entry's stat fail; the POSIX race needs a concurrent delete
          skippedUnreadable += 1
          // v8 ignore next 1 -- see above
          continue
        }
        if (size >= maxFileBytes) {
          throw new TransferError(
            'entry-too-large',
            `"${childRelative}" is ${String(size)} bytes; compress or split it before exporting`,
          )
        }
        files.push({ relativePath: childRelative, absolutePath: childAbsolute, size })
        totalBytes += size
      }
    } finally {
      // Closing an exhausted directory handle must not mask the walk's outcome.
      await directory.close().catch(() => {})
    }
  }
  await walk(root, '')
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return { files, totalBytes, skippedLinks, skippedUnreadable }
}

/**
 * Resolve the export request into a validated plan: every id must be a
 * registered workspace, and the layout follows the request (one project and
 * no settings → single-project zip, otherwise combined).
 * @param deps - export surfaces.
 * @param request - selection from the browser.
 * @param signal - optional cancellation.
 * @returns the plan.
 */
export async function planTransferExport(
  deps: TransferExportDeps,
  request: ExportRequest,
  signal?: AbortSignal,
): Promise<TransferExportPlan> {
  if (request.projectIds.length === 0 && !request.includeSettings) {
    throw new TransferError('no-projects', 'select at least one project or include settings')
  }
  const projects: { source: ExportWorkspaceSource; folder: ScannedProjectFolder }[] = []
  for (const id of request.projectIds) {
    signal?.throwIfAborted()
    const source = await deps.workspaces.get(id)
    if (source === undefined) {
      throw new TransferError('unknown-workspace', `workspace "${id}" is not registered`)
    }
    const folder = await scanProjectFolder(source.path, signal === undefined ? {} : { signal })
    projects.push({ source, folder })
  }
  return {
    kind: projects.length === 1 && !request.includeSettings ? 'project' : 'combined',
    projects,
    includeSettings: request.includeSettings,
    includeSecrets: request.includeSecrets,
  }
}

/** Build one project manifest for the archive. */
function projectManifest(source: ExportWorkspaceSource, folder: ScannedProjectFolder): PrismProjectManifest {
  return {
    format: 'prism-project',
    version: 1,
    title: source.title,
    exportedAt: new Date().toISOString(),
    originalPath: source.path,
    sessions: source.sessionIds.length,
    hasProjectFolder: folder.files.length > 0,
  }
}

/** Re-root one session's export entries under its archive directory. */
async function* sessionEntries(
  deps: TransferExportDeps,
  sessionId: string,
  prefix: string,
  signal: AbortSignal,
): AsyncGenerator<SessionLogZipEntry> {
  const id = sessionId as SessionId
  await flushLiveSessionLog(deps, id, signal)
  const rootContent = await readSessionLogText(deps.sessionPersistence, id, signal)
  if (rootContent === undefined) {
    throw new TransferError('transfer-failed', `session "${sessionId}" has no readable stored log`)
  }
  for await (const entry of sessionLogZipEntries(deps, rootContent, id, true, signal)) {
    yield { ...entry, path: `${prefix}${entry.path}` }
  }
}

/** Yield one folder's files under an archive prefix, streaming from disk. */
async function* folderEntries(
  folder: ScannedProjectFolder,
  prefix: string,
): AsyncGenerator<SessionLogZipEntry> {
  for (const file of folder.files) {
    yield { path: `${prefix}${PROJECT_FOLDER_PREFIX}${file.relativePath}`, chunks: createReadStream(file.absolutePath) }
  }
}

/** Filename segments for one combined-archive child. */
function childDirectory(index: number, title: string): string {
  return `${String(index + 1)}-${sanitizeProjectDirectoryName(title, 'project')}`
}

/**
 * Yield every archive entry in write order: root manifest first, then each
 * project's folder and sessions, then the optional settings document.
 * @param deps - export surfaces.
 * @param plan - the resolved export.
 * @param signal - cancellation forwarded to every read.
 * @returns the archive entries.
 */
export async function* transferArchiveEntries(
  deps: TransferExportDeps,
  plan: TransferExportPlan,
  signal: AbortSignal,
): AsyncGenerator<SessionLogZipEntry> {
  if (plan.kind === 'project') {
    const project = plan.projects.at(0)
    if (project === undefined) throw new TransferError('transfer-failed', 'single-project plan carries no project')
    yield {
      path: PROJECT_MANIFEST_NAME,
      content: `${JSON.stringify(projectManifest(project.source, project.folder), null, 2)}\n`,
    }
    yield* folderEntries(project.folder, '')
    const prefix = SESSIONS_FOLDER_PREFIX
    for (const sessionId of project.source.sessionIds) {
      signal.throwIfAborted()
      yield* sessionEntries(deps, sessionId, `${prefix}${safeSessionSegment(sessionId)}/`, signal)
    }
    return
  }
  const settings = plan.includeSettings
    ? exportSettingsFile(deps.settings, plan.includeSecrets)
    : undefined
  yield {
    path: TRANSFER_MANIFEST_NAME,
    content: `${JSON.stringify({
      format: 'prism-transfer',
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: plan.projects.map((project, index) => ({
        dir: childDirectory(index, project.source.title),
        title: project.source.title,
        sessions: project.source.sessionIds.length,
      })),
      settings: settings !== undefined,
    }, null, 2)}\n`,
  }
  for (const [index, project] of plan.projects.entries()) {
    const dir = `projects/${childDirectory(index, project.source.title)}/`
    yield {
      path: `${dir}${PROJECT_MANIFEST_NAME}`,
      content: `${JSON.stringify(projectManifest(project.source, project.folder), null, 2)}\n`,
    }
    yield* folderEntries(project.folder, dir)
    const prefix = `${dir}${SESSIONS_FOLDER_PREFIX}`
    for (const sessionId of project.source.sessionIds) {
      signal.throwIfAborted()
      yield* sessionEntries(deps, sessionId, `${prefix}${safeSessionSegment(sessionId)}/`, signal)
    }
  }
  if (settings !== undefined) {
    yield { path: SETTINGS_ENTRY_NAME, content: `${JSON.stringify(settings.file, null, 2)}\n` }
  }
}

/** Zip storage level for binary media (already compressed upstream). */
const MEDIA_LEVEL = 0
/** Deflate level for text artifacts and folder files. */
const TEXT_LEVEL = 6
/** Byte capacity retained by the response stream before production waits for pull. */
const RESPONSE_HIGH_WATER_MARK_BYTES = 1 << 16

/**
 * Stream one transfer archive as a WHATWG ReadableStream. Entries are
 * produced lazily, so a mid-stream failure (unreadable log, cancelled read)
 * errors the download instead of shipping a truncated archive.
 * @param entries - the archive entries in write order.
 * @param signal - request cancellation combined with consumer cancellation.
 * @returns the zip byte stream.
 */
export function streamTransferZip(
  entries: AsyncGenerator<SessionLogZipEntry>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const consumerAbort = new AbortController()
  const producerSignal = AbortSignal.any([signal, consumerAbort.signal])
  let zip: Zip | undefined
  let zipTerminated = false
  const capacity = new ResponseCapacityGate()
  const terminateZip = (): void => {
    if (zip === undefined || zipTerminated) return
    zipTerminated = true
    zip.terminate()
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const archive = new Zip((error, data, final) => {
        /* v8 ignore next 3 -- fflate reports only internal zip failures, unreachable for valid inputs */
        if (error) {
          controller.error(error)
          return
        }
        /* v8 ignore next -- fflate may emit empty chunks; not controllable from tests */
        if (data.byteLength > 0) controller.enqueue(data)
        if (final) controller.close()
      })
      zip = archive
      void (async () => {
        try {
          for await (const entry of entries) {
            const level = 'content' in entry ? TEXT_LEVEL : 'data' in entry ? MEDIA_LEVEL : TEXT_LEVEL
            const deflate = new ZipDeflate(entry.path, { level })
            archive.add(deflate)
            if ('content' in entry) {
              await pushArtifactChunks(deflate, entry.content, controller, capacity, producerSignal)
            } else if ('data' in entry) {
              await pushBinaryChunks(deflate, entry.data, controller, capacity, producerSignal)
            } else {
              await pushStreamChunks(deflate, entry.chunks, controller, capacity, producerSignal)
            }
          }
          archive.end()
        } catch (error) {
          // A mid-stream failure must fail the download rather than ship a
          // truncated archive.
          /* v8 ignore next -- typed engines reject with Error, and DOMException is one in Node */
          terminateZip()
          controller.error(error instanceof Error ? error : new Error(String(error)))
        }
      })()
    },
    pull() {
      capacity.pulled()
    },
    cancel(reason) {
      consumerAbort.abort(
        reason instanceof Error ? reason : new Error('transfer export stream cancelled'),
      )
      terminateZip()
    },
  }, {
    highWaterMark: RESPONSE_HIGH_WATER_MARK_BYTES,
    size: chunk => chunk.byteLength,
  })
}

/**
 * The download filename for one export plan.
 * @param plan - the resolved export.
 * @param now - clock for the combined-archive timestamp.
 * @returns the attachment filename.
 */
export function exportFilename(plan: TransferExportPlan, now: Date = new Date()): string {
  if (plan.kind === 'project') {
    const project = plan.projects.at(0)
    if (project === undefined) throw new TransferError('transfer-failed', 'single-project plan carries no project')
    return `${sanitizeProjectDirectoryName(project.source.title, 'project')}.zip`
  }
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${String(now.getFullYear()).padStart(4, '0')}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `prism-transfer-${stamp}.zip`
}

/** One safe archive path segment from a session id, matching the exporter's own rule. */
function safeSessionSegment(id: string): string {
  const segment = id.replace(/[^A-Za-z0-9_-]/gu, '_')
  return segment === '' ? 'session' : segment
}

/**
 * Resolve the export surfaces from a composed host context.
 * @param context - the host context.
 * @param workspaces - registered-workspace lookup.
 * @param settings - settings document projection.
 * @returns the export surfaces.
 */
export function transferExportDeps(
  context: Context,
  workspaces: TransferExportDeps['workspaces'],
  settings: SettingsTransferDeps,
): TransferExportDeps {
  const session = sessionLogExportDeps(context)
  if (session.sessionQuery === undefined || session.sessionPersistence === undefined
    || session.attachments === undefined) {
    throw new TransferError(
      'unsupported',
      'transfer export is unavailable: missing session-query, session-persistence, or attachments service',
    )
  }
  return {
    sessionQuery: session.sessionQuery,
    sessionPersistence: session.sessionPersistence,
    attachments: session.attachments,
    sessions: session.sessions,
    workspaces,
    settings,
  }
}
