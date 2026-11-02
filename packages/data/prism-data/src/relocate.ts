/**
 * Harness-home relocation: prove a destination is usable, copy the current
 * home into it, and report what could not be copied. The source is only ever
 * read — a relocation never deletes or rewrites the home it came from.
 *
 * @module @prism/prism-data/relocate
 */

import { copyFile, lstat, mkdir, readdir, readlink, rm, stat, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DataError, messageOf } from './errors.ts'

/** Top-level directories a copy skips: rebuildable caches, not user data. */
const SKIPPED_TOP_LEVEL: ReadonlySet<string> = new Set(['cache'])

/** What one copy produced, before it is recorded as a relocation. */
export interface CopyReport {
  /** Regular files copied. */
  readonly files: number
  /** Total size of those files, in bytes. */
  readonly bytes: number
  /** Absolute paths of links that were not recreated. */
  readonly skippedLinks: readonly string[]
}

/**
 * Prove a destination may receive the home.
 * @param source - absolute home being copied.
 * @param requested - destination as the operator supplied it.
 * @returns the normalized absolute destination.
 * @throws {DataError} `target-invalid` when the destination is relative, is the
 *   home itself, sits inside the home, or contains the home.
 */
export function resolveTarget(source: string, requested: string): string {
  if (requested.trim() === '' || !isAbsolute(requested)) {
    throw new DataError('prism-data/target-invalid', 'The destination must be an absolute path.')
  }
  const from = resolve(source)
  const to = resolve(requested)
  if (to === from) throw new DataError('prism-data/target-invalid', 'The destination is the current data directory.')
  if (isWithin(to, from)) throw new DataError('prism-data/target-invalid', 'The destination sits inside the current data directory.')
  if (isWithin(from, to)) throw new DataError('prism-data/target-invalid', 'The destination contains the current data directory.')
  return to
}

/**
 * Whether one path sits below another.
 * @param candidate - path to test.
 * @param ancestor - path that must contain it.
 * @returns true when `candidate` resolves inside `ancestor`.
 */
function isWithin(candidate: string, ancestor: string): boolean {
  const step = relative(resolve(ancestor), resolve(candidate))
  return step !== '' && !step.startsWith('..') && !isAbsolute(step)
}

/**
 * Prove a destination is absent or an empty directory.
 * @param target - absolute destination from {@link resolveTarget}.
 * @throws {DataError} `target-not-empty` when something already occupies it,
 *   `target-invalid` when it cannot be inspected.
 */
export async function prepareTarget(target: string): Promise<void> {
  try {
    const facts = await lstat(target)
    if (!facts.isDirectory()) throw new DataError('prism-data/target-not-empty', `${target} is not a directory.`)
    const [first] = await readdir(target)
    if (first !== undefined) throw new DataError('prism-data/target-not-empty', `${target} is not empty.`)
  } catch (error: unknown) {
    if (error instanceof DataError) throw error
    /* v8 ignore next 4 -- an absent destination reports ENOENT; any other failure needs a denied or cyclic anchor */
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new DataError('prism-data/target-invalid', `Cannot inspect ${target}: ${messageOf(error)}`)
    }
  }
}

/**
 * Copy one harness home into an empty destination.
 *
 * Directories are created as they are met, regular files are copied verbatim,
 * and links are recreated pointing at the same target; a link the platform
 * refuses to recreate is reported instead of failing the copy. The top-level
 * `cache` directory is skipped.
 * @param source - absolute home to copy.
 * @param target - absolute, empty destination.
 * @returns counts and the links that were not recreated.
 */
export async function copyHome(source: string, target: string): Promise<CopyReport> {
  const report = { files: 0, bytes: 0, skippedLinks: [] as string[] }
  await mkdir(target, { recursive: true })
  const pending: Array<readonly [string, string]> = [[source, target]]
  while (pending.length > 0) {
    const next = pending.pop()
    /* v8 ignore next -- the loop condition guarantees a pending pair */
    if (next === undefined) break
    const [from, to] = next
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const sourcePath = join(from, entry.name)
      const targetPath = join(to, entry.name)
      const facts = await lstat(sourcePath)
      if (facts.isSymbolicLink()) {
        await copyLink(sourcePath, targetPath, report)
        continue
      }
      if (facts.isDirectory()) {
        if (from === source && SKIPPED_TOP_LEVEL.has(entry.name)) continue
        await mkdir(targetPath)
        pending.push([sourcePath, targetPath])
        continue
      }
      // Sockets, pipes, and devices are not harness data and have no copy;
      // no test creates one, because the portable API cannot.
      /* v8 ignore next 2 -- non-file entries need mkfifo or a device node */
      if (!facts.isFile()) continue
      await copyFile(sourcePath, targetPath)
      report.files += 1
      report.bytes += facts.size
    }
  }
  return report
}

/**
 * Recreate one link at the destination, or report why it was skipped.
 *
 * The link is spelled absolutely so it still resolves at the new root, and a
 * directory link is created as a junction: a Windows junction takes an
 * absolute target, and every other platform ignores the type argument. A
 * platform that refuses the form — a file target on Windows — leaves the link
 * in the report instead of failing the copy.
 * @param sourcePath - link in the home being copied.
 * @param targetPath - where the link belongs in the destination.
 * @param report - report receiving a skip.
 * @returns nothing; a refused or dangling link is recorded, not thrown.
 */
async function copyLink(sourcePath: string, targetPath: string, report: { skippedLinks: string[] }): Promise<void> {
  const linkText = await readlink(sourcePath)
  const resolved = resolve(dirname(sourcePath), linkText)
  try {
    await stat(resolved)
  } catch (_danglingLink) {
    report.skippedLinks.push(sourcePath)
    return
  }
  try {
    await symlink(resolved, targetPath, 'junction')
  } catch (_linkRefused) {
    /* v8 ignore next 2 -- a refusal needs a platform that rejects the junction form */
    report.skippedLinks.push(sourcePath)
  }
}

/**
 * Remove a partial destination after a failed copy, keeping the original
 * failure as the one the caller reports.
 * @param path - destination directory to remove.
 */
export async function discardPartialCopy(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
  } catch (_partialCopyRetained) {
    // The failure report still names the destination; a leftover tree never
    // hides what went wrong.
  }
}
