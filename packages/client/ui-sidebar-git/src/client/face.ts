// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
/**
 * The panel's asynchronous half: it reads the repository status and one
 * comparison, runs the index mutations and the commit, and writes every
 * outcome through the store's own actions.
 *
 * The component never awaits anything. One read per tab is in force: a newer
 * request retires the settlement of an older one, and a tab record whose
 * signal has aborted writes nothing. Mutations answer with the status they
 * leave behind, so a stage, unstage, or commit needs no second round trip.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import {
  GIT_COMMIT_ROUTE, GIT_STAGE_ROUTE, GIT_UNSTAGE_ROUTE, gitDiffUrl, gitStatusUrl, isGitDiff, isGitStatus,
  type GitDiff, type GitFileEntry, type GitSide, type GitStatus,
} from '../contract.ts'
import type { createGitStore } from './store.ts'

/** The browser's fetch, injected so a test drives the face without a network. */
export type GitFetch = (input: string, init?: RequestInit) => Promise<Response>

/** A refusal the panel shows as text: a rejected request, an unreadable answer, or a refused commit. */
export class GitRefusal extends Error {
  /**
   * @param message - what to show the reader.
   */
  constructor(message: string) {
    super(message)
    this.name = 'GitRefusal'
  }
}

/**
 * Read a refusal's message out of a failed response.
 * @param response - the Host's answer.
 * @returns the message the body carried, or the status line.
 */
async function refusalOf(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') return body.error
  } catch {
    // A non-JSON refusal falls back to its status line below.
  }
  return `HTTP ${response.status}`
}

/**
 * Decode one successful answer.
 * @param response - the Host's answer.
 * @param valid - the check the decoded value must pass.
 * @returns the decoded value.
 * @throws GitRefusal when the response failed or its record does not validate.
 */
async function decode<T>(response: Response, valid: (value: unknown) => value is T): Promise<T> {
  if (!response.ok) throw new GitRefusal(await refusalOf(response))
  const value: unknown = await response.json()
  if (!valid(value)) throw new GitRefusal('The Host sent a record this panel does not understand.')
  return value
}

/**
 * Read one Session's repository status.
 * @param fetchImpl - the browser fetch.
 * @param sessionId - viewed Session.
 * @param signal - request lifetime.
 * @returns the status.
 */
export async function readStatus(fetchImpl: GitFetch, sessionId: string, signal: AbortSignal): Promise<GitStatus> {
  return decode(await fetchImpl(gitStatusUrl(sessionId), { signal }), isGitStatus)
}

/**
 * Read one file's comparison.
 * @param fetchImpl - the browser fetch.
 * @param sessionId - viewed Session.
 * @param path - repository-relative path.
 * @param side - which comparison to read.
 * @param signal - request lifetime.
 * @returns the comparison.
 */
export async function readDiff(
  fetchImpl: GitFetch, sessionId: string, path: string, side: GitSide, signal: AbortSignal,
): Promise<GitDiff> {
  return decode(await fetchImpl(gitDiffUrl(sessionId, path, side), { signal }), isGitDiff)
}

/**
 * Post one index mutation and read the status it leaves behind.
 * @param fetchImpl - the browser fetch.
 * @param route - the document-relative route to post to.
 * @param sessionId - viewed Session.
 * @param paths - repository-relative paths.
 * @param signal - request lifetime.
 * @returns the status after the mutation.
 */
export async function postPaths(
  fetchImpl: GitFetch, route: string, sessionId: string, paths: readonly string[], signal: AbortSignal,
): Promise<GitStatus> {
  return decode(await fetchImpl(route, {
    method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, paths }),
  }), isGitStatus)
}

/**
 * Commit the staged content and read the status it leaves behind.
 * @param fetchImpl - the browser fetch.
 * @param sessionId - viewed Session.
 * @param message - the commit message as typed.
 * @param signal - request lifetime.
 * @returns the status after the commit.
 */
export async function postCommit(
  fetchImpl: GitFetch, sessionId: string, message: string, signal: AbortSignal,
): Promise<GitStatus> {
  return decode(await fetchImpl(GIT_COMMIT_ROUTE, {
    method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, message }),
  }), isGitStatus)
}

