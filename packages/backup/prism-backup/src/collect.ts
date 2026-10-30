/**
 * What one archive contains: the configuration files, the memory store, the
 * workspace registry, and the registered project folders. Collection decides
 * membership and counts before any byte is compressed, records a source that
 * does not exist as absent, and skips unreadable entries with a warning rather
 * than failing the whole backup. Session logs are never collected.
 * @module @prism/prism-backup/collect
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import type { BackupContent } from './config.ts'
import type { BackupCounts } from './types.ts'

/** Archive root every member sits below. */
export const ARCHIVE_ROOT = 'prism-backup'

/** One file copied into the archive. */
export interface PlannedMember {
  /** Absolute source path. */
  readonly path: string
  /** Path inside the archive, always below {@link ARCHIVE_ROOT}. */
  readonly archivePath: string
  /** Source size in bytes. */
  readonly size: number
}

/** Everything one run archives, plus the facts the manifest records. */
export interface BackupPlan {
  readonly members: readonly PlannedMember[]
  readonly counts: BackupCounts
  /** Sources the policy asked for but the machine does not have. */
  readonly absent: readonly string[]
  /** Entries skipped while walking, as human-readable lines. */
  readonly warnings: readonly string[]
}

/** Locations and policy one plan is built from. */
export interface CollectInput {
  /** Harness home (`~/.prism`). */
  readonly home: string
  /** The active profile's patch file, when the launcher supplied one. */
  readonly profilePatch?: string
  /** What to archive. */
  readonly content: BackupContent
}

/**
 * Convert one absolute path to a POSIX archive path segment sequence.
 * @param segments - archive path segments.
 * @returns the joined archive path.
 */
function archivePath(...segments: string[]): string {
  return [ARCHIVE_ROOT, ...segments].join('/')
}

/**
 * One file's planned member, or `undefined` when it does not exist.
 * @param path - absolute source path.
 * @param archive - archive path.
 * @param absent - collects sources that do not exist.
 * @returns the member, or `undefined` for an absent source.
 * @throws {Error} when the path exists but is not a readable regular file.
 */
async function memberOf(
  path: string,
  archive: string,
  absent: string[],
): Promise<PlannedMember | undefined> {
  const info = await stat(path).catch(() => undefined)
  if (info === undefined) {
    absent.push(path)
    return undefined
  }
  if (!info.isFile()) throw new Error(`${path} is not a regular file`)
  return { path, archivePath: archive, size: info.size }
}

/**
 * Walk one directory, skipping excluded path segments, symlinks, and unreadable
 * entries.
 * @param root - absolute directory to walk.
 * @param archiveRoot - archive path its contents are placed under.
 * @param excludes - path segments never entered.
 * @param warnings - collects skipped entries.
 * @returns the walked files, in directory order.
 */
async function walk(
  root: string,
  archiveRoot: string,
  excludes: ReadonlySet<string>,
  warnings: string[],
): Promise<PlannedMember[]> {
  const found: PlannedMember[] = []
  const pending: string[] = [root]
  while (pending.length > 0) {
    const directory = pending.pop() as string
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error: unknown) {
      /* v8 ignore start -- an unreadable directory needs OS-level permissions a portable test cannot arrange. */
      warnings.push(`skipped ${directory}: ${error instanceof Error ? error.message : String(error)}`)
      continue
      /* v8 ignore stop */
    }
    for (const entry of entries) {
      if (excludes.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        warnings.push(`skipped link ${path}`)
        continue
      }
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      // A socket or device node cannot be read as a file and is not part of a backup.
      /* v8 ignore next -- no portable test can present a non-file, non-directory entry */
      if (!entry.isFile()) continue
      try {
        const info = await stat(path)
        const relativePath = relative(root, path).split(sep).join('/')
        found.push({ path, archivePath: `${archiveRoot}/${relativePath}`, size: info.size })
      } catch (error: unknown) {
        /* v8 ignore start -- only a file removed between readdir and stat reaches this. */
        warnings.push(`skipped ${path}: ${error instanceof Error ? error.message : String(error)}`)
        /* v8 ignore stop */
      }
    }
  }
  return found.sort((left, right) => left.archivePath.localeCompare(right.archivePath))
}

