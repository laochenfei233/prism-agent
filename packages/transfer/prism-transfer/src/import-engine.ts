/**
 * Import engine: turns one spooled transfer archive back into projects,
 * sessions, attachments, and settings — never overwriting anything.
 *
 * The archive is validated through the house zip reader (central directory,
 * per-entry CRC), extracted into a same-volume staging directory, published
 * with one atomic rename per project, and its sessions restored through
 * `SessionPersistence` with the projection checkpoint that makes titles
 * appear in the cold sidebar list. Media and files never materialize under
 * the staging tree: their entry names carry `sha256:` colons that Windows
 * cannot store, so they stream straight into the attachment seam, whose
 * returned content addresses are checked against the names the archive
 * itself claims.
 *
 * @module @prism/prism-transfer/import-engine
 */

import { existsSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, opendir, rename, rm, stat, statfs } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { ZipArchiveReader, type ZipEntry } from './zip-reader.ts'
import { TransferError } from './errors.ts'
import { sanitizeProjectDirectoryName, uniqueDirectoryName } from './naming.ts'
import { applySettingsFile, parseSettingsText, type SettingsTransferDeps } from './settings-transfer.ts'
import type { TransferJobProgress } from './job.ts'
import {
  parseProjectManifest,
  parseTransferManifest,
  PROJECT_FOLDER_PREFIX,
  PROJECT_MANIFEST_NAME,
  SESSIONS_FOLDER_PREFIX,
  SETTINGS_ENTRY_NAME,
  TRANSFER_MANIFEST_NAME,
  type ImportedProjectResult,
  type PrismProjectManifest,
  type SettingsApplyOutcome,
} from './types.ts'

/** Session writer surface used by the engine (the `session-import` recipe). */
export interface ImportSessionHandle {
  /** Append the session's contiguous event batch. */
  append(events: readonly SessionEvent[]): Promise<void>
  /** Make the batch durable. */
  flush(): Promise<void>
  /** Release write ownership. */
  close(): Promise<void>
}

/** Persistence surface used by the engine. */
export interface ImportPersistence {
  /** Whether a session id already exists. */
  stat(id: SessionId): Promise<unknown>
  /** Create one stored session and take write ownership. */
  create(header: SessionHeader): Promise<ImportSessionHandle>
}

/** Workspace surface used by the engine (create resolves or creates). */
export interface ImportWorkspace {
  /** Stored workspace id. */
  readonly id: string
  /** Add one session to this workspace's account. */
  attachSession(id: SessionId): Promise<void>
}

/** Workspace registry surface used by the engine. */
export interface ImportWorkspaces {
  /** Create or return the workspace for one absolute path. */
  create(path: string): Promise<ImportWorkspace>
}

/** Attachment seam subset the engine restores through. */
export interface ImportAttachments {
  /** Deployment image policy used for media entry pre-checks. */
  readonly imageLimits: { readonly maxImageBytes: number }
  /**
   * Commit one normalized image.
   * @param input - normalized bytes and declared media type.
   * @returns the durable reference whose id must match the archive entry.
   */
  saveImage(input: { data: Uint8Array; mediaType: ImageMediaType }): Promise<{ readonly attachmentId: string }>
  /**
   * Commit one verbatim file from bounded chunks.
   * @param input - ordered chunks and the display name.
   * @returns the durable reference whose id must match the archive entry.
   */
  saveFileStream(input: {
    data: AsyncIterable<Uint8Array>
    name: string
  }): Promise<{ readonly attachmentId: string }>
}

/**
 * Projection-cache fold that makes one written log readable as a cold list
 * row (the same recipe `prism-session-import` uses).
 */
export interface ImportProjections {
  /**
   * Fold one complete stored log into the durable projection cache.
   * @param header - the stored Session header.
   * @param events - the Session's complete log in seq order.
   */
  checkpoint(header: SessionHeader, events: readonly SessionEvent[]): Promise<void>
}

/** Engine dependencies supplied by the host plugin. */
export interface TransferImportDeps {
  /** Durable session writer. */
  readonly persistence: ImportPersistence
  /** Live workspace registry. */
  readonly workspaces: ImportWorkspaces
  /** Attachment seam. */
  readonly attachments: ImportAttachments
  /** Settings read/write surface for embedded settings documents. */
  readonly settings: SettingsTransferDeps
  /** Harness home, for the reserved publication-target guard. */
  readonly homePath: string
  /** Cold-list projection fold; absent compositions list rows until opened. */
  readonly projections?: ImportProjections
}