/** What the body can ask the face to do; none of them returns a promise. */
export interface GitFace {
  /** Load the status for this tab. @param tabId - owning tab. @param signal - the tab record's lifetime. */
  readonly load: (tabId: TabId, signal: AbortSignal) => void
  /**
   * Open one entry's comparison.
   * @param tabId - owning tab.
   * @param entry - the row clicked.
   * @param side - the section the row sits in: index for staged, worktree otherwise.
   * @param signal - the tab record's lifetime.
   */
  readonly open: (tabId: TabId, entry: GitFileEntry, side: GitSide, signal: AbortSignal) => void
  /** Close the open comparison. @param tabId - owning tab. */
  readonly close: (tabId: TabId) => void
  /** Stage one path. @param tabId - owning tab. @param path - repository-relative path. @param signal - the tab record's lifetime. */
  readonly stage: (tabId: TabId, path: string, signal: AbortSignal) => void
  /** Unstage one path. @param tabId - owning tab. @param path - repository-relative path. @param signal - the tab record's lifetime. */
  readonly unstage: (tabId: TabId, path: string, signal: AbortSignal) => void
  /** Commit the staged content. @param tabId - owning tab. @param message - the draft. @param signal - the tab record's lifetime. */
  readonly commit: (tabId: TabId, message: string, signal: AbortSignal) => void
}

/** The injected face, bound by the framework to the tab's Session and the store's actions. */
export type GitInjected = (sessionId: string, actions: BoundActions<ReturnType<typeof createGitStore>>) => GitFace

/**
 * Build the face factory.
 * @param fetchImpl - the browser fetch.
 * @returns the factory the tab registration injects.
 */
export function createGitFace(fetchImpl: GitFetch): GitInjected {
  return (sessionId, actions): GitFace => {
    /** Per tab, the read generation a settlement must match; the latest request wins. */
    const statusReads = new Map<TabId, number>()
    const diffReads = new Map<TabId, number>()
    const bump = (reads: Map<TabId, number>, tabId: TabId): number => {
      const next = (reads.get(tabId) ?? 0) + 1
      reads.set(tabId, next)
      return next
    }
    // Every rejection below comes from a GitRefusal or a fetch TypeError, both Errors.
    const messageOf = (error: Error): string => error.message
    const load = (tabId: TabId, signal: AbortSignal): void => {
      if (signal.aborted) return
      const generation = bump(statusReads, tabId)
      actions.loading(tabId)
      void readStatus(fetchImpl, sessionId, signal).then((status) => {
        if (signal.aborted || statusReads.get(tabId) !== generation) return
        actions.loaded(tabId, status)
      }, (error: Error) => {
        if (signal.aborted || statusReads.get(tabId) !== generation) return
        actions.failed(tabId, messageOf(error))
      })
    }
    const open = (tabId: TabId, entry: GitFileEntry, side: GitSide, signal: AbortSignal): void => {
      if (signal.aborted) return
      actions.select(tabId, { path: entry.path, side })
      const generation = bump(diffReads, tabId)
      actions.diffLoading(tabId)
      void readDiff(fetchImpl, sessionId, entry.path, side, signal).then((diff) => {
        if (signal.aborted || diffReads.get(tabId) !== generation) return
        actions.diffLoaded(tabId, diff)
      }, (error: Error) => {
        if (signal.aborted || diffReads.get(tabId) !== generation) return
        actions.diffFailed(tabId, messageOf(error))
      })
    }
    const mutate = (tabId: TabId, request: Promise<GitStatus>, signal: AbortSignal): void => {
      const generation = bump(statusReads, tabId)
      void request.then((status) => {
        if (signal.aborted || statusReads.get(tabId) !== generation) return
        actions.loaded(tabId, status)
      }, (error: Error) => {
        if (signal.aborted || statusReads.get(tabId) !== generation) return
        actions.actionFailed(tabId, messageOf(error))
      })
    }
    return {
      load,
      open,
      close: (tabId) => { actions.deselect(tabId) },
      stage: (tabId, path, signal) => {
        if (signal.aborted) return
        mutate(tabId, postPaths(fetchImpl, GIT_STAGE_ROUTE, sessionId, [path], signal), signal)
      },
      unstage: (tabId, path, signal) => {
        if (signal.aborted) return
        mutate(tabId, postPaths(fetchImpl, GIT_UNSTAGE_ROUTE, sessionId, [path], signal), signal)
      },
      commit: (tabId, message, signal) => {
        if (signal.aborted) return
        const generation = bump(statusReads, tabId)
        actions.committing(tabId, true)
        void postCommit(fetchImpl, sessionId, message, signal).then((status) => {
          if (signal.aborted || statusReads.get(tabId) !== generation) return
          actions.loaded(tabId, status)
          actions.committed(tabId)
        }, (error: Error) => {
          if (signal.aborted || statusReads.get(tabId) !== generation) return
          actions.commitFailed(tabId, messageOf(error))
        })
      },
    }
  }
}
