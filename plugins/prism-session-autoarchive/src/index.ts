/**
 * Scheduled archiving of idle conversations and idle projects.
 *
 * One sweep lists every Session this process can see, selects the top-level
 * conversations whose last write is older than the configured number of days,
 * and adds them to the Workspace archive set — the same durable state the
 * sidebar's own Archive action writes, so the client hides them and the user can
 * restore any of them.
 *
 * The same pass then evaluates every Workspace: a project holding no visible
 * conversation whose newest write (or registration) is older than
 * `projectIdleDays` joins the Workspace archive set, and a hidden project that
 * regained a visible conversation is restored — a scheduled follow-up, import,
 * or webhook attaching into a hidden project brings it back within one sweep.
 *
 * The archive set refuses a Session with running work, which the sweep treats as
 * the intended outcome: automatic hygiene must never cancel a running turn.
 * @module prism-session-autoarchive
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { resolveConfig } from './config.ts'
import type { Config, ResolvedConfig } from './config.ts'

export { Config, resolveConfig } from './config.ts'
export type { ResolvedConfig } from './config.ts'

/** Cordis plugin name; also the `cordis.patch.yml` row id this bundle inserts. */
export const name = 'prism-session-autoarchive'

/** The archive set, the Session store the sweep reads, and the timer that schedules it. */
export const inject = ['workspaceRegistry', 'sessionPersistence', 'timer']

/** One day in milliseconds. */
const DAY_MS = 86_400_000

/** One minute in milliseconds. */
const MINUTE_MS = 60_000

/**
 * Delay before the first sweep. A boot guard rather than a deployment choice: it
 * keeps the sweep's storage listing out of the application's start-up window,
 * without postponing the first pass by a whole interval.
 */
const FIRST_SWEEP_DELAY_MS = 60_000

/** What the sweep reads and writes, so one pass can run without a Context. */
export interface SweepDependencies {
  /**
   * Every stored Session plus the ones this process created and has not
   * materialized yet.
   * @returns one snapshot per visible Session.
   */
  listSessions(): Promise<readonly SessionPersistenceSnapshot[]>
  /** Sessions already in the durable archive set. */
  archivedSessionIds(): readonly SessionId[]
  /** Sessions the user pinned; archiving one would drop the pin. */
  pinnedSessionIds(): readonly SessionId[]
  /**
   * Add one Session to the archive set.
   * @param sessionId - the Session to archive.
   * @throws {WorkspaceActiveSessionError} while the Session's work is running.
   */
  archive(sessionId: SessionId): Promise<void>
  /** Every registered Workspace with its accounting, canonical-cwd filtered. */
  listWorkspaces(): readonly WorkspaceFacts[]
  /** Workspaces already in the durable Workspace archive set. */
  archivedWorkspaceIds(): readonly WorkspaceId[]
  /**
   * Add one Workspace to the Workspace archive set.
   * @param workspaceId - the Workspace to archive.
   */
  archiveWorkspace(workspaceId: WorkspaceId): Promise<void>
  /**
   * Drop one Workspace from the Workspace archive set.
   * @param workspaceId - the Workspace to restore.
   */
  unarchiveWorkspace(workspaceId: WorkspaceId): Promise<void>
  /** Current time in Unix epoch milliseconds. */
  now(): number
  /**
   * Record one Session the sweep left alone.
   * @param message - what was skipped and why.
   */
  skip(message: string): void
  /**
   * Record a failure that did not stop the sweep.
   * @param message - what failed.
   * @param error - the failure.
   */
  warn(message: string, error: unknown): void
}

/** The state one sweep decides against. */
export interface IdleSelection {
  /** Current time in Unix epoch milliseconds. */
  readonly now: number
  /** Days without dialogue after which a conversation is archived. */
  readonly idleDays: number
  /** Sessions already archived. */
  readonly archived: ReadonlySet<SessionId>
  /** Sessions the user pinned. */
  readonly pinned: ReadonlySet<SessionId>
}

/** The facts one accounted Session contributes to the Workspace pass. */
export interface SessionFact {
  /**
   * Epoch ms of the Session's last write; a Session that never materialized
   * counts as created now rather than as idle forever.
   */
  readonly activity: number
  /** A top-level user conversation: neither a subagent child nor a fork. */
  readonly topLevel: boolean
}

/** The Workspace facts one pass decides against. */
export interface WorkspaceFacts {
  /** Durable Workspace identity. */
  readonly id: WorkspaceId
  /** Registration time ISO stamp; the activity anchor for a Workspace with no accounted Session. */
  readonly createdAt: string
  /** Accounted Session ids, canonical-cwd filtered by the registry. */
  readonly sessionIds: readonly SessionId[]
}

