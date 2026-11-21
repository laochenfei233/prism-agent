// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
/**
 * Git operations behind the workbench routes: locate the repository, read its
 * status and one file's comparison, and stage, unstage, or commit.
 *
 * Every command runs through the shared {@link GitCommandRunner}, which supplies the
 * scrubbed environment, timeout, and output cap. Paths are validated against
 * the repository root before they reach a command, and a failed command
 * carries its stderr tail to the route, which reports it.
 */
import { isAbsolute, normalize, resolve } from 'node:path'
import type { GitRunOptions, GitRunResult } from '@deepseek-ai/dsh-workspace-changes'

/** The one method these operations need from the shared git runner; a real run and a scripted one both satisfy it. */
export interface GitCommandRunner {
  /**
   * Run one git command to completion.
   * @param args - git arguments, never shell-interpreted.
   * @param options - working directory, environment, stdin, output cap, and cancellation.
   * @returns exit facts and collected output.
   */
  run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult>
}
import type { GitDiff, GitFileEntry, GitHunk, GitSide } from './contract.ts'

/** The status fields a repository root yields, before the route adds availability. */
export interface RepositoryStatus {
  branch?: string
  behind?: number
  ahead?: number
  entries: GitFileEntry[]
}

/** A git command that left a nonzero status, reported with its stderr tail. */
export class GitCommandError extends Error {
  /**
   * @param what - the operation that failed.
   * @param stderr - the command's retained stderr.
   */
  constructor(what: string, stderr: string) {
    super(`${what} failed: ${stderr.trim()}`)
    this.name = 'GitCommandError'
  }
}

const NOT_A_REPOSITORY = /not a git repository/i
const BINARY_DIFF = /^Binary files .* differ$/m
/**
 * Treat every pathspec literally. Without this, a path such as `[ab].txt` is a
 * glob and a command would act on files the reader never selected.
 */
const LITERAL_PATHSPECS: Readonly<Record<string, string>> = { GIT_LITERAL_PATHSPECS: '1' }
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Resolve the repository enclosing a directory.
 * @param git - command runner.
 * @param cwd - the Session's working directory.
 * @param signal - request lifetime.
 * @returns the absolute top-level directory, or null outside any repository.
 */
export async function locateRepository(git: GitCommandRunner, cwd: string, signal: AbortSignal): Promise<string | null> {
  const found = await git.run(['rev-parse', '--show-toplevel'], { cwd, signal })
  if (found.exitCode === 0) {
    const root = found.stdout.trim()
    // git reports forward slashes on Windows: resolve once so every later comparison uses one spelling.
    return root.length === 0 ? null : resolve(root)
  }
  if (NOT_A_REPOSITORY.test(found.stderr)) return null
  throw new GitCommandError('git rev-parse --show-toplevel', found.stderr)
}

/**
 * Read the two porcelain status letters of every reported path.
 * @param stdout - `git status --porcelain=v1 -z` output.
 * @returns one entry per path, in git's order, with rename sources attached.
 */
export function parseStatus(stdout: string): GitFileEntry[] {
  const fields = stdout.split('\0')
  const entries: GitFileEntry[] = []
  for (let at = 0; at < fields.length; at += 1) {
    // split() never yields a hole, so this index always holds a field.
    const field = fields[at] as string
    if (field.length < 4) continue
    const index = field.charAt(0)
    const worktree = field.charAt(1)
    const path = field.slice(3)
    const renamed = index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C'
    const origPath = renamed ? fields[at += 1] : undefined
    entries.push({ index, worktree, path, ...origPath === undefined || origPath === '' ? {} : { origPath } })
  }
  return entries
}

/**
 * Read one repository's current status: its branch, its divergence from the
 * upstream, and every changed path.
 * @param git - command runner.
 * @param root - repository top-level directory.
 * @param signal - request lifetime.
 * @returns branch facts and entries.
 */
export async function readRepositoryStatus(git: GitCommandRunner, root: string, signal: AbortSignal): Promise<RepositoryStatus> {
  const status = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, signal })
  if (status.exitCode !== 0) throw new GitCommandError('git status', status.stderr)
  // A truncated listing lost its head, so the panel would show a partial, misaligned change set.
  if (status.truncated) throw new GitCommandError('git status', 'the listing exceeded the output cap')
  const head = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, signal })
  const upstream = await git.run(['rev-list', '--count', '--left-right', '@{upstream}...HEAD'], { cwd: root, signal })
  const [behind, ahead] = upstream.exitCode === 0 ? upstream.stdout.trim().split('\t').map(Number) : []
  return {
    ...head.exitCode === 0 && head.stdout.trim() !== '' ? { branch: head.stdout.trim() } : {},
    ...behind === undefined || ahead === undefined ? {} : { behind, ahead },
    entries: parseStatus(status.stdout),
  }
}

/**
 * Number a unified diff's hunks.
 * @param text - `git diff` output.
 * @returns every hunk in file order.
 */