/**
 * Read the registered project folder paths out of a workspace registry
 * document. A malformed document yields no folders and a warning; a backup
 * never fails because the registry changed shape.
 * @param text - registry file contents.
 * @param warnings - collects the parse problem.
 * @returns absolute folder paths in registry order.
 */
export function projectPathsOf(text: string, warnings: string[]): readonly string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    /* v8 ignore next -- JSON.parse rejects only with a SyntaxError. */
    warnings.push(`workspace registry unreadable: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const tables = (parsed as { readonly tables?: unknown }).tables
  if (typeof tables !== 'object' || tables === null) return []
  const workspaces = (tables as { readonly workspaces?: unknown }).workspaces
  if (typeof workspaces !== 'object' || workspaces === null) return []
  const paths: string[] = []
  for (const value of Object.values(workspaces as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const path = (value as { readonly path?: unknown }).path
    if (typeof path === 'string' && path !== '') paths.push(path)
  }
  return paths
}

/**
 * Plan one archive: which files, how many, and which sources were absent.
 * @param input - home, optional profile patch, and content policy.
 * @returns the plan the archiver writes.
 */
export async function planBackup(input: CollectInput): Promise<BackupPlan> {
  const absent: string[] = []
  const warnings: string[] = []
  const members: PlannedMember[] = []
  let settings = 0
  let memoryFiles = 0
  let projectFiles = 0
  let projects = 0

  if (input.content.settings) {
    const candidates: readonly (readonly [string, string])[] = [
      ...(input.profilePatch === undefined
        ? []
        : [[input.profilePatch, archivePath('settings', 'profile-cordis.patch.yml')] as const]),
      [join(input.home, 'cordis.patch.yml'), archivePath('settings', 'home-cordis.patch.yml')] as const,
      [join(input.home, '.env'), archivePath('settings', 'env')] as const,
      [join(input.home, '.credentials.yaml'), archivePath('settings', 'credentials.yaml')] as const,
    ]
    for (const [path, archive] of candidates) {
      const member = await memberOf(path, archive, absent)
      if (member === undefined) continue
      members.push(member)
      settings += 1
    }
  }

  if (input.content.memory) {
    const memoryRoot = join(input.home, 'storages', 'prism_memory')
    const exists = await stat(memoryRoot).then(info => info.isDirectory(), () => false)
    if (!exists) {
      absent.push(memoryRoot)
    } else {
      const walked = await walk(memoryRoot, archivePath('memory', 'prism_memory'), new Set(), warnings)
      members.push(...walked)
      memoryFiles = walked.length
    }
  }

  if (input.content.projects) {
    const registryPath = join(input.home, 'storages', 'workspace.json')
    const { member, paths } = await readRegistry(registryPath, absent, warnings)
    if (member !== undefined) members.push(member)
    const seen = new Set<string>()
    for (const path of paths) {
      const key = path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const info = await stat(path).catch(() => undefined)
      if (info === undefined || !info.isDirectory()) {
        warnings.push(`project folder missing: ${path}`)
        continue
      }
      /* v8 ignore next -- every registered path has a base name; the fallback names an empty root. */
      const folder = `${String(projects)}-${basename(path) || 'project'}`
      const walked = await walk(path, archivePath('projects', folder), input.content.excludes, warnings)
      members.push(...walked)
      projectFiles += walked.length
      projects += 1
    }
  }

  return {
    members,
    counts: { settings, memoryFiles, projects, projectFiles },
    absent,
    warnings,
  }
}

/**
 * Read and plan the workspace registry member.
 * @param registryPath - absolute registry path.
 * @param absent - collects the registry when missing.
 * @param warnings - collects parse problems.
 * @returns the registry member and the project paths it names.
 */
async function readRegistry(
  registryPath: string,
  absent: string[],
  warnings: string[],
): Promise<{ member?: PlannedMember; paths: readonly string[] }> {
  const info = await stat(registryPath).catch(() => undefined)
  if (info === undefined) {
    absent.push(registryPath)
    return { paths: [] }
  }
  const text = await readFile(registryPath, 'utf8')
  return {
    member: { path: registryPath, archivePath: archivePath('workspace', 'registry.json'), size: info.size },
    paths: projectPathsOf(text, warnings),
  }
}
