/**
 * Project and settings transfer: the settings-page section can export
 * selected projects (workspace folder plus attached sessions) and the
 * settings values into archive files, and import such archives back without
 * ever overwriting existing data.
 *
 * The Host half owns four authenticated Fetch routes (streaming export
 * download, streaming archive upload into a background job, job polling, and
 * buffered settings application). The browser half registers the settings
 * section and calls those routes. Nothing here is model-visible: no prompt,
 * tool, or session event is registered.
 *
 * @module @prism/prism-transfer
 */

import { createWriteStream } from 'node:fs'
import { mkdir, opendir, rm, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
// Type-only: the ctx.sessionQuery, ctx.sessions, and ctx.dshHomePath merges
// the export surfaces read through.
import type {} from '@deepseek-ai/dsh-session-query'
import { asTransferError, TransferError } from './errors.ts'
import {
  exportFilename,
  planTransferExport,
  streamTransferZip,
  transferArchiveEntries,
  transferExportDeps,
} from './export-engine.ts'
import { runImport } from './import-engine.ts'
import { TransferJobStore } from './job.ts'
import { applySettingsFile, exportSettingsFile, parseSettingsText } from './settings-transfer.ts'
import { TRANSFER_EXPORT_PATH, TRANSFER_IMPORT_PATH, TRANSFER_JOB_PATH, TRANSFER_SETTINGS_PATH } from './routes.ts'
import type { ExportRequest } from './types.ts'

export { TRANSFER_EXPORT_PATH, TRANSFER_IMPORT_PATH, TRANSFER_JOB_PATH, TRANSFER_SETTINGS_PATH } from './routes.ts'
export { TransferJobStore } from './job.ts'
export type * from './types.ts'

export const name = 'prism-transfer'
export const inject = ['connection', 'sessionPersistence', 'workspaceRegistry', 'attachments', 'settings']

/** How long a spooled import archive may sit before the startup sweep removes it. */
const SPOOL_MAX_AGE_MILLISECONDS = 24 * 60 * 60 * 1000
/** Spool filename prefix owned by the startup sweep. */
const SPOOL_PREFIX = 'import-'

interface ConnectionRoute {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
      readonly requestBody: 'buffered' | 'streaming'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * Register the transfer routes.
 * @param ctx - Host context carrying connection, persistence, workspaces,
 *   attachments, and settings.
 */
export function apply(ctx: Context): void {
  const home = dshHomeOf(ctx)
  const cacheRoot = join(home, 'cache', 'prism-transfer')
  const projectsRoot = join(home, 'projects')
  const jobs = new TransferJobStore()
  void sweepSpooledImports(cacheRoot)
  const connection = Reflect.get(ctx, 'connection') as ConnectionRoute
  ctx.effect(() => connection.fetch.register({
    path: TRANSFER_EXPORT_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => exportResponse(ctx, request),
  }), 'prism-transfer: export download')
  ctx.effect(() => connection.fetch.register({
    path: TRANSFER_IMPORT_PATH,
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: request => importResponse(ctx, request, jobs, cacheRoot, projectsRoot),
  }), 'prism-transfer: import upload')
  ctx.effect(() => connection.fetch.register({
    path: TRANSFER_JOB_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => jsonResponse(storeSnapshot(jobs, request)),
  }), 'prism-transfer: job polling')
  ctx.effect(() => connection.fetch.register({
    path: TRANSFER_SETTINGS_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => settingsResponse(ctx, request),
  }), 'prism-transfer: settings application')
}

/** Read the harness home from the boot-provided path helper. */
function dshHomeOf(ctx: Context): string {
  const provider: unknown = Reflect.get(ctx, 'dshHomePath')
  if (typeof provider !== 'function') {
    throw new Error('prism-transfer: the dshHomePath service is required')
  }
  const value: unknown = Reflect.apply(provider, undefined, [])
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('prism-transfer: dshHomePath returned a non-string path')
  }
  return value
}

/** Remove spooled import archives the route owns past their retention. */
async function sweepSpooledImports(cacheRoot: string): Promise<void> {
  let directory
  try {
    directory = await opendir(cacheRoot)
  } catch {
    return
  }
  const now = Date.now()
  try {
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.startsWith(SPOOL_PREFIX)) continue
      const path = join(cacheRoot, entry.name)
      try {
        if (now - (await stat(path)).mtimeMs <= SPOOL_MAX_AGE_MILLISECONDS) continue
      } catch {
        continue
      }
      await rm(path, { force: true })
    }
  } finally {
    // Closing an exhausted directory handle must not mask the sweep outcome.
    await directory.close().catch(() => {})
  }
}

/** Parse the export query into a validated request. */
function exportRequestOf(url: URL): ExportRequest {
  const projects = (url.searchParams.get('projects') ?? '')
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '')
  const flag = (name: string): boolean => {
    const value = url.searchParams.get(name)
    return value === '1' || value === 'true'
  }
  return {
    projectIds: projects,
    includeSettings: flag('settings'),
    includeSecrets: flag('secrets'),
  }
}

