/** The viewing store's annotation table: writes, removals, and the persisted-filter accessor. */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createWorkspaceViewStore } from '../src/client/stores.ts'

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
