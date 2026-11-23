import { describe, expect, it } from 'vitest'
import { archivedWorkspaceRows, when } from '../src/client/rows.ts'

/**
 * Behavior suite for the archived-projects section's pure derivation: the
 * browser half renders whatever this returns, so the row order, the
 * unknown-Workspace fallback, and the activity anchor are pinned here.
 */

const NOW = Date.UTC(2026, 10, 1)
const DAY = 86_400_000

describe('archivedWorkspaceRows', () => {
  it('projects the archive set most recently active first', () => {
    const rows = archivedWorkspaceRows({
      archivedWorkspaceIds: ['old', 'recent'],
      workspaces: [
        { workspaceId: 'old', title: 'Old', path: '/w/old', updatedAt: '2026-10-01T00:00:00.000Z', sessionIds: ['s1'] },
        { workspaceId: 'recent', title: 'Recent', path: '/w/recent', updatedAt: '2026-10-20T00:00:00.000Z', sessionIds: [] },
      ],
      sessions: { s1: { updatedAt: NOW - 30 * DAY } },
    })
    expect(rows).toEqual([
      { id: 'recent', title: 'Recent', path: '/w/recent', updatedAt: Date.parse('2026-10-20T00:00:00.000Z') },
      { id: 'old', title: 'Old', path: '/w/old', updatedAt: NOW - 30 * DAY },
    ])
  })

  it('anchors on the newest of the registration and conversation writes', () => {
    const rows = archivedWorkspaceRows({
      archivedWorkspaceIds: ['ws'],
      workspaces: [
        // Registered recently; its one conversation was written long ago.
        { workspaceId: 'ws', title: 'Ws', path: '/w/ws', updatedAt: '2026-10-25T00:00:00.000Z', sessionIds: ['s1'] },
      ],
      sessions: { s1: { updatedAt: NOW - 40 * DAY } },
    })
    // The anchor is the newest fact, so the shown age never overstates idleness.
    expect(rows[0]?.updatedAt).toBe(Date.parse('2026-10-25T00:00:00.000Z'))
  })

  it('keeps an archived Workspace absent from the rows listed by its id', () => {
    const rows = archivedWorkspaceRows({
      archivedWorkspaceIds: ['ghost'],
      workspaces: [],
      sessions: {},
    })
    expect(rows).toEqual([{ id: 'ghost', title: 'ghost', path: '', updatedAt: 0 }])
  })

  it('falls back to the registration time when summaries and stamps are missing', () => {
    const rows = archivedWorkspaceRows({
      archivedWorkspaceIds: ['ws'],
      workspaces: [{ workspaceId: 'ws', title: 'Ws', path: '/w/ws', sessionIds: ['gone'] }],
      sessions: {},
    })
    expect(rows[0]?.updatedAt).toBe(0)
  })
})

describe('when', () => {
  it('formats hours under a day and days beyond it', () => {
    const now = Date.now()
    expect(when(0)).toBe('—')
    expect(when(now - 3 * 3_600_000)).toBe('3h')
    expect(when(now - 5 * DAY)).toBe('5d')
  })
})