/** One spooled archive ready to import. */
export interface ImportJobInput {
  /** Spooled archive path on disk. */
  readonly archivePath: string
  /** Archive byte length. */
  readonly archiveBytes: number
  /** Validated absolute destination root (created when missing). */
  readonly destinationRoot: string
}

/** Result of one finished import run. */
export interface ImportRunResult {
  readonly kind: 'project' | 'combined'
  readonly projects: readonly ImportedProjectResult[]
  readonly settings?: readonly SettingsApplyOutcome[]
}

/** Free space required beyond the archive before extraction starts. */
const FREE_SPACE_MARGIN_BYTES = 2 ** 30
/** Extraction aborts once written bytes fall within this of the start free space. */
const EXTRACTION_FLOOR_BYTES = 512 * 2 ** 20
/** How long a staging directory may sit before the sweep removes it. */
const STAGING_MAX_AGE_MILLISECONDS = 24 * 60 * 60 * 1000
/** Prefix reservation the sweep is allowed to remove. */
export const STAGING_PREFIX = '.prism-import-'
/** Directly-under-home names a publication target may never take. */
const RESERVED_HOME_CHILDREN: ReadonlySet<string> = new Set([
  'sessions', 'storages', 'attachments', 'cache', 'profiles', 'plugins', 'credentials', 'logs', 'skills', 'projects',
])
/** Zip extension → declared image media type. */
const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}
/** Text-entry caps: documents are small; session logs may legitimately be huge. */
const DOCUMENT_MAX_BYTES = 16 * 2 ** 20
const LOG_MAX_BYTES = 256 * 2 ** 20

/** Whether a value is a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a string is one lowercase 64-hex sha256 digest. */
const isSha256Hex = (value: string): boolean => /^[a-f0-9]{64}$/u.test(value)

/** The canonical session-log filename the exporter writes. */
const SESSION_LOG_BASENAME = `session.v${String(SESSION_FORMAT_VERSION)}.jsonl`

/** One project's restore plan derived from the archive scan. */
interface ProjectPlan {
  readonly manifest: PrismProjectManifest
  /** Archive prefix holding this project's entries. */
  readonly prefix: string
  readonly folderEntries: readonly ZipEntry[]
  readonly mainLogs: readonly ZipEntry[]
  readonly subLogs: readonly ZipEntry[]
  readonly media: readonly ZipEntry[]
  readonly files: readonly ZipEntry[]
}

/** Parse JSON document text with a typed refusal. */
function parseDocument(text: string, entry: ZipEntry): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new TransferError('bad-archive', `entry "${entry.name}" is not valid JSON`)
  }
}