/** The Workspace writes one pass commits. */
export interface WorkspaceChanges {
  /** Idle projects that join the archive set, in listing order. */
  readonly hide: readonly WorkspaceId[]
  /** Projects a visible conversation brought back, in listing order. */
  readonly restore: readonly WorkspaceId[]
}

/**
 * Select the conversations one sweep archives.
 *
 * Only top-level user conversations qualify: an archived or pinned Session is
 * left alone, and so is a subagent child or a fork, because the archive set
 * blocks resumed steps for the Session it names and a delegating parent may
 * still continue its child. The activity clock is the later of the header's
 * creation time and the stored artifact's last write, so a Session that never
 * materialized counts as created now rather than as idle forever.
 * @param snapshots - visible Sessions with their stored-artifact observations.
 * @param selection - current time, the window, and the sets to leave alone.
 * @returns the Session ids to archive, in listing order.
 */
export function selectIdleSessions(
  snapshots: readonly SessionPersistenceSnapshot[],
  selection: IdleSelection,
): SessionId[] {
  const cutoff = selection.now - selection.idleDays * DAY_MS
  const selected: SessionId[] = []
  for (const snapshot of snapshots) {
    const { header, updatedAt } = snapshot
    if (selection.archived.has(header.id) || selection.pinned.has(header.id)) continue
    if (header.origin === 'subagent' || header.parentSession !== undefined) continue
    if (Math.max(header.createdAt, updatedAt ?? 0) >= cutoff) continue
    selected.push(header.id)
  }
  return selected
}

/**
 * Select the Workspace writes one pass commits.
 *
 * A Workspace hides when no accounted Session is a visible top-level
 * conversation — archived Sessions and subagent children do not count — and
 * its newest activity is past the window, where activity is the newest
 * accounted Session's last write (archived and subagent included, the
 * conservative anchor) or, with no accounted Session, the registration time.
 * A hidden Workspace with a visible conversation restores on the spot, so a
 * scheduled follow-up, import, or webhook attaching into a hidden project
 * brings it back within one sweep instead of stranding Sessions in an
 * invisible section.
 * @param workspaces - every registered Workspace.
 * @param sessionFacts - activity and top-level facts per listed Session.
 * @param archived - the Session archive set.
 * @param archivedWorkspaces - the Workspace archive set.
 * @param projectIdleDays - days of total inactivity after which an idle project hides.
 * @param now - current time in Unix epoch milliseconds.
 * @returns the hides and restores to write, in listing order.
 */
export function selectWorkspaceChanges(
  workspaces: readonly WorkspaceFacts[],
  sessionFacts: ReadonlyMap<SessionId, SessionFact>,
  archived: ReadonlySet<SessionId>,
  archivedWorkspaces: ReadonlySet<WorkspaceId>,
  projectIdleDays: number,
  now: number,
): WorkspaceChanges {
  const cutoff = now - projectIdleDays * DAY_MS
  const hide: WorkspaceId[] = []
  const restore: WorkspaceId[] = []
  for (const workspace of workspaces) {
    let newest = Date.parse(workspace.createdAt)
    let visible = false
    for (const sessionId of workspace.sessionIds) {
      const fact = sessionFacts.get(sessionId)
      if (fact === undefined) continue
      newest = Math.max(newest, fact.activity)
      if (fact.topLevel && !archived.has(sessionId)) visible = true
    }
    if (visible) {
      if (archivedWorkspaces.has(workspace.id)) restore.push(workspace.id)
      continue
    }
    if (!archivedWorkspaces.has(workspace.id) && newest < cutoff) hide.push(workspace.id)
  }
  return { hide, restore }
}

/**
 * Archive every conversation the selection names, one Session at a time, then
 * run the Workspace pass over the same listing.
 *
 * A Session whose work is running is skipped: the archive set refuses it, and
 * cancelling the user's turn to tidy the sidebar would be a worse outcome than
 * leaving the Session visible for another interval. Any other failure is
 * reported and the sweep continues, so one unreadable Session cannot stop the
 * rest. A failing Workspace write is reported and the remaining writes still
 * run.
 * @param dependencies - the archive sets, the listings, and the clock.
 * @param config - the resolved config; `enabled: false` performs no work.
 * @returns how many Sessions this sweep archived.
 */
