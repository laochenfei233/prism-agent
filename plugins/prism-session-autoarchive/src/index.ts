/**
 * Scheduled archiving of idle conversations.
 *
 * One sweep lists every Session this process can see, selects the top-level
 * conversations whose last write is older than the configured number of days,
 * and adds them to the Workspace archive set — the same durable state the
 * sidebar's own Archive action writes, so the client hides them and the user can
 * restore any of them.
 *
 * The archive set refuses a Session with running work, which the sweep treats as
 * the intended outcome: automatic hygiene must never cancel a running turn.
 * @module prism-session-autoarchive
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
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
    if (Math.max(header.createdAt, updatedAt ?? 0) > cutoff) continue
    selected.push(header.id)
  }
  return selected
}

/**
 * Archive every conversation the selection names, one Session at a time.
 *
 * A Session whose work is running is skipped: the archive set refuses it, and
 * cancelling the user's turn to tidy the sidebar would be a worse outcome than
 * leaving the Session visible for another interval. Any other failure is
 * reported and the sweep continues, so one unreadable Session cannot stop the
 * rest.
 * @param dependencies - the archive set, the Session listing, and the clock.
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
  return archived
}

/**
 * Install the scheduled sweep.
 *
 * One sweep runs at a time: a tick that arrives while the previous pass is still
 * listing returns immediately, so a slow store cannot stack passes. A failing
 * pass is logged and the next tick stays armed; nothing is retried inside it.
 * @param ctx - plugin context; both timers are disposed with it.
 * @param config - deployment configuration, resolved here so the defaults are stated once.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
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
        now: () => Date.now(),
        skip: message => { ctx.logger.debug(`${name}: ${message}`) },
        warn: (message, error) => { ctx.logger.warn(`${name}: ${message}: ${String(error)}`) },
      }, resolved)
    } catch (error: unknown) {
      ctx.logger.warn(`${name}: archive sweep failed: ${String(error)}`)
    } finally {
      running = false
    }
  }
  ctx.timeout(() => { void runOnce() }, FIRST_SWEEP_DELAY_MS)
  ctx.interval(() => { void runOnce() }, resolved.sweepIntervalMinutes * MINUTE_MS)
}
