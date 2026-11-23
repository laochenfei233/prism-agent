/**
 * Row derivation for the archived-projects settings section.
 *
 * Pure: the section feeds it the client snapshots and renders the result.
 * @module prism-session-autoarchive/client/rows
 */

/** Milliseconds in one hour. */
const HOUR_MS = 3_600_000
/** Milliseconds in one day. */
const DAY_MS = 86_400_000

/**
 * Format one last-activity time the way a person reads it.
 * @param at - epoch milliseconds; `0` when the time is unknown.
 * @returns a compact relative label.
 */
export function when(at: number): string {
  if (at <= 0) return '—'
  const elapsed = Date.now() - at
  if (elapsed < DAY_MS) return `${Math.max(1, Math.round(elapsed / HOUR_MS))}h`
  return `${Math.round(elapsed / DAY_MS)}d`
}

/** One archived project as the section renders it. */
export interface ArchivedWorkspaceRow {
  /** Durable Workspace id. */
  id: string
  /** Display title, from the Workspace row. */
  title: string
  /** Canonical folder path. */
  path: string
  /**
   * Newest conversation write in epoch ms, or the registration time when the
   * project never accounted a summary-carrying conversation; `0` when unknown.
   */
  updatedAt: number
}

/** The client state the derivation reads. */
export interface ArchivedWorkspacesInput {
  /** The registry-global Workspace archive set, in Host order. */
  archivedWorkspaceIds: readonly string[]
  /** Workspace rows, each naming the Sessions it accounts. */
  workspaces: ReadonlyArray<{
    readonly workspaceId?: string
    readonly title?: string
    readonly path?: string
    readonly updatedAt?: string
    readonly sessionIds: readonly string[]
  }>
  /** Session summaries by id, carrying their last write. */
  sessions: Readonly<Record<string, { readonly updatedAt?: number }>>
}

/**
 * Project the archived set into render rows, most recently active first.
 *
 * A Workspace absent from the rows still appears, titled by its id, because
 * the archive set is authoritative about what the user can restore.
 * @param input - the archive set, the Workspace rows, and the Session summaries.
 * @returns one row per archived Workspace, most recently active first.
 */
export function archivedWorkspaceRows(input: ArchivedWorkspacesInput): ArchivedWorkspaceRow[] {
  const workspaceById = new Map(input.workspaces.map(workspace => [workspace.workspaceId, workspace]))
  return input.archivedWorkspaceIds.map((id) => {
    const workspace = workspaceById.get(id)
    let updatedAt = workspace === undefined ? 0 : Date.parse(workspace.updatedAt ?? '')
    if (Number.isNaN(updatedAt)) updatedAt = 0
    for (const sessionId of workspace?.sessionIds ?? []) {
      updatedAt = Math.max(updatedAt, input.sessions[sessionId]?.updatedAt ?? 0)
    }
    return {
      id,
      title: workspace?.title ?? id,
      path: workspace?.path ?? '',
      updatedAt,
    }
  }).sort((left, right) => right.updatedAt - left.updatedAt)
}
