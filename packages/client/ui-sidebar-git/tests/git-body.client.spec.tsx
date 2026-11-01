// @vitest-environment jsdom
/** The panel's body over a real store, a recording face, and the Chinese dictionary. */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SidebarRightTabActions } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { GitBody, branchLabel, hunkHeader, sectionsOf } from '../src/client/GitBody.tsx'
import type { GitBodyProps } from '../src/client/GitBody.tsx'
import type { GitFace } from '../src/client/face.ts'
import { zh } from '../src/client/locales.ts'
import { createGitStore } from '../src/client/store.ts'
import { gitStatus, TEXT_DIFF } from './support.client.ts'

const TAB = 'tab-1' as TabId

afterEach(() => { cleanup() })

interface Mounted {
  readonly view: RenderResult
  readonly actions: ReturnType<ReturnType<typeof createGitStore>['create']>['actions']
  readonly face: { [K in keyof GitFace]: Mock<GitFace[K]> }
  readonly bindCommands: ReturnType<typeof vi.fn>
  readonly controller: AbortController
}

/**
 * Mount the body over a live store instance and a recording face.
 * @param options.diffLoaded - publish a text comparison for `a.txt` before the first render.
 */
function mount(options: { diffLoaded?: boolean } = {}): Mounted {
  const instance = createGitStore().create()
  const face: { [K in keyof GitFace]: Mock<GitFace[K]> } = {
    load: vi.fn<GitFace['load']>(),
    open: vi.fn<GitFace['open']>(),
    close: vi.fn<GitFace['close']>(),
    stage: vi.fn<GitFace['stage']>(),
    unstage: vi.fn<GitFace['unstage']>(),
    commit: vi.fn<GitFace['commit']>(),
  }
  const bindCommands = vi.fn(() => vi.fn())
  const controller = new AbortController()
  const tab = {
    id: TAB, title: 'Changes', signal: controller.signal,
    actions: { bindCommands } as Pick<SidebarRightTabActions, 'bindCommands'>,
  } satisfies ReturnType<GitBodyProps['useTabInfo']>['tab']
  const props: GitBodyProps = {
    ...face,
    useTabInfo: () => ({ tab }),
    useStore: <T,>(select: (state: ReturnType<typeof instance.getSnapshot>) => T): T =>
      select(useSyncExternalStore(instance.subscribe, instance.getSnapshot)),
    actions: instance.actions,
    t: makeTranslate(zh),
  }
  const element: ReactElement = <GitBody {...props} />
  const view = render(element)
  const actions = instance.actions
  if (options.diffLoaded === true) {
    act(() => {
      actions.loaded(TAB, gitStatus([{ path: 'a.txt', index: ' ', worktree: 'M' }]))
      actions.select(TAB, { path: 'a.txt', side: 'worktree' })
      actions.diffLoaded(TAB, TEXT_DIFF)
    })
  }
  return { view, actions, face, bindCommands, controller }
}