/** Read one entry's full text with a size cap. */
async function readEntryText(
  reader: ZipArchiveReader,
  entry: ZipEntry,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of reader.bytes(entry, signal)) {
    bytes += chunk.byteLength
    if (bytes > maximumBytes) {
      throw new TransferError('entry-too-large', `entry "${entry.name}" is too large to read`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

/**
 * Parse and validate one serialized session log from the archive.
 * @param text - the log's JSONL text.
 * @returns the rebuilt header and events.
 */
function parseLogText(text: string): { header: SessionHeader; events: readonly SessionEvent[] } {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const headerLine = lines.at(0)
  if (headerLine === undefined || lines.length < 2) {
    throw new TransferError('bad-archive', 'session log has no events')
  }
  let headerRecord: unknown
  try {
    headerRecord = JSON.parse(headerLine)
  } catch {
    throw new TransferError('bad-archive', 'session log header is not valid JSON')
  }
  if (!isRecord(headerRecord) || headerRecord['type'] !== 'session') {
    throw new TransferError('bad-archive', 'session log does not open with a session header')
  }
  const id = headerRecord['id']
  if (typeof id !== 'string' || id === '') {
    throw new TransferError('bad-archive', 'session header carries no id')
  }
  if (headerRecord['version'] !== SESSION_FORMAT_VERSION) {
    throw new TransferError(
      'session-version',
      `session format version ${String(headerRecord['version'])} is not supported for import`,
    )
  }
  const events: SessionEvent[] = []
  for (const line of lines.slice(1)) {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      throw new TransferError('bad-archive', 'session log event is not valid JSON')
    }
    if (!isRecord(record) || typeof record['type'] !== 'string'
      || typeof record['seq'] !== 'number' || typeof record['time'] !== 'number'
      || record['data'] === undefined) {
      throw new TransferError('bad-archive', 'malformed session event envelope')
    }
    events.push(record as SessionEvent)
  }
  const createdAt = typeof headerRecord['createdAt'] === 'number' && headerRecord['createdAt'] > 0
    ? headerRecord['createdAt']
    : Date.now()
  const cwd = headerRecord['cwd']
  const parentSession = headerRecord['parentSession']
  const origin = headerRecord['origin']
  const agentPreset = headerRecord['agentPreset']
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: brandString<SessionId>(id),
    createdAt,
    isSeeded: headerRecord['isSeeded'] === true,
    delegationDepth: typeof headerRecord['delegationDepth'] === 'number' ? headerRecord['delegationDepth'] : 0,
    ...(typeof cwd === 'string' ? { cwd } : {}),
    ...(typeof parentSession === 'string' ? { parentSession: brandString<SessionId>(parentSession) } : {}),
    ...(origin === 'subagent' ? { origin } : {}),
    ...(typeof agentPreset === 'string' ? { agentPreset } : {}),
  }
  return { header, events }
}

/**
 * Restore one parsed log, counting duplicates, and fold it into the
 * projection cache so the sidebar list serves its title.
 */
async function restoreLog(
  deps: TransferImportDeps,
  header: SessionHeader,
  events: readonly SessionEvent[],
  progress: TransferJobProgress,
): Promise<'restored' | 'duplicate'> {
  if (await deps.persistence.stat(header.id) !== undefined) {
    progress.addDuplicates(1)
    progress.addSessionsDone(1)
    return 'duplicate'
  }
  const handle = await deps.persistence.create(header)
  try {
    await handle.append(events)
    await handle.flush()
  } catch (error: unknown) {
    throw new TransferError(
      'bad-archive',
      `session "${String(header.id)}" could not be written: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    await handle.close()
  }
  if (deps.projections !== undefined) {
    try {
      await deps.projections.checkpoint(header, events)
    } catch {
      // The log is durable and authoritative; a failed fold only costs the
      // cold list's cached title until the next open.
    }
  }
  progress.addSessionsDone(1)
  return 'restored'
}

/**
 * Validate one media entry name and return its attachment id and media type.
 * @param entry - the archive entry under the sessions media directory.
 * @returns the expected attachment id and declared media type.
 */
function mediaEntryFacts(entry: ZipEntry): { attachmentId: string; mediaType: ImageMediaType } {
  const name = entry.name.slice(entry.name.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) throw new TransferError('bad-archive', `media entry "${entry.name}" carries no extension`)
  const attachmentId = name.slice(0, dot)
  const mediaType = MEDIA_TYPES[name.slice(dot + 1).toLowerCase()]
  if (mediaType === undefined || !attachmentId.startsWith('sha256:') || !isSha256Hex(attachmentId.slice('sha256:'.length))) {
    throw new TransferError('bad-archive', `media entry "${entry.name}" is not a content-addressed image`)
  }
  return { attachmentId, mediaType }
}

/**
 * Restore every media and file entry of one project through the attachment
 * seam, checking each returned content address against the archive layout.
 */
async function restoreAttachments(
  deps: TransferImportDeps,
  plan: ProjectPlan,
  reader: ZipArchiveReader,
  progress: TransferJobProgress,
  signal?: AbortSignal,
): Promise<void> {
  for (const entry of plan.media) {
    signal?.throwIfAborted()
    const { attachmentId, mediaType } = mediaEntryFacts(entry)
    if (entry.uncompressedSize > deps.attachments.imageLimits.maxImageBytes) {
      throw new TransferError('entry-too-large', `media entry "${entry.name}" exceeds this deployment's image limit`)
    }
    const chunks: Uint8Array[] = []
    for await (const chunk of reader.bytes(entry, signal)) chunks.push(chunk)
    const data = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
    progress.addBytes(data.byteLength)
    let ref: { readonly attachmentId: string }
    try {
      ref = await deps.attachments.saveImage({ data, mediaType })
    } catch (error: unknown) {
      throw new TransferError(
        'attachment-failed',
        `media entry "${entry.name}" could not be stored: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (String(ref.attachmentId) !== attachmentId) {
      throw new TransferError('attachment-mismatch', `media entry "${entry.name}" stored under a different content address`)
    }
  }
  for (const entry of plan.files) {
    signal?.throwIfAborted()
    const digest = entry.name.split('/').at(-2)
    const name = entry.name.split('/').at(-1)
    if (digest === undefined || name === undefined || name === '' || !isSha256Hex(digest)) {
      throw new TransferError('bad-archive', `file entry "${entry.name}" is not content-addressed`)
    }
    // The reader CRC-verifies every chunk as it streams; the seam computes
    // its own digest, so tampered bytes fail below instead of publishing.
    const ref = await deps.attachments.saveFileStream({ data: reader.bytes(entry, signal), name })
    progress.addBytes(entry.uncompressedSize)
    progress.addFiles(1)
    if (String(ref.attachmentId) !== `sha256:${digest}`) {
      throw new TransferError('attachment-mismatch', `file entry "${entry.name}" stored under a different content address`)
    }
  }
}

/**
 * Refuse a materialized path whose name carries a colon: on Windows a colon
 * after an existing name silently writes an NTFS alternate data stream, so a
 * hostile `project/a:b` entry ordered after `project/a` would pollute a
 * published file invisibly. The reader allows final-segment colons because
 * attachment entries stream into the seam and never touch the filesystem;
 * only `project/**` entries reach this check.
 * @param relative - the entry's path below the project staging root.
 * @param entryName - the full archive name, for the error message.
 */
function refuseColons(relative: string, entryName: string): void {
  if (relative.split('/').some(segment => segment.includes(':'))) {
    throw new TransferError('unsafe-path', `entry "${entryName}" carries a colon and cannot be written to disk`)
  }
}

/** Whether one publication target collides with the harness home's own layout. */
function publicationReserved(publishPath: string, homePath: string): boolean {
  const target = resolve(publishPath)
  const home = resolve(homePath)
  if (target === home) return true
  return resolve(target, '..') === home && RESERVED_HOME_CHILDREN.has(basename(target).toLowerCase())
}

/**
 * Sweep stale staging directories the sweep prefix owns.
 * @param destinationRoot - directory whose staging residue is swept.
 * @param options - clock and age overrides for tests.
 * @returns how many directories were removed.
 */
export async function sweepStaleStaging(
  destinationRoot: string,
  options: { now?: number; maxAgeMilliseconds?: number } = {},
): Promise<number> {
  const now = options.now ?? Date.now()
  const maximumAge = options.maxAgeMilliseconds ?? STAGING_MAX_AGE_MILLISECONDS
  let removed = 0
  let directory
  try {
    directory = await opendir(destinationRoot)
  } catch {
    return 0
  }
  try {
    for await (const entry of directory) {
      if (!entry.name.startsWith(STAGING_PREFIX) || !entry.isDirectory()) continue
      const path = join(destinationRoot, entry.name)
      try {
        if (now - (await stat(path)).mtimeMs <= maximumAge) continue
      } catch {
        // v8 ignore next 1 -- the entry was just listed by readdir; no Windows composition makes its stat fail between the two calls
        continue
      }
      await rm(path, { recursive: true, force: true })
      removed += 1
    }
  } finally {
    // Closing an exhausted directory handle must not mask the sweep outcome.
    await directory.close().catch(() => {})
  }
  return removed
}

/** Free space over the destination volume, or `undefined` where unavailable. */
async function freeBytes(destinationRoot: string): Promise<number | undefined> {
  try {
    const stats = await statfs(destinationRoot)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    // Some network paths cannot report free space; the guard is best-effort.
    // v8 ignore next 1 -- statfs runs on the destination created one line earlier; only a volume vanishing mid-import can refuse it
    return undefined
  }
}

/**
 * Run one import to completion.
 * @param deps - engine dependencies.
 * @param input - the spooled archive and destination.
 * @param progress - job progress sink.
 * @param signal - cancellation observed between steps.
 * @returns the per-project and settings outcomes.
 */
export async function runImport(
  deps: TransferImportDeps,
  input: ImportJobInput,
  progress: TransferJobProgress,
  signal?: AbortSignal,
): Promise<ImportRunResult> {
  if (!isAbsolute(input.destinationRoot)) {
    throw new TransferError('bad-destination', 'the destination must be an absolute path')
  }
  await mkdir(input.destinationRoot, { recursive: true })
  await sweepStaleStaging(input.destinationRoot)
  const reader = await ZipArchiveReader.open(input.archivePath)
  const stagingRoot = join(input.destinationRoot, `${STAGING_PREFIX}${randomBytes(8).toString('hex')}`)
  try {
    progress.setPhase('validating')
    const { kind, plans, settingsEntry } = await dispatchArchive(reader, progress, signal)
    const projects = plans.map(plan => ({
      plan,
      stagingPath: join(stagingRoot, sanitizeProjectDirectoryName(plan.manifest.title, 'project')),
      path: '',
      sessions: [] as SessionId[],
      duplicates: 0,
    }))
    progress.setSessionsTotal(plans.reduce((sum, plan) => sum + plan.mainLogs.length + plan.subLogs.length, 0))
    progress.setProjectsTotal(projects.length)
    const startFree = await freeBytes(input.destinationRoot)
    if (startFree !== undefined && startFree < input.archiveBytes + FREE_SPACE_MARGIN_BYTES) {
      throw new TransferError(
        'disk-space',
        `the destination volume needs ${String(input.archiveBytes + FREE_SPACE_MARGIN_BYTES)} free bytes`,
      )
    }
    // v8 ignore next 1 -- freeBytes only reports undefined for a volume that vanishes mid-import, unreachable once the destination exists
    const extractionFloor = startFree === undefined ? undefined : startFree - EXTRACTION_FLOOR_BYTES
    let written = 0

    progress.setPhase('extracting')
    for (const project of projects) {
      signal?.throwIfAborted()
      await mkdir(project.stagingPath, { recursive: true })
      if (!project.plan.manifest.hasProjectFolder) continue
      for (const entry of project.plan.folderEntries) {
        const relative = entry.name.slice(project.plan.prefix.length + PROJECT_FOLDER_PREFIX.length)
        refuseColons(relative, entry.name)
        const target = join(project.stagingPath, relative)
        await mkdir(resolve(target, '..'), { recursive: true })
        const output = createWriteStream(target)
        try {
          for await (const chunk of reader.bytes(entry, signal)) {
            written += chunk.byteLength
            progress.addBytes(chunk.byteLength)
            // v8 ignore next 2 -- trips only when a real destination volume fills mid-extraction; no test can shrink a volume
            if (extractionFloor !== undefined && written > extractionFloor) {
              throw new TransferError('disk-space', 'extraction aborted: the destination volume filled up')
            }
            if (!output.write(chunk)) await once(output, 'drain')
          }
          output.end()
          await once(output, 'finish')
        } catch (error: unknown) {
          output.destroy()
          throw error
        }
        progress.addFiles(1)
      }
    }

    progress.setPhase('restoring')
    for (const project of projects) {
      signal?.throwIfAborted()
      for (const logEntry of [...project.plan.mainLogs, ...project.plan.subLogs]) {
        const text = await readEntryText(reader, logEntry, LOG_MAX_BYTES, signal)
        const parsed = parseLogText(text)
        const outcome = await restoreLog(deps, parsed.header, parsed.events, progress)
        if (outcome === 'restored') project.sessions.push(parsed.header.id)
        else project.duplicates += 1
      }
      await restoreAttachments(deps, project.plan, reader, progress, signal)
    }

    let settings: readonly SettingsApplyOutcome[] | undefined
    if (settingsEntry !== undefined) {
      progress.setPhase('applying-settings')
      const text = await readEntryText(reader, settingsEntry, DOCUMENT_MAX_BYTES, signal)
      settings = await applySettingsFile(deps.settings, parseSettingsText(text))
    }

    progress.setPhase('registering')
    const results: ImportedProjectResult[] = []
    for (const project of projects) {
      signal?.throwIfAborted()
      const finalName = uniqueDirectoryName(
        candidate => !publicationReserved(join(input.destinationRoot, candidate), deps.homePath)
          && !existsSync(join(input.destinationRoot, candidate)),
        sanitizeProjectDirectoryName(project.plan.manifest.title, 'project'),
      )
      project.path = join(input.destinationRoot, finalName)
      // Publication renames the complete staging directory; a failure here is
      // loud, never a half-published destination entry.
      await rename(project.stagingPath, project.path)
      const registerErrors: string[] = []
      try {
        const workspace = await deps.workspaces.create(project.path)
        for (const sessionId of project.sessions) {
          try {
            await workspace.attachSession(sessionId)
          } catch (error: unknown) {
            registerErrors.push(`session "${String(sessionId)}" could not attach: ${
              error instanceof Error ? error.message : String(error)}`)
          }
        }
      } catch (error: unknown) {
        registerErrors.push(`workspace registration failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      results.push({
        name: finalName,
        path: project.path,
        sessions: project.sessions.length,
        duplicates: project.duplicates,
        ...(registerErrors.length > 0 ? { registerError: registerErrors.join('; ') } : {}),
      })
      progress.addProjectDone(1)
    }
    return { kind, projects: results, ...(settings !== undefined ? { settings } : {}) }
  } finally {
    await reader.close()
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

/** Scan the archive into per-project restore plans. */
async function dispatchArchive(
  reader: ZipArchiveReader,
  progress: TransferJobProgress,
  signal?: AbortSignal,
): Promise<{
  kind: 'project' | 'combined'
  plans: ProjectPlan[]
  settingsEntry: ZipEntry | undefined
}> {
  const projectManifestEntry = reader.entryByName(PROJECT_MANIFEST_NAME)
  const transferManifestEntry = reader.entryByName(TRANSFER_MANIFEST_NAME)
  if (projectManifestEntry !== undefined) {
    const manifest = parseProjectManifest(
      parseDocument(await readEntryText(reader, projectManifestEntry, DOCUMENT_MAX_BYTES, signal), projectManifestEntry),
    )
    progress.setKind('project')
    return { kind: 'project', plans: [await planProject(reader, manifest, '')], settingsEntry: undefined }
  }
  if (transferManifestEntry === undefined) {
    throw new TransferError('bad-manifest', 'archive carries no prism transfer manifest')
  }
  const manifest = parseTransferManifest(
    parseDocument(await readEntryText(reader, transferManifestEntry, DOCUMENT_MAX_BYTES, signal), transferManifestEntry),
  )
  progress.setKind('combined')
  const plans: ProjectPlan[] = []
  for (const project of manifest.projects) {
    const childManifest = reader.entryByName(`projects/${project.dir}/${PROJECT_MANIFEST_NAME}`)
    if (childManifest === undefined) {
      throw new TransferError('bad-manifest', `combined archive child "${project.dir}" carries no manifest`)
    }
    const parsed = parseProjectManifest(
      parseDocument(await readEntryText(reader, childManifest, DOCUMENT_MAX_BYTES, signal), childManifest),
    )
    plans.push(await planProject(reader, parsed, `projects/${project.dir}/`))
  }
  if (plans.length === 0) throw new TransferError('no-projects', 'combined archive names no projects')
  const settingsEntry = manifest.settings ? reader.entryByName(SETTINGS_ENTRY_NAME) : undefined
  if (manifest.settings && settingsEntry === undefined) {
    throw new TransferError('bad-manifest', 'combined manifest declares settings but the archive has none')
  }
  return { kind: 'combined', plans, settingsEntry }
}

/** Collect one project's entries by role from the reader. */
async function planProject(
  reader: ZipArchiveReader,
  manifest: PrismProjectManifest,
  prefix: string,
): Promise<ProjectPlan> {
  const folderEntries: ZipEntry[] = []
  const mainLogs: ZipEntry[] = []
  const subLogs: ZipEntry[] = []
  const media: ZipEntry[] = []
  const files: ZipEntry[] = []
  for (const entry of reader.entries) {
    if (!entry.name.startsWith(prefix)) continue
    const local = entry.name.slice(prefix.length)
    if (local.startsWith(PROJECT_FOLDER_PREFIX)) {
      // v8 ignore next 1 -- the reader refuses trailing-slash entry names, so no directory record can reach this check
      if (!entry.directory) folderEntries.push(entry)
      continue
    }
    if (local.startsWith(SESSIONS_FOLDER_PREFIX)) {
      const relative = local.slice(SESSIONS_FOLDER_PREFIX.length)
      if (relative.endsWith(`/${SESSION_LOG_BASENAME}`)) {
        if (relative.includes('/subagents/')) subLogs.push(entry)
        else mainLogs.push(entry)
        continue
      }
      if (relative.includes('/media/')) media.push(entry)
      else if (relative.includes('/files/')) files.push(entry)
    }
  }
  return { manifest, prefix, folderEntries, mainLogs, subLogs, media, files }
}
