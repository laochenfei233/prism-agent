// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
/**
 * The records the Git workbench exchanges with its Host routes, the routes
 * themselves, and the checks that keep a decoded answer untrusted until it
 * matches what this plugin serves.
 */
/** Authenticated GET route answering one Session's repository status. */
export const GIT_STATUS_PATH = '/api/git.status'

/** Authenticated GET route answering one file's comparison against the index or the work tree. */
export const GIT_DIFF_PATH = '/api/git.diff'

/** Authenticated POST route staging the named paths. */
export const GIT_STAGE_PATH = '/api/git.stage'

/** Authenticated POST route unstaging the named paths. */
export const GIT_UNSTAGE_PATH = '/api/git.unstage'

/** Authenticated POST route committing the staged content. */
export const GIT_COMMIT_PATH = '/api/git.commit'

/**
 * Browser-relative form of {@link GIT_STATUS_PATH}; see
 * .agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md.
 */
export const GIT_STATUS_ROUTE = GIT_STATUS_PATH.slice(1)

/** Browser-relative form of {@link GIT_DIFF_PATH}. */
export const GIT_DIFF_ROUTE = GIT_DIFF_PATH.slice(1)

/** Browser-relative form of {@link GIT_STAGE_PATH}. */
export const GIT_STAGE_ROUTE = GIT_STAGE_PATH.slice(1)

/** Browser-relative form of {@link GIT_UNSTAGE_PATH}. */
export const GIT_UNSTAGE_ROUTE = GIT_UNSTAGE_PATH.slice(1)

/** Browser-relative form of {@link GIT_COMMIT_PATH}. */
export const GIT_COMMIT_ROUTE = GIT_COMMIT_PATH.slice(1)

/** Which side of the index a comparison reads: staged content, or the work tree against the index. */
export type GitSide = 'index' | 'worktree'

/**
 * One path git reports, with the two porcelain status letters: `index` is the
 * staged side, `worktree` the unstaged side. Both are `?` for an untracked file.
 */
export interface GitFileEntry {
  /** Repository-relative path with `/` separators. */
  path: string
  /** Staged status letter. */
  index: string
  /** Unstaged status letter. */
  worktree: string
  /** Rename or copy source, when the entry records one. */
  origPath?: string
}

/** One Session's repository status; `entries` is empty whenever `repo` is false. */
export interface GitStatus {
  /** Whether this Host resolved a git executable. */
  available: boolean
  /** Whether the Session's working directory is inside a git work tree. */
  repo: boolean
  /** Repository top-level directory, absolute. */
  root?: string
  /** Current branch, or `HEAD` when detached; absent on an unborn branch. */
  branch?: string
  /** Commits the upstream has that the branch does not. */
  behind?: number
  /** Commits the branch has that the upstream does not. */
  ahead?: number
  entries: GitFileEntry[]
}

/** One unified-diff hunk with three context lines; every line keeps its `+`, `-`, or space prefix. */
export interface GitHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** One file's comparison: line hunks, a binary refusal, or an untracked file git cannot compare yet. */
export type GitDiff =
  | { kind: 'text'; path: string; hunks: GitHunk[] }
  | { kind: 'binary'; path: string }
  | { kind: 'untracked'; path: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isEntry(value: unknown): value is GitFileEntry {
  if (!isRecord(value)) return false
  const { path, index, worktree, origPath } = value
  return typeof path === 'string' && path.length > 0
    && typeof index === 'string' && index.length === 1
    && typeof worktree === 'string' && worktree.length === 1
    && (origPath === undefined || typeof origPath === 'string')
}

/**
 * Validate a status read from the status route.
 * @param value - decoded JSON.
 * @returns whether the record carries the availability and repository flags and a well-formed entry list.
 */
export function isGitStatus(value: unknown): value is GitStatus {
  if (!isRecord(value)) return false
  const { available, repo, root, branch, ahead, behind, entries } = value
  if (typeof available !== 'boolean' || typeof repo !== 'boolean') return false
  if (root !== undefined && (typeof root !== 'string' || root.length === 0)) return false
  if (branch !== undefined && (typeof branch !== 'string' || branch.length === 0)) return false
  if (ahead !== undefined && !isCount(ahead)) return false
  if (behind !== undefined && !isCount(behind)) return false
  return Array.isArray(entries) && entries.every(isEntry)
}

function isHunk(value: unknown): value is GitHunk {
  if (!isRecord(value)) return false
  const { oldStart, oldLines, newStart, newLines, lines } = value
  return [oldStart, oldLines, newStart, newLines].every(isCount)
    && Array.isArray(lines) && lines.every(line => typeof line === 'string' && /^[+ -]/.test(line))
}

/**
 * Validate a comparison read from the comparison route.
 * @param value - decoded JSON.
 * @returns whether the value is a text comparison with well-formed hunks, or a binary or untracked refusal.
 */
export function isGitDiff(value: unknown): value is GitDiff {
  if (!isRecord(value)) return false
  const { kind, path } = value
  if (typeof path !== 'string' || path.length === 0) return false
  if (kind === 'binary' || kind === 'untracked') return true
  if (kind !== 'text') return false
  const { hunks } = value
  return Array.isArray(hunks) && hunks.every(isHunk)
}

/**
 * Build the status route for one Session.
 * @param sessionId - viewed Session.
 * @returns document-relative status route.
 */
export function gitStatusUrl(sessionId: string): string {
  return `${GIT_STATUS_ROUTE}?${new URLSearchParams({ sessionId })}`
}

/**
 * Build the comparison route for one path.
 * @param sessionId - viewed Session.
 * @param path - repository-relative path.
 * @param side - which comparison to read.
 * @returns document-relative comparison route.
 */
export function gitDiffUrl(sessionId: string, path: string, side: GitSide): string {
  return `${GIT_DIFF_ROUTE}?${new URLSearchParams({ sessionId, path, side })}`
}
