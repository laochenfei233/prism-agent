// @vitest-environment jsdom
/** The viewing store's annotation table: writes, removals, the persisted-filter accessor, and rehydration. */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createWorkspaceViewStore, sanitizeWorkspaceView } from '../src/client/stores.ts'

const sid = (id: string) => id as SessionId

/** The instance's stored annotation table, or an empty object before the first write. */
function annotationsOf(instance: ReturnType<ReturnType<typeof createWorkspaceViewStore>['create']>) {
  return instance.store.getSnapshot().annotations ?? {}
}

describe('setAnnotation', () => {
  it('stores an annotation keyed by Session and clears it when emptied', () => {
    const instance = createWorkspaceViewStore().create()
    instance.actions.setAnnotation(sid('a'), { favorite: true, tags: ['x'] })
    expect(annotationsOf(instance)[sid('a')]).toEqual({ favorite: true, tags: ['x'] })
    instance.actions.setAnnotation(sid('a'), {})
    expect(annotationsOf(instance)[sid('a')]).toBeUndefined()
  })

  it('skips the write when the annotation is unchanged', () => {
    const instance = createWorkspaceViewStore().create()
    instance.actions.setAnnotation(sid('a'), { note: 'n' })
    const before = annotationsOf(instance)
    instance.actions.setAnnotation(sid('a'), { note: 'n' })
    expect(annotationsOf(instance)).toBe(before)
  })

  it('keeps other Sessions when one is cleared', () => {
    const instance = createWorkspaceViewStore().create()
    instance.actions.setAnnotation(sid('a'), { favorite: true })
    instance.actions.setAnnotation(sid('b'), { reviewLater: true })
    instance.actions.setAnnotation(sid('a'), {})
    expect(Object.keys(annotationsOf(instance))).toEqual([sid('b')])
  })
})

describe('setAnnotationFilter', () => {
  it('stores the selected filter', () => {
    const instance = createWorkspaceViewStore().create()
    expect(instance.store.getSnapshot().annotationFilter).toBeUndefined()
    instance.actions.setAnnotationFilter('favorite')
    expect(instance.store.getSnapshot().annotationFilter).toBe('favorite')
  })
})

describe('sanitizeWorkspaceView', () => {
  it('drops unknown keys and non-union filter values', () => {
    expect(sanitizeWorkspaceView({
      groupBy: 'grid',
      orderBy: 'random',
      archivedFilter: 'favorites',
      annotationFilter: 'favorites',
      sessionUpdatedAtByAccount: {},
    })).toEqual({})
  })

  it('answers nothing for non-object JSON', () => {
    expect(sanitizeWorkspaceView('nope')).toEqual({})
    expect(sanitizeWorkspaceView(null)).toEqual({})
  })

  it('keeps union members and drops mistyped record entries field by field', () => {
    expect(sanitizeWorkspaceView({
      groupBy: 'flat',
      orderBy: 'priority',
      archivedFilter: 'only',
      annotationFilter: 'reviewLater',
      groupExpansion: { w1: true, w2: 'yes' },
      sessionOrderByAccount: { w1: ['s1', 2], w2: ['s2'], w3: 'nope' },
      annotations: {
        s1: { favorite: true, priority: 9, tags: ['a'] },
        s2: 42,
        s3: { note: '' },
        s4: { reviewLater: true, priority: 2, note: 'n' },
        s5: { favorite: false },
        s6: { tags: 'bad', note: 5 },
      },
    })).toEqual({
      groupBy: 'flat',
      orderBy: 'priority',
      archivedFilter: 'only',
      annotationFilter: 'reviewLater',
      groupExpansion: { w1: true },
      sessionOrderByAccount: { w2: ['s2'] },
      annotations: {
        s1: { favorite: true, tags: ['a'] },
        s4: { reviewLater: true, priority: 2, note: 'n' },
      },
    })
  })
})

describe('rehydration', () => {
  beforeEach(() => { localStorage.clear() })

  it('falls back to the defaults on a malformed-but-parseable blob instead of throwing', () => {
    localStorage.setItem('dsh.workspace.view.v5', JSON.stringify({ annotationFilter: 'favorites' }))
    const instance = createWorkspaceViewStore().create()
    expect(instance.store.getSnapshot().annotationFilter).toBeUndefined()
    expect(instance.store.getSnapshot().groupBy).toBe('workspace')
    instance.actions.setAnnotationFilter('favorite')
    expect(instance.store.getSnapshot().annotationFilter).toBe('favorite')
  })

  it('round-trips a valid blob', () => {
    const blob = {
      groupBy: 'workspace-tree',
      orderBy: 'manual',
      groupExpansion: { w1: true },
      sessionOrderByAccount: { w1: ['s2', 's1'] },
      archivedFilter: 'show',
      annotationFilter: 'favorite',
      annotations: { s1: { favorite: true, tags: ['x'] } },
    }
    localStorage.setItem('dsh.workspace.view.v5', JSON.stringify(blob))
    const instance = createWorkspaceViewStore().create()
    expect(instance.store.getSnapshot()).toEqual(blob)
  })
})
