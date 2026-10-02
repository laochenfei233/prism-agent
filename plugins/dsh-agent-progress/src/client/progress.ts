/**
 * Pure derivation of the progress view from browser-visible session state.
 *
 * Every input here crosses the Host wire, so each field is read through a
 * shape check rather than trusted: a projection the assembled Host does not
 * provide is simply absent, and an item whose fields do not match the current
 * variant is skipped instead of rendered as garbage.
 */

/** One entry of the client session list row. */
export interface SessionSummaryLike {
  readonly id: string
  readonly title?: string
  readonly displayTitle?: string
  readonly cwd?: string
  readonly parentId?: string
  readonly origin?: string
  readonly running?: boolean
  readonly blank?: boolean
  readonly updatedAt?: number
  readonly projectionValues?: Readonly<Record<string, unknown>>
}

/** The client session list snapshot. */
export interface SessionListLike {
  readonly ids: readonly string[]
  readonly byId: Readonly<Record<string, SessionSummaryLike>>
}

/** One entry of the client session-status snapshot. */
export interface SessionStatusLike {
  readonly running?: boolean
  readonly pendingInteraction?: unknown
  readonly completionUnread?: boolean
}

/** Todo tallies read from the `todos` projection. */
export interface TodoProgress {
  /** Entries already completed. */
  readonly done: number
  /** Entries in the list, whatever their state. */
  readonly total: number
  /** First `in_progress` entry, when the agent is working one. */
  readonly active: string | null
}

/** One session's derived progress. */
export interface ProgressRow {
  readonly id: string
  readonly title: string
  /** Working directory basename, or the empty string without one. */
  readonly cwdLabel: string
  readonly subagent: boolean
  readonly running: boolean
  /** A domain is waiting for a human answer on this session. */
  readonly waiting: boolean
  /** An observed stop the reader has not acknowledged. */
  readonly unread: boolean
  readonly updatedAt: number
  readonly todos: TodoProgress
  /** Goal objective, when the session carries one. */
  readonly goal: string | null
  /** Plan mode is effectively active. */
  readonly planning: boolean
}

/** The complete panel view. */
export interface ProgressView {
  readonly rows: readonly ProgressRow[]
  /** Sessions currently running. */
  readonly running: number
  /** Todo entries not completed across every listed session. */
  readonly unfinished: number
  /** Sessions with a non-empty todo list. */
  readonly tracked: number
}

const TODO_DONE = 'completed'

/**
 * Read the `todos` projection value.
 * @param value - the raw projection value.
 * @returns the tallies, zeroed when the value is absent or malformed.
 */
export function parseTodos(value: unknown): TodoProgress {
  if (!Array.isArray(value)) return { done: 0, total: 0, active: null }
  let done = 0
  let active: string | null = null
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const status = (item as { status?: unknown }).status
    if (status !== 'pending' && status !== 'in_progress' && status !== TODO_DONE) continue
    if (status === TODO_DONE) done += 1
    if (active === null && status === 'in_progress') {
      const content = (item as { content?: unknown }).content
      active = typeof content === 'string' ? content : ''
    }
  }
  return { done, total: value.length, active }
}

/**
 * Read a goal objective off the `goal` projection.
 * @param value - the raw projection value.
 * @returns the objective text, or null.
 */
export function parseGoal(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (typeof value !== 'object' || value === null) return null
  const record = value as { objective?: unknown, title?: unknown, text?: unknown }
  for (const candidate of [record.objective, record.title, record.text]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

/**
 * Read the effective plan-mode state off the `plan` projection: an
 * outstanding selection inverts the recorded active flag.
 * @param value - the raw projection value.
 * @returns whether plan mode is effectively active.
 */
export function parsePlan(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { active?: unknown, pending?: unknown }
  if (typeof record.active !== 'boolean') return false
  return typeof record.pending === 'boolean' ? !record.active : record.active
}

/**
 * Last path segment of a working directory.
 * @param cwd - absolute or relative directory path.
 * @returns the basename, or the input when it has no separator.
 */
export function basename(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * Derive the panel view.
 * @param list - the client session list snapshot.
 * @param status - the client session-status snapshot.
 * @returns rows sorted running-first then most-recent, with summary tallies.
 */
export function deriveProgress(
  list: SessionListLike,
  status: ReadonlyMap<string, SessionStatusLike>,
): ProgressView {
  const rows: ProgressRow[] = []
  for (const id of list.ids) {
    const summary = list.byId[id]
    if (summary === undefined || summary.blank === true) continue
    const entry = status.get(id)
    const projections = summary.projectionValues
    const rows0 = projections?.['todos']
    rows.push({
      id,
      title: summary.displayTitle ?? summary.title ?? id,
      cwdLabel: summary.cwd === undefined ? '' : basename(summary.cwd),
      subagent: summary.origin === 'subagent' || summary.parentId !== undefined,
      running: summary.running === true || entry?.running === true,
      waiting: entry?.pendingInteraction !== undefined && entry.pendingInteraction !== null,
      unread: entry?.completionUnread === true,
      updatedAt: summary.updatedAt ?? 0,
      todos: parseTodos(rows0),
      goal: parseGoal(projections?.['goal']),
      planning: parsePlan(projections?.['plan']),
    })
  }
  rows.sort((left, right) => {
    if (left.running !== right.running) return left.running ? -1 : 1
    if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  let running = 0
  let unfinished = 0
  let tracked = 0
  for (const row of rows) {
    if (row.running) running += 1
    if (row.todos.total > 0) {
      tracked += 1
      unfinished += row.todos.total - row.todos.done
    }
  }
  return { rows, running, unfinished, tracked }
}