export async function sweep(dependencies: SweepDependencies, config: ResolvedConfig): Promise<number> {
  if (!config.enabled) return 0
  const snapshots = await dependencies.listSessions()
  const selected = selectIdleSessions(snapshots, {
    now: dependencies.now(),
    idleDays: config.idleDays,
    archived: new Set(dependencies.archivedSessionIds()),
    pinned: new Set(dependencies.pinnedSessionIds()),
  })
  let archived = 0
  for (const sessionId of selected) {
    try {
      await dependencies.archive(sessionId)
      archived += 1
    } catch (error: unknown) {
      if (error instanceof WorkspaceActiveSessionError) {
        dependencies.skip(`session '${sessionId}' is still running`)
        continue
      }
      dependencies.warn(`session '${sessionId}' could not be archived`, error)
    }
  }
  await archiveIdleWorkspaces(dependencies, snapshots, config)
  return archived
}

/**
 * Run the Workspace pass: hide idle empty projects, restore projects that
 * regained a visible conversation.
 * @param dependencies - the archive sets, the listings, and the clock.
 * @param snapshots - the Session listing the conversation pass already read.
 * @param config - the resolved config carrying `projectIdleDays`.
 */
async function archiveIdleWorkspaces(
  dependencies: SweepDependencies,
  snapshots: readonly SessionPersistenceSnapshot[],
  config: ResolvedConfig,
): Promise<void> {
  const workspaces = dependencies.listWorkspaces()
  if (workspaces.length === 0) return
  const sessionFacts = new Map<SessionId, SessionFact>()
  for (const snapshot of snapshots) {
    sessionFacts.set(snapshot.header.id, {
      activity: Math.max(snapshot.header.createdAt, snapshot.updatedAt ?? 0),
      topLevel: snapshot.header.origin !== 'subagent' && snapshot.header.parentSession === undefined,
    })
  }
  const changes = selectWorkspaceChanges(
    workspaces,
    sessionFacts,
    new Set(dependencies.archivedSessionIds()),
    new Set(dependencies.archivedWorkspaceIds()),
    config.projectIdleDays,
    dependencies.now(),
  )
  for (const workspaceId of changes.hide) {
    try {
      await dependencies.archiveWorkspace(workspaceId)
    } catch (error: unknown) {
      dependencies.warn(`workspace '${workspaceId}' could not be archived`, error)
    }
  }
  for (const workspaceId of changes.restore) {
    try {
      await dependencies.unarchiveWorkspace(workspaceId)
    } catch (error: unknown) {
      dependencies.warn(`workspace '${workspaceId}' could not be restored`, error)
    }
  }
}

/**
 * Install the scheduled sweep.
 *
 * Config is resolved per sweep, not once at load: every field is volatile, so
 * the Loader commits an edited value into the same references and the next pass
 * reads the new window. A cadence edit re-arms the interval, because the bound
 * it was created with is the old one.
 *
 * One sweep runs at a time: a tick that arrives while the previous pass is still
 * listing returns immediately, so a slow store cannot stack passes. A failing
 * pass is logged and the next tick stays armed; nothing is retried inside it.
 * @param ctx - plugin context; every timer is disposed with it.
 * @param config - deployment configuration, resolved at each use.
 */
export function apply(ctx: Context, config: Config): void {
  let running = false
  const runOnce = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await sweep({
        listSessions: () => ctx.sessionPersistence.list(),
        archivedSessionIds: () => ctx.workspaceRegistry.archivedSessionIds,
        pinnedSessionIds: () => ctx.workspaceRegistry.pinnedSessionIds,
        archive: sessionId => ctx.workspaceRegistry.archiveSession(sessionId),
        listWorkspaces: () => ctx.workspaceRegistry.list().map(workspace => ({
          id: workspace.id,
          createdAt: workspace.createdAt,
          sessionIds: workspace.sessionIds,
        })),
        archivedWorkspaceIds: () => ctx.workspaceRegistry.archivedWorkspaceIds,
        archiveWorkspace: workspaceId => ctx.workspaceRegistry.archiveWorkspace(workspaceId),
        unarchiveWorkspace: workspaceId => ctx.workspaceRegistry.unarchiveWorkspace(workspaceId),
        now: () => Date.now(),
        skip: message => { ctx.logger.debug(`${name}: ${message}`) },
        warn: (message, error) => { ctx.logger.warn(`${name}: ${message}: ${String(error)}`) },
      }, resolveConfig(config))
    } catch (error: unknown) {
      ctx.logger.warn(`${name}: archive sweep failed: ${String(error)}`)
    } finally {
      running = false
    }
  }
  const arm = (): (() => void) => ctx.interval(
    () => { void runOnce() },
    resolveConfig(config).sweepIntervalMinutes * MINUTE_MS,
  )
  let interval = arm()
  ctx.timeout(() => { void runOnce() }, FIRST_SWEEP_DELAY_MS)
  ctx.on('loader/volatile-update', () => {
    interval()
    interval = arm()
  })
}