describe('GitBody', () => {
  it('starts its bucket, loads the status, and answers the refresh command', () => {
    const { view, face, bindCommands } = mount()
    expect(face.load).toHaveBeenCalledWith(TAB, expect.any(AbortSignal))
    expect(view.container.querySelector('[data-git-state="loading"]')?.textContent).toContain(zh['state.loading'])
    expect(bindCommands).toHaveBeenCalledTimes(1)
    const bound = bindCommands.mock.lastCall?.[0] as { refresh: () => void }
    bound.refresh()
    expect(face.load).toHaveBeenCalledTimes(2)
    fireEvent.click(view.getByRole('button', { name: zh.refresh }))
    expect(face.load).toHaveBeenCalledTimes(3)
  })

  it('groups the entries into the three sections and stages or unstages one row', () => {
    const { view, actions, face } = mount()
    act(() => {
      actions.loaded(TAB, gitStatus([
        { path: 'staged.ts', index: 'M', worktree: ' ' },
        { path: 'changed.ts', index: ' ', worktree: 'M' },
        { path: 'fresh.ts', index: '?', worktree: '?' },
      ], { ahead: 2, behind: 1 }))
    })
    const staged = view.container.querySelector('[data-git-section="staged"]')?.textContent
    expect(staged).toContain('staged.ts')
    expect(view.container.querySelector('[data-git-section="unstaged"]')?.textContent).toContain('changed.ts')
    expect(view.container.querySelector('[data-git-section="untracked"]')?.textContent).toContain('fresh.ts')
    expect(view.container.textContent).toContain(zh['branch.ahead'].replace('{count}', '2'))
    expect(view.container.textContent).toContain(zh['branch.behind'].replace('{count}', '1'))
    fireEvent.click(view.getByRole('button', { name: zh['row.unstage'] }))
    expect(face.unstage).toHaveBeenCalledWith(TAB, 'staged.ts', expect.any(AbortSignal))
    fireEvent.click(view.getAllByRole('button', { name: zh['row.stage'] })[0]!)
    expect(face.stage).toHaveBeenCalledWith(TAB, 'changed.ts', expect.any(AbortSignal))
  })

  it('opens a row comparison, draws its hunks, and closes it again', () => {
    const { view, face, actions } = mount()
    act(() => { actions.loaded(TAB, gitStatus([{ path: 'a.txt', index: ' ', worktree: 'M' }])) })
    const row = view.container.querySelector('[data-git-row="a.txt"] button[aria-expanded]')
    expect(row?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row!)
    expect(face.open).toHaveBeenCalledWith(TAB, expect.objectContaining({ path: 'a.txt' }), 'worktree', expect.any(AbortSignal))
    act(() => {
      actions.select(TAB, { path: 'a.txt', side: 'worktree' })
      actions.diffLoaded(TAB, TEXT_DIFF)
    })
    const panel = view.container.querySelector('[data-git-row="a.txt"]')
    expect(panel?.textContent).toContain('@@ -1,1 +1,1 @@')
    expect([...panel!.querySelectorAll('[data-diff-kind]')].map(line => [line.getAttribute('data-diff-kind'), line.textContent]))
      .toEqual([['del', '1one'], ['add', '1two']])
    fireEvent.click(row!)
    expect(face.close).toHaveBeenCalledWith(TAB)
  })

  it('states why a comparison has no lines', () => {
    const { view, actions } = mount()
    act(() => {
      actions.loaded(TAB, gitStatus([{ path: 'a.bin', index: ' ', worktree: 'M' }]))
      actions.select(TAB, { path: 'a.bin', side: 'worktree' })
      actions.diffLoaded(TAB, { kind: 'binary', path: 'a.bin' })
    })
    expect(view.container.querySelector('[data-git-row="a.bin"]')?.textContent).toContain(zh['row.binary'])
    act(() => {
      actions.loaded(TAB, gitStatus([{ path: 'new.txt', index: '?', worktree: '?' }]))
      actions.select(TAB, { path: 'new.txt', side: 'worktree' })
      actions.diffLoaded(TAB, { kind: 'untracked', path: 'new.txt' })
    })
    expect(view.container.querySelector('[data-git-row="new.txt"]')?.textContent).toContain(zh['row.untracked'])
    act(() => {
      actions.diffLoaded(TAB, { kind: 'text', path: 'new.txt', hunks: [] })
    })
    expect(view.container.querySelector('[data-git-row="new.txt"]')?.textContent).toContain(zh['state.clean'])
  })

  it('keeps the commit control unavailable until a path is staged and a message is typed', () => {
    const { view, actions, face } = mount()
    act(() => {
      actions.loaded(TAB, gitStatus([{ path: 'changed.ts', index: ' ', worktree: 'M' }]))
    })
    expect(view.container.textContent).toContain(zh['commit.nothingStaged'])
    const commit = view.getByRole('button', { name: zh['commit.action'] })
    expect(commit).toHaveProperty('disabled', true)
    act(() => {
      actions.loaded(TAB, gitStatus([{ path: 'staged.ts', index: 'M', worktree: ' ' }]))
      actions.draft(TAB, 'ship it')
    })
    const enabled = view.getByRole('button', { name: zh['commit.action'] })
    expect(enabled).toHaveProperty('disabled', false)
    fireEvent.click(enabled)
    expect(face.commit).toHaveBeenCalledWith(TAB, 'ship it', expect.any(AbortSignal))
    const input = view.getByRole('textbox', { name: zh['commit.placeholder'] })
    fireEvent.change(input, { target: { value: 'typed' } })
    expect(actions).toBeDefined()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(face.commit).toHaveBeenCalledTimes(2)
    // An empty draft and a shifted Enter both leave the commit alone.
    act(() => { actions.draft(TAB, '   ') })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(face.commit).toHaveBeenCalledTimes(2)
  })

  it('shows read, action, and commit failures in place', () => {
    const { view, actions } = mount()
    act(() => { actions.failed(TAB, 'no git') })
    expect(view.container.textContent).toContain(zh['state.failed'].replace('{message}', 'no git'))
    act(() => { actions.actionFailed(TAB, 'index locked') })
    expect(view.getAllByRole('alert').at(-1)?.textContent).toBe('操作失败：index locked')
    act(() => {
      actions.loaded(TAB, gitStatus([]))
      actions.committing(TAB, true)
      actions.commitFailed(TAB, 'hooks refused')
    })
    expect(view.container.textContent).toContain('hooks refused')
  })

  it('names the absent repository and the absent executable', () => {
    const { view, actions } = mount()
    act(() => { actions.loaded(TAB, { available: false, repo: false, entries: [] }) })
    expect(view.container.textContent).toContain(zh['state.unavailable'])
    act(() => { actions.loaded(TAB, { available: true, repo: false, entries: [] }) })
    expect(view.container.textContent).toContain(zh['state.notRepository'])
    act(() => { actions.loaded(TAB, gitStatus([])) })
    expect(view.container.textContent).toContain(zh['state.clean'])
  })

  it('shows a rename source, the loading note, and a failed comparison', () => {
    const { view, actions } = mount()
    act(() => {
      actions.loaded(TAB, gitStatus([{ path: 'new.ts', index: 'R', worktree: ' ', origPath: 'old.ts' }]))
    })
    expect(view.container.querySelector('[data-git-row="new.ts"]')?.textContent).toContain('old.ts')
    act(() => { actions.select(TAB, { path: 'new.ts', side: 'index' }) })
    expect(view.container.textContent).toContain(zh['diff.loading'])
    act(() => { actions.diffFailed(TAB, 'gone') })
    expect(view.container.textContent).toContain(zh['diff.failed'].replace('{message}', 'gone'))
  })

  it('shows the committing label while a commit is in flight', () => {
    const { view, actions } = mount()
    act(() => {
      actions.loaded(TAB, gitStatus([{ path: 'staged.ts', index: 'M', worktree: ' ' }]))
      actions.draft(TAB, 'msg')
      actions.committing(TAB, true)
    })
    expect(view.container.textContent).toContain(zh['commit.committing'])
  })

  it('forgets its bucket when the tab record ends, so a reused id starts clean', () => {
    const { view, actions, face, controller } = mount()
    act(() => { actions.loaded(TAB, gitStatus([])) })
    expect(view.container.textContent).toContain(zh['state.clean'])
    act(() => { controller.abort() })
    expect(face.load).toHaveBeenCalledTimes(2)
    expect(view.container.querySelector('[data-git-state="loading"]')).not.toBeNull()
  })
})