export function parseHunks(text: string): GitHunk[] {
  const hunks: GitHunk[] = []
  let current: GitHunk | undefined
  for (const line of text.split('\n')) {
    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (current === undefined) continue
    const prefix = line[0]
    if (prefix === ' ' || prefix === '+' || prefix === '-') current.lines.push(line)
  }
  return hunks
}

/**
 * Read one file's comparison against the index or the work tree.
 * @param git - command runner.
 * @param root - repository top-level directory.
 * @param path - validated repository-relative path.
 * @param side - staged content (`index`) or the work tree against the index.
 * @param signal - request lifetime.
 * @returns hunks, or the refusal git or the index state implies.
 */
export async function readFileDiff(
  git: GitCommandRunner, root: string, path: string, side: GitSide, signal: AbortSignal,
): Promise<GitDiff> {
  // The entry's own status letters decide whether git can compare it at all: a staged
  // deletion is absent from the index, so `ls-files` would call it untracked.
  const status = await git.run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', path], {
    cwd: root, env: LITERAL_PATHSPECS, signal,
  })
  if (status.exitCode !== 0) throw new GitCommandError('git status', status.stderr)
  const entry = parseStatus(status.stdout).find(candidate => candidate.path === path)
  if (entry === undefined || entry.index === '?') return { kind: 'untracked', path }
  const args = side === 'index'
    ? ['diff', '--no-color', '--cached', '-U3', '--', path]
    : ['diff', '--no-color', '-U3', '--', path]
  const comparison = await git.run(args, { cwd: root, env: LITERAL_PATHSPECS, signal })
  if (comparison.exitCode !== 0) throw new GitCommandError('git diff', comparison.stderr)
  // A truncated comparison lost its head, so its hunk numbering would be wrong.
  if (comparison.truncated) throw new GitCommandError('git diff', 'the comparison exceeded the output cap')
  if (BINARY_DIFF.test(comparison.stdout) || comparison.stdout.includes('GIT binary patch')) return { kind: 'binary', path }
  return { kind: 'text', path, hunks: parseHunks(comparison.stdout) }
}

/**
 * Normalize one client-supplied path into a repository-relative spelling.
 * @param path - the path as received.
 * @returns the path, or undefined when it is absolute, empty, NUL-bearing, or carries a .. segment.
 */
export function repositoryPath(path: string): string | undefined {
  if (path.length === 0 || path.includes('\0') || isAbsolute(path)) return undefined
  const normalized = normalize(path).replaceAll('\\', '/')
  if (normalized === '..' || normalized.startsWith('../')) return undefined
  // Rejecting absolute paths and `..` prefixes already leaves a path that cannot escape the root.
  return normalized
}

/**
 * Stage the named paths.
 * @param git - command runner.
 * @param root - repository top-level directory.
 * @param paths - validated repository-relative paths.
 * @param signal - request lifetime.
 * @returns after the index is written.
 */
export async function stagePaths(
  git: GitCommandRunner, root: string, paths: readonly string[], signal: AbortSignal,
): Promise<void> {
  const added = await git.run(['add', '--', ...paths], { cwd: root, env: LITERAL_PATHSPECS, signal })
  if (added.exitCode !== 0) throw new GitCommandError('git add', added.stderr)
}

/**
 * Unstage the named paths. A repository whose HEAD is unborn has nothing to
 * reset to, so its staged entries return to the work tree through `git rm --cached`.
 * @param git - command runner.
 * @param root - repository top-level directory.
 * @param paths - validated repository-relative paths.
 * @param signal - request lifetime.
 * @returns after the index is written.
 */
export async function unstagePaths(
  git: GitCommandRunner, root: string, paths: readonly string[], signal: AbortSignal,
): Promise<void> {
  const reset = await git.run(['reset', '-q', 'HEAD', '--', ...paths], { cwd: root, env: LITERAL_PATHSPECS, signal })
  if (reset.exitCode === 0) return
  if (!/unknown revision|ambiguous argument|does not have any commits yet/i.test(reset.stderr)) {
    throw new GitCommandError('git reset', reset.stderr)
  }
  const removed = await git.run(['rm', '--cached', '-r', '--', ...paths], { cwd: root, env: LITERAL_PATHSPECS, signal })
  if (removed.exitCode !== 0) throw new GitCommandError('git rm --cached', removed.stderr)
}

/**
 * Commit the staged content with one message.
 * @param git - command runner.
 * @param root - repository top-level directory.
 * @param message - the commit message as the user typed it.
 * @param signal - request lifetime.
 * @returns after the commit is written.
 */
export async function commitStaged(
  git: GitCommandRunner, root: string, message: string, signal: AbortSignal,
): Promise<void> {
  const committed = await git.run(['commit', '-m', message], { cwd: root, signal })
  if (committed.exitCode !== 0) throw new GitCommandError('git commit', committed.stderr)
}
