import { describe, expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { resolveConfig } from '../src/config.ts'
import { Config } from '../src/index.ts'
import type { SweepDependencies } from '../src/index.ts'
import { selectIdleSessions, sweep } from '../src/index.ts'

/**
 * Behavior suite for the idle-conversation sweep.
 *
 * The selection is driven through the real schema output and the sweep through
 * the archive-set dependencies the plugin builds, with the Session store and
 * the archive set replaced by recordings. The config cases resolve through the
 * plugin's own schemastery schema, because that is where the volatile
 * references the Loader delivers are produced.
 */

const NOW = Date.UTC(2026, 10, 1)
const DAY = 86_400_000

/** One stored-Session snapshot for the selection to read. */
function stored(
  id: string,
  options: {
    readonly createdAt: number
    readonly updatedAt?: number
    readonly parentSession?: string
    readonly subagent?: boolean
  },
): SessionPersistenceSnapshot {
  return {
    header: {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(id),
      createdAt: options.createdAt,
      isSeeded: options.parentSession !== undefined,
      ...(options.parentSession === undefined ? {} : { parentSession: SessionId(options.parentSession) }),
      ...(options.subagent === true ? { origin: 'subagent' as const } : {}),
    },
    revision: SessionPersistenceRevision(`revision:${id}`),
    ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
  }
}

/** The dependencies one sweep reads, with every call recorded. */
function dependencies(
  snapshots: readonly SessionPersistenceSnapshot[],
  overrides: Partial<SweepDependencies> = {},
): SweepDependencies & { readonly archived: string[]; readonly skipped: string[]; readonly warned: string[] } {
  const archived: string[] = []
  const skipped: string[] = []
  const warned: string[] = []
  return {
    listSessions: () => Promise.resolve(snapshots),
    archivedSessionIds: () => [],
    pinnedSessionIds: () => [],
    archive: (sessionId) => {
      archived.push(sessionId)
      return Promise.resolve()
    },
    now: () => NOW,
    skip: message => { skipped.push(message) },
    warn: (message, error) => { warned.push(`${message}: ${String(error)}`) },
    archived,
    skipped,
    warned,
    ...overrides,
  }
}

describe('idle selection', () => {
  it('selects a conversation idle past the window and leaves a recent one alone', () => {
    const selected = selectIdleSessions(
      [
        stored('older', { createdAt: NOW - 40 * DAY, updatedAt: NOW - 31 * DAY }),
        stored('recent', { createdAt: NOW - 90 * DAY, updatedAt: NOW - 3 * DAY }),
      ],
      { now: NOW, idleDays: 30, archived: new Set(), pinned: new Set() },
    )
    expect(selected).toEqual(['older'])
  })

  it('leaves archived, pinned, subagent, and forked conversations alone', () => {
    const selected = selectIdleSessions(
      [
        stored('archived', { createdAt: NOW - 40 * DAY }),
        stored('pinned', { createdAt: NOW - 40 * DAY }),
        stored('child', { createdAt: NOW - 40 * DAY, parentSession: 'parent' }),
        stored('subagent', { createdAt: NOW - 40 * DAY, subagent: true }),
        stored('plain', { createdAt: NOW - 40 * DAY }),
      ],
      {
        now: NOW,
        idleDays: 30,
        archived: new Set([SessionId('archived')]),
        pinned: new Set([SessionId('pinned')]),
      },
    )
    expect(selected).toEqual(['plain'])
  })

  it('ages a conversation by its artifact write time, falling back to its creation time', () => {
    const selected = selectIdleSessions(
      [
        // Created long ago, written recently: active.
        stored('written-recently', { createdAt: NOW - 100 * DAY, updatedAt: NOW - DAY }),
        // No artifact observation at all: the creation time stands in.
        stored('never-materialized', { createdAt: NOW - 100 * DAY }),
        stored('young', { createdAt: NOW - DAY }),
      ],
      { now: NOW, idleDays: 30, archived: new Set(), pinned: new Set() },
    )
    expect(selected).toEqual(['never-materialized'])
  })
})

describe('sweep', () => {
  it('archives every selected conversation and reports the count', async () => {
    const deps = dependencies([
      stored('first', { createdAt: NOW - 40 * DAY }),
      stored('second', { createdAt: NOW - 45 * DAY }),
      stored('fresh', { createdAt: NOW - 2 * DAY }),
    ])
    await expect(sweep(deps, resolveConfig({}))).resolves.toBe(2)
    expect(deps.archived).toEqual(['first', 'second'])
  })

  it('uses the configured window instead of the shipped default', async () => {
    const deps = dependencies([stored('ten-days', { createdAt: NOW - 10 * DAY })])
    await expect(sweep(deps, resolveConfig({ idleDays: 7 }))).resolves.toBe(1)
    expect(deps.archived).toEqual(['ten-days'])
  })

  it('skips a conversation whose work is still running and archives the rest', async () => {
    const deps = dependencies(
      [stored('busy', { createdAt: NOW - 40 * DAY }), stored('quiet', { createdAt: NOW - 41 * DAY })],
      {
        archive: (sessionId) => {
          if (sessionId === SessionId('busy')) {
            return Promise.reject(new WorkspaceActiveSessionError(sessionId, []))
          }
          return Promise.resolve()
        },
      },
    )
    await expect(sweep(deps, resolveConfig({}))).resolves.toBe(1)
    expect(deps.skipped).toEqual(["session 'busy' is still running"])
  })

  it('reports a failing archive and continues with the remaining conversations', async () => {
    const warn = vi.fn<SweepDependencies['warn']>()
    const failure = new Error('storage unavailable')
    const deps = dependencies(
      [stored('broken', { createdAt: NOW - 40 * DAY }), stored('fine', { createdAt: NOW - 41 * DAY })],
      {
        warn,
        archive: (sessionId) => sessionId === SessionId('broken')
          ? Promise.reject(failure)
          : Promise.resolve(),
      },
    )
    await expect(sweep(deps, resolveConfig({}))).resolves.toBe(1)
    expect(warn).toHaveBeenCalledWith("session 'broken' could not be archived", failure)
  })

  it('performs no work while the plugin is disabled', async () => {
    const listSessions = vi.fn<SweepDependencies['listSessions']>()
    const deps = dependencies([], { listSessions })
    await expect(sweep(deps, resolveConfig({ enabled: false }))).resolves.toBe(0)
    expect(listSessions).not.toHaveBeenCalled()
  })
})

describe('config resolution', () => {
  it('reads the values the schema holds, not the volatile references it produces', () => {
    // The Loader delivers the schema's output, whose volatile fields are
    // `{ get() }` references. Reading them as plain values would turn every
    // number below into NaN and the switch into a permanently true value.
    expect(resolveConfig(Config({}))).toEqual({ enabled: true, idleDays: 30, sweepIntervalMinutes: 1_440 })
    expect(resolveConfig(Config({ idleDays: 7, sweepIntervalMinutes: 60 })))
      .toEqual({ enabled: true, idleDays: 7, sweepIntervalMinutes: 60 })
    expect(resolveConfig(Config({ enabled: false })).enabled).toBe(false)
  })

  it('archives against the window the schema carries', async () => {
    const deps = dependencies([stored('ten-days', { createdAt: NOW - 10 * DAY })])
    await expect(sweep(deps, resolveConfig(Config({ idleDays: 7 })))).resolves.toBe(1)
    expect(deps.archived).toEqual(['ten-days'])
  })
})

describe('window edge', () => {
  it('leaves a conversation that is exactly at the window edge alone', () => {
    const selected = selectIdleSessions(
      [stored('edge', { createdAt: NOW - 30 * DAY, updatedAt: NOW - 30 * DAY })],
      { now: NOW, idleDays: 30, archived: new Set(), pinned: new Set() },
    )
    expect(selected).toEqual([])
  })
})