describe('section helpers', () => {
  it('orders entries into staged, unstaged, and untracked', () => {
    expect(sectionsOf(gitStatus([
      { path: 'a', index: 'M', worktree: ' ' },
      { path: 'b', index: ' ', worktree: 'M' },
      { path: 'c', index: '?', worktree: '?' },
      { path: 'd', index: 'M', worktree: 'M' },
    ]))).toEqual({
      staged: [
        { path: 'a', index: 'M', worktree: ' ' },
        { path: 'd', index: 'M', worktree: 'M' },
      ],
      unstaged: [
        { path: 'b', index: ' ', worktree: 'M' },
        { path: 'd', index: 'M', worktree: 'M' },
      ],
      untracked: [{ path: 'c', index: '?', worktree: '?' }],
    })
  })

  it('states a hunk range', () => {
    expect(hunkHeader({ oldStart: 3, oldLines: 2, newStart: 4, newLines: 5, lines: [] })).toBe('@@ -3,2 +4,5 @@')
  })

  it('labels a branch, a detached HEAD, and a repository without commits', () => {
    const t = makeTranslate(zh)
    expect(branchLabel('main', t)).toBe('main')
    expect(branchLabel('HEAD', t)).toBe(zh['branch.detached'])
    expect(branchLabel(undefined, t)).toBe(zh['branch.unborn'])
  })
})
