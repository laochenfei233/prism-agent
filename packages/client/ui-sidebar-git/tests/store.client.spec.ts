/** The panel's per-tab store: what each write leaves behind. */
import { describe, expect, it } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { gitStatus } from './support.client.ts'
import { createGitStore } from '../src/client/store.ts'

const TAB = 'tab-1' as TabId

function store() {
  const instance = createGitStore().create()
  instance.actions.start(TAB)
  return instance
}

describe('git store', () => {
  it('starts loading and settles into a ready status', () => {
    const instance = store()
    expect(instance.getSnapshot().byTab[TAB]).toEqual({ status: { kind: 'loading' }, message: '', committing: false })
    instance.actions.loaded(TAB, gitStatus([{ path: 'a.txt', index: ' ', worktree: 'M' }]))
    expect(instance.getSnapshot().byTab[TAB]?.status).toMatchObject({ kind: 'ready' })
  })

  it('drops an open comparison once its entry leaves the status, and keeps one that stays', () => {
    const instance = store()
    instance.actions.start(TAB)
    instance.actions.loaded(TAB, gitStatus([{ path: 'a.txt', index: ' ', worktree: 'M' }]))
    instance.actions.select(TAB, { path: 'a.txt', side: 'worktree' })
    instance.actions.loaded(TAB, gitStatus([{ path: 'a.txt', index: ' ', worktree: 'M' }]))
    expect(instance.getSnapshot().byTab[TAB]?.selection).toEqual({ path: 'a.txt', side: 'worktree' })
    instance.actions.loaded(TAB, gitStatus([]))
    expect(instance.getSnapshot().byTab[TAB]?.selection).toBeUndefined()
    expect(instance.getSnapshot().byTab[TAB]?.diff).toBeUndefined()
  })

  it('records read and mutation failures', () => {
    const instance = store()
    instance.actions.failed(TAB, 'no git')
    expect(instance.getSnapshot().byTab[TAB]?.status).toEqual({ kind: 'failed', message: 'no git' })
    instance.actions.actionFailed(TAB, 'stage refused')
    expect(instance.getSnapshot().byTab[TAB]?.error).toBe('stage refused')
  })

  it('tracks the comparison lifecycle', () => {
    const instance = store()
    instance.actions.diffLoading(TAB)
    expect(instance.getSnapshot().byTab[TAB]?.diff).toEqual({ kind: 'loading' })
    instance.actions.diffFailed(TAB, 'no diff')
    expect(instance.getSnapshot().byTab[TAB]?.diff).toEqual({ kind: 'failed', message: 'no diff' })
    instance.actions.diffLoaded(TAB, { kind: 'binary', path: 'a.bin' })
    expect(instance.getSnapshot().byTab[TAB]?.diff).toEqual({ kind: 'ready', diff: { kind: 'binary', path: 'a.bin' } })
    instance.actions.deselect(TAB)
    expect(instance.getSnapshot().byTab[TAB]?.diff).toBeUndefined()
  })

  it('keeps the draft through a failure and clears it after a commit', () => {
    const instance = store()
    instance.actions.draft(TAB, 'fix it')
    instance.actions.committing(TAB, true)
    instance.actions.commitFailed(TAB, 'hooks refused')
    expect(instance.getSnapshot().byTab[TAB]).toMatchObject({ message: 'fix it', committing: false, error: 'hooks refused' })
    instance.actions.committed(TAB)
    expect(instance.getSnapshot().byTab[TAB]).toMatchObject({ message: '', committing: false })
    expect(instance.getSnapshot().byTab[TAB]?.error).toBeUndefined()
  })

  it('refuses to write a tab it never started, and forgets a bucket on demand', () => {
    const instance = createGitStore().create()
    expect(() => { instance.actions.loading('missing' as TabId) }).toThrow('no panel for tab')
    instance.actions.start(TAB)
    instance.actions.forget(TAB)
    expect(instance.getSnapshot().byTab[TAB]).toBeUndefined()
  })
})
