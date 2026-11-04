/** Annotations in the workspace-browser derivations: filtering, ranking, and search matching. */
import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionAnnotation } from '../src/client/annotations.ts'
import {
  deriveFlat, deriveGroups, deriveSearchResults, filteredSessionIds, orderByPriority, type SessionRowState,
} from '../src/client/tree.ts'

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId

const summary = (id: string, updatedAt: number): SessionSummary => ({
  id: sid(id), title: id, displayTitle: id, running: false, blank: false, updatedAt, retainedBy: {},
})
const list = (...items: SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id),
  byId: Object.fromEntries(items.map(item => [item.id, item])),
  phase: 'ready',
  projectionsBySession: {},
})
const workspace = (id: string, sessionIds: string[]): WorkspaceView => ({
  workspaceId: wid(id), path: `/projects/${id}`, title: id,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
const noStatuses: SessionStatusSnapshot = new Map()
const noContent = { items: [], hasMore: false }

const rowState = (annotations: Record<string, SessionAnnotation> = {}, annotationFilter?: 'all' | 'favorite' | 'reviewLater'): SessionRowState => ({
  pinnedSessionIds: [],
  archivedSessionIds: [],
  archivedFilter: 'default',
  annotations: Object.fromEntries(Object.entries(annotations).map(([id, annotation]) => [sid(id), annotation])),
  ...(annotationFilter === undefined ? {} : { annotationFilter }),
})

describe('annotations in the derived rows', () => {
  it('attaches the stored annotation and leaves unannotated rows bare', () => {
    const state = list(summary('a', 2), summary('b', 1))
    const groups = deriveGroups(
      state,
      [workspace('w', ['a', 'b'])],
      rowState({ a: { favorite: true, priority: 2 } }),
      noStatuses,
      { expandedGroups: ['w'] },
    )
    expect(groups[0]?.sessions[0]?.annotation).toEqual({ favorite: true, priority: 2 })
    expect(groups[0]?.sessions[1]?.annotation).toBeUndefined()
  })

  it('filters by favorite and review-later, and reads an absent filter as all', () => {
    const state = list(summary('a', 2), summary('b', 1), summary('c', 1))
    const annotations = { a: { favorite: true }, b: { reviewLater: true } }
    const idsFor = (filter: 'favorite' | 'reviewLater') => deriveFlat(
      state,
      ['a', 'b', 'c'].map(sid),
      rowState(annotations, filter),
      noStatuses,
    ).map(row => row.id)
    expect(idsFor('favorite')).toEqual([sid('a')])
    expect(idsFor('reviewLater')).toEqual([sid('b')])
    expect(deriveFlat(state, ['a', 'b', 'c'].map(sid), rowState(annotations), noStatuses)).toHaveLength(3)
  })

  it('selects exactly the Sessions the filters show', () => {
    const state = list(summary('a', 2), summary('b', 1))
    expect(filteredSessionIds(state, rowState({ a: { favorite: true } }, 'favorite'))).toEqual([sid('a')])
  })
})

describe('orderByPriority', () => {
  it('ranks priority first, then recency, then Session id', () => {
    const state = list(summary('a', 1), summary('b', 9), summary('c', 5), summary('d', 9), summary('e', 9))
    const order = orderByPriority(
      ['a', 'b', 'c', 'd', 'e'].map(sid),
      state.byId,
      { [sid('a')]: { priority: 5 }, [sid('b')]: { priority: 2 } },
    )
    // b (2) leads; the rest are default 3, so recency decides — d, e, then c at
    // 9/9/5 with Session id breaking the d/e tie — then a at priority 5.
    expect(order).toEqual([sid('b'), sid('d'), sid('e'), sid('c'), sid('a')])
  })

  it('omits members without a summary and breaks a full tie by Session id in both directions', () => {
    const state = list(summary('a', 1), summary('d', 9), summary('e', 9))
    expect(orderByPriority(['a', 'missing'].map(sid), state.byId, {})).toEqual([sid('a')])
    // Equal priority and timestamp: both comparison directions land on id order.
    expect(orderByPriority(['d', 'e'].map(sid), state.byId, {})).toEqual([sid('d'), sid('e')])
    expect(orderByPriority(['e', 'd'].map(sid), state.byId, {})).toEqual([sid('d'), sid('e')])
  })
})

describe('search matches annotations', () => {
  it('finds a Session by tag and by note text', () => {
    const state = list(summary('a', 2), summary('b', 1))
    const workspaces = [workspace('w', ['a', 'b'])]
    const annotations = { a: { tags: ['Deploy'] }, b: { note: 'waiting on the deploy' } } as Record<string, SessionAnnotation>
    const byTag = deriveSearchResults(state, workspaces, 'dep', rowState(annotations), noStatuses, noContent, 10)
    expect(byTag.items.map(item => item.id)).toEqual([sid('a'), sid('b')])
    expect(byTag.items[0]?.annotation?.tags).toEqual(['Deploy'])
  })

  it('leaves a row without annotation, without note, and without a matching tag unselected', () => {
    const state = list(summary('plain', 3), summary('marked', 2), summary('other', 1))
    const workspaces = [workspace('w', ['plain', 'marked', 'other'])]
    const annotations = { marked: { favorite: true }, other: { tags: ['release'] } } as Record<string, SessionAnnotation>
    const found = deriveSearchResults(state, workspaces, 'dep', rowState(annotations), noStatuses, noContent, 10)
    expect(found.items).toEqual([])
  })

  it('follows the annotation filter while searching', () => {
    const state = list(summary('deploy', 2))
    const workspaces = [workspace('w', ['deploy'])]
    const found = deriveSearchResults(state, workspaces, 'deploy', rowState({}, 'favorite'), noStatuses, noContent, 10)
    expect(found.items).toEqual([])
  })
})