/** Answer the streaming export download, or the settings-only JSON. */
async function exportResponse(ctx: Context, request: Request): Promise<Response> {
  const url = new URL(request.url)
  try {
    const parsed = exportRequestOf(url)
    if (parsed.projectIds.length === 0) {
      if (!parsed.includeSettings) {
        throw new TransferError('no-projects', 'select at least one project or include settings')
      }
      const exported = exportSettingsFile(ctx.settings, parsed.includeSecrets)
      return jsonAttachment(`${JSON.stringify(exported.file, null, 2)}\n`, `prism-settings-${stamp()}.json`)
    }
    const deps = transferExportDeps(ctx, {
      get: async (id) => {
        const workspace = ctx.workspaceRegistry.get(brandString<WorkspaceId>(id))
        if (workspace === undefined) return undefined
        return {
          id,
          title: workspace.title,
          path: workspace.path,
          sessionIds: workspace.sessionIds.map(sessionId => String(sessionId)),
        }
      },
    }, ctx.settings)
    const plan = await planTransferExport(deps, parsed, request.signal)
    const filename = exportFilename(plan)
    return new Response(streamTransferZip(transferArchiveEntries(deps, plan, request.signal), request.signal), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': contentDisposition(filename),
      },
    })
  } catch (error: unknown) {
    return failure(error)
  }
}

/** Spool the upload, reserve the job slot, and start the background import. */
async function importResponse(
  ctx: Context,
  request: Request,
  jobs: TransferJobStore,
  cacheRoot: string,
  projectsRoot: string,
): Promise<Response> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/octet-stream') {
    return new Response('content type must be application/octet-stream', { status: 415 })
  }
  const url = new URL(request.url)
  const destinationRoot = url.searchParams.get('dest') ?? projectsRoot
  if (destinationRoot !== projectsRoot && !isAbsolute(destinationRoot)) {
    return new Response('dest must be an absolute path', { status: 400 })
  }
  await mkdir(cacheRoot, { recursive: true })
  const spoolPath = join(cacheRoot, `${SPOOL_PREFIX}${randomUUID()}.zip`)
  let archiveBytes = 0
  try {
    const output = createWriteStream(spoolPath)
    try {
      for await (const chunk of requestBodyChunks(request.body)) {
        archiveBytes += chunk.byteLength
        if (!output.write(chunk)) await once(output, 'drain')
      }
      output.end()
      await once(output, 'finish')
    } catch (error: unknown) {
      output.destroy()
      throw error
    }
    // Reserved synchronously after the spool: one tick cannot hold two slots.
    const reserved = jobs.tryBegin(url.searchParams.get('name') ?? 'archive.zip', archiveBytes)
    if (reserved === undefined) {
      return failure(new TransferError('busy', 'another import is already running'))
    }
    const deps = {
      persistence: ctx.sessionPersistence,
      workspaces: ctx.workspaceRegistry,
      attachments: ctx.attachments,
      settings: ctx.settings,
      homePath: dshHomeOf(ctx),
    }
    void runImport(deps, {
      archivePath: spoolPath,
      archiveBytes,
      destinationRoot,
    }, reserved, request.signal)
      .then((result) => {
        jobs.finish(reserved.jobId, reservedName(url), archiveBytes, {
          projects: result.projects,
          ...(result.settings !== undefined ? { settings: result.settings } : {}),
        })
      })
      .catch((error: unknown) => {
        const typed = asTransferError(error)
        jobs.fail(reserved.jobId, { code: typed.code, detail: typed.message })
      })
      .finally(() => {
        void rm(spoolPath, { force: true }).catch(() => {})
      })
    return jsonResponse({ jobId: reserved.jobId })
  } catch (error: unknown) {
    await rm(spoolPath, { force: true }).catch(() => {})
    if (request.signal.aborted) return new Response('upload cancelled', { status: 499 })
    return failure(error)
  }
}

/** The display name for one import job, bounded and header-safe. */
function reservedName(url: URL): string {
  const raw = url.searchParams.get('name') ?? 'archive.zip'
  const clean = raw.replace(/[\u0000-\u001f]/gu, '').trim()
  return clean === '' ? 'archive.zip' : clean.slice(0, 200)
}

/** Answer one job poll; unknown or foreign ids read as idle. */
function storeSnapshot(jobs: TransferJobStore, request: Request): unknown {
  const url = new URL(request.url)
  const jobId = url.searchParams.get('jobId') ?? ''
  return jobs.snapshot(jobId)
}

/** Apply one uploaded settings document namespace by namespace. */
async function settingsResponse(ctx: Context, request: Request): Promise<Response> {
  let text: string
  try {
    text = await request.text()
  } catch {
    return failure(new TransferError('settings-format', 'request body could not be read'))
  }
  try {
    const outcomes = await applySettingsFile(ctx.settings, parseSettingsText(text))
    return jsonResponse({ results: outcomes })
  } catch (error: unknown) {
    return failure(error)
  }
}

/** Chunk generator over the streaming request body (the file-upload pattern). */
async function* requestBodyChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (body === null) return
  const reader = body.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    reader.releaseLock()
  }
}

/** Attachment headers with an RFC 5987 name for non-ASCII titles. */
function contentDisposition(filename: string): string {
  return `attachment; filename="${sanitizeFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** ASCII fallback name for the classic filename parameter. */
function sanitizeFilename(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_')
  return ascii === '' ? 'archive.zip' : ascii
}

/** Local timestamp for settings filenames. */
function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(now.getFullYear()).padStart(4, '0')}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** JSON attachment for one settings document. */
function jsonAttachment(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': contentDisposition(filename),
    },
  })
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** Map one caught value onto its typed wire refusal. */
function failure(error: unknown): Response {
  const typed = asTransferError(error)
  return new Response(JSON.stringify({ code: typed.code, message: typed.message }), {
    status: typed.status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
