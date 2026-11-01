// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
/**
 * The Git panel's view state, one bucket per tab: the last status it read, the
 * comparison it has open, and the commit draft.
 *
 * The store is declared at the tab registration as an exclusive store, so the
 * framework mints one instance per session; every writer names the tab it
 * writes, and the tab record's own abort signal ends its bucket.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { GitDiff, GitSide, GitStatus } from '../contract.ts'

/** What the panel is doing about the repository status. */
export type StatusState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly status: GitStatus }
  | { readonly kind: 'failed'; readonly message: string }

/** What the panel is doing about the one comparison it has open. */
export type DiffState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly diff: GitDiff }
  | { readonly kind: 'failed'; readonly message: string }

/** The path one tab has open, and which side of the index it compares. */
export interface GitSelection {
  readonly path: string
  readonly side: GitSide
}

/** One tab's panel: status, open comparison, and commit draft. */
export interface GitTabState {
  status: StatusState
  selection?: GitSelection | undefined
  diff?: DiffState | undefined
  /** The commit message as typed. */
  message: string
  /** Whether a commit request is in flight. */
  committing: boolean
  /** Why the last commit failed, until the draft or the status changes. */
  error?: string | undefined
}

/** Every tab's panel, keyed by tab id. */
export interface GitState {
  byTab: Record<TabId, GitTabState>
}

/**
 * One tab's bucket.
 * @param state - the draft.
 * @param tabId - the tab being written.
 * @returns the tab's panel state.
 */
function bucket(state: GitState, tabId: TabId): GitTabState {
  const tab = state.byTab[tabId]
  if (tab === undefined) throw new Error(`ui-sidebar-git: no panel for tab "${tabId}"`)
  return tab
}

/** The store's write set; every action names the tab it writes. */
type GitActions = {
  start: (draft: GitState, tabId: TabId) => void
  loading: (draft: GitState, tabId: TabId) => void
  loaded: (draft: GitState, tabId: TabId, status: GitStatus) => void
  failed: (draft: GitState, tabId: TabId, message: string) => void
  select: (draft: GitState, tabId: TabId, selection: GitSelection) => void
  deselect: (draft: GitState, tabId: TabId) => void
  diffLoading: (draft: GitState, tabId: TabId) => void
  diffLoaded: (draft: GitState, tabId: TabId, diff: GitDiff) => void
  diffFailed: (draft: GitState, tabId: TabId, message: string) => void
  draft: (draft: GitState, tabId: TabId, message: string) => void
  committing: (draft: GitState, tabId: TabId, committing: boolean) => void
  commitFailed: (draft: GitState, tabId: TabId, message: string) => void
  actionFailed: (draft: GitState, tabId: TabId, message: string) => void
  committed: (draft: GitState, tabId: TabId) => void
  forget: (draft: GitState, tabId: TabId) => void
}

/**
 * Declare the Git panel's store.
 * @returns the store handle to declare on the registration.
 */
export function createGitStore(): EngineStoreHandle<GitState, GitActions> {
  return defineStore({
    init: (): GitState => ({ byTab: {} }),
    actions: {
      start: (d, tabId: TabId) => {
        d.byTab[tabId] = { status: { kind: 'loading' }, message: '', committing: false }
      },
      loading: (d, tabId: TabId) => { bucket(d, tabId).status = { kind: 'loading' } },
      loaded: (d, tabId: TabId, status: GitStatus) => {
        const tab = bucket(d, tabId)
        tab.status = { kind: 'ready', status }
        tab.error = undefined
        // A comparison whose entry disappeared from the status is no longer open.
        if (tab.selection !== undefined && !status.entries.some(entry => entry.path === tab.selection?.path)) {
          tab.selection = undefined
          tab.diff = undefined
        }
      },
      failed: (d, tabId: TabId, message: string) => { bucket(d, tabId).status = { kind: 'failed', message } },
      select: (d, tabId: TabId, selection: GitSelection) => { bucket(d, tabId).selection = selection },
      deselect: (d, tabId: TabId) => {
        const tab = bucket(d, tabId)
        tab.selection = undefined
        tab.diff = undefined
      },
      diffLoading: (d, tabId: TabId) => { bucket(d, tabId).diff = { kind: 'loading' } },
      diffLoaded: (d, tabId: TabId, diff: GitDiff) => { bucket(d, tabId).diff = { kind: 'ready', diff } },
      diffFailed: (d, tabId: TabId, message: string) => { bucket(d, tabId).diff = { kind: 'failed', message } },
      draft: (d, tabId: TabId, message: string) => {
        const tab = bucket(d, tabId)
        tab.message = message
        tab.error = undefined
      },
      committing: (d, tabId: TabId, committing: boolean) => { bucket(d, tabId).committing = committing },
      commitFailed: (d, tabId: TabId, message: string) => {
        const tab = bucket(d, tabId)
        tab.committing = false
        tab.error = message
      },
      actionFailed: (d, tabId: TabId, message: string) => {
        const tab = bucket(d, tabId)
        tab.error = message
      },
      committed: (d, tabId: TabId) => {
        const tab = bucket(d, tabId)
        tab.committing = false
        tab.error = undefined
        tab.message = ''
        tab.selection = undefined
        tab.diff = undefined
      },
      forget: (d, tabId: TabId) => { delete d.byTab[tabId] },
    },
  })
}
