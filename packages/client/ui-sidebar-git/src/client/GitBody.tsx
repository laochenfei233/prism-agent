/**
 * The Git workbench's body: the branch bar, the staged, unstaged, and
 * untracked sections, the open comparison, and the commit box.
 *
 * The body reads its state from the tab's store and asks the injected face for
 * everything asynchronous; a click on a row opens that row's comparison, and a
 * click on the row's action stages or unstages exactly that path.
 */
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconBranchOutlineRegular, IconRefreshOutlineRegular, Tooltip, hunkRows } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { GitDiff, GitFileEntry, GitHunk, GitSide, GitStatus } from '../contract.ts'
import type { GitFace } from './face.ts'
import type {} from './locales.ts'
import type { GitSelection, GitTabState, createGitStore } from './store.ts'
import css from './GitBody.module.css'

/** The body's composed props: the tab it draws, its store, its face, and its copy. */
export type GitBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ReturnType<typeof createGitStore>>
  & GitFace
  & PropsLocale<'sidebarGit'>

/**
 * Split the repository's entries into the three sections the panel draws.
 * @param status - the status the Host served.
 * @returns staged, unstaged, and untracked entries, each in git's order.
 */
export function sectionsOf(status: GitStatus): { staged: GitFileEntry[]; unstaged: GitFileEntry[]; untracked: GitFileEntry[] } {
  const untracked: GitFileEntry[] = []
  const staged: GitFileEntry[] = []
  const unstaged: GitFileEntry[] = []
  for (const entry of status.entries) {
    if (entry.index === '?' && entry.worktree === '?') untracked.push(entry)
    if (entry.index !== ' ' && entry.index !== '?') staged.push(entry)
    if (entry.worktree !== ' ' && entry.worktree !== '?') unstaged.push(entry)
  }
  return { staged, unstaged, untracked }
}

/**
 * The range line drawn above one hunk's rows.
 * @param hunk - the hunk being drawn.
 * @returns the `@@ -a,b +c,d @@` line.
 */
export function hunkHeader(hunk: GitHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
}

/**
 * Draw one comparison.
 * @param props.diff - what the Host answered.
 * @param props.t - namespace-bound translate.
 * @returns the hunks, or the line explaining why there are none.
 */
function DiffView({ diff, t }: { diff: GitDiff; t: GitBodyProps['t'] }): ReactNode {
  if (diff.kind === 'binary') return <p className={css.note}>{t('row.binary')}</p>
  if (diff.kind === 'untracked') return <p className={css.note}>{t('row.untracked')}</p>
  if (diff.hunks.length === 0) return <p className={css.note}>{t('state.clean')}</p>
  return <div className={css.diff}>
    {diff.hunks.map((hunk, at) => (
      <div key={at} className={css.hunk}>
        <div className={css.hunkHeader}>{hunkHeader(hunk)}</div>
        {hunkRows(hunk).map((row, line) => (
          <div key={line} className={clsx(css.line, css[row.kind])}>
            <span className={css.lineNo}>{row.old ?? ''}</span>
            <span className={css.lineNo}>{row.new ?? ''}</span>
            <span className={css.text}>{row.text}</span>
          </div>
        ))}
      </div>
    ))}
  </div>
}

/** The row's props: one entry, the section it sits in, and the panel it draws inside. */
interface EntryRowProps {
  entry: GitFileEntry
  side: GitSide
  selection: GitSelection | undefined
  state: GitTabState
  tabId: TabId
  signal: AbortSignal
  open: GitFace['open']
  close: GitFace['close']
  stage: GitFace['stage']
  unstage: GitFace['unstage']
  t: GitBodyProps['t']
}

/**
 * Draw one row: its status letter, its path, the action the section allows,
 * and, while open, its comparison.
 * @param props - the row's entry and the panel callbacks.
 * @returns the row.
 */
function EntryRow({ entry, side, selection, state, tabId, signal, open, close, stage, unstage, t }: EntryRowProps): ReactNode {
  const opened = selection?.path === entry.path
  const letter = side === 'index' ? entry.index : entry.worktree
  return (
    <li className={css.row} data-git-row={entry.path}>
      <div className={css.rowHead}>
        <button
          type="button"
          className={css.pathButton}
          aria-expanded={opened}
          onClick={() => { if (opened) close(tabId); else open(tabId, entry, signal) }}
        >
          <span className={css.letter} data-letter={letter}>{letter}</span>
          <span className={css.path}>{entry.path}</span>
          {entry.origPath !== undefined && <span className={css.origPath}>{entry.origPath}</span>}
        </button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => { if (side === 'index') unstage(tabId, entry.path, signal); else stage(tabId, entry.path, signal) }}
        >
          {side === 'index' ? t('row.unstage') : t('row.stage')}
        </Button>
      </div>
      {opened && <div className={css.diffBox}>
        {state.diff === undefined || state.diff.kind === 'loading'
          ? <p className={css.note}>{t('diff.loading')}</p>
          : state.diff.kind === 'failed'
            ? <p className={css.error}>{t('diff.failed', { message: state.diff.message })}</p>
            : <DiffView diff={state.diff.diff} t={t} />}
      </div>}
    </li>
  )
}

/**
 * The Git workbench body.
 * @param props - the tab, its store, its face, and its copy.
 * @returns the panel.
 */
export function GitBody({ useTabInfo, useStore, actions, load, open, close, stage, unstage, commit, t }: GitBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const state = useStore(store => store.byTab[tab.id])
  const { signal } = tab
  useEffect(() => {
    if (state !== undefined) return
    actions.start(tab.id)
    load(tab.id, signal)
  }, [state, tab.id, signal, actions, load])
  useEffect(() => tab.actions.bindCommands({ refresh: () => { load(tab.id, signal) } }), [tab.actions, tab.id, signal, load])
  if (state === undefined) return <div className={css.root} data-git-state="starting" />
  const ready = state.status.kind === 'ready' ? state.status.status : undefined
  const sections = ready === undefined ? undefined : sectionsOf(ready)
  const stagedCount = sections?.staged.length ?? 0
  return <div className={css.root} data-git-state={state.status.kind}>
    <header className={css.header}>
      <span className={css.branch}>
        <IconBranchOutlineRegular size={14} />
        {ready === undefined ? '' : ready.branch ?? t('branch.detached')}
      </span>
      {ready?.ahead !== undefined && ready.ahead > 0
        && <span className={css.count}>{t('branch.ahead', { count: ready.ahead })}</span>}
      {ready?.behind !== undefined && ready.behind > 0
        && <span className={css.count}>{t('branch.behind', { count: ready.behind })}</span>}
      <Tooltip label={t('refresh')} side="bottom" delayMs={500}>
        <button type="button" className={css.tool} aria-label={t('refresh')} onClick={() => { load(tab.id, signal) }}>
          <IconRefreshOutlineRegular size={16} />
        </button>
      </Tooltip>
    </header>
    <div className={css.body}>
      {state.status.kind === 'loading' && <p className={css.note}>{t('state.loading')}</p>}
      {state.status.kind === 'failed' && <p className={css.error} role="alert">{t('state.failed', { message: state.status.message })}</p>}
      {ready !== undefined && !ready.available && <p className={css.note}>{t('state.unavailable')}</p>}
      {ready !== undefined && ready.available && !ready.repo && <p className={css.note}>{t('state.notRepository')}</p>}
      {ready !== undefined && ready.repo && ready.entries.length === 0 && <p className={css.note}>{t('state.clean')}</p>}
      {ready !== undefined && ready.repo && sections !== undefined && (
        ([['staged', sections.staged, 'index'], ['unstaged', sections.unstaged, 'worktree'], ['untracked', sections.untracked, 'worktree']] as const)
          .filter(([, entries]) => entries.length > 0)
          .map(([name, entries, side]) => (
            <section key={name} className={css.section} data-git-section={name}>
              <h2 className={css.sectionTitle}>{t(`section.${name}`)} <span className={css.count}>{entries.length}</span></h2>
              <ul className={css.list}>
                {entries.map(entry => <EntryRow
                  key={`${name}:${entry.path}`}
                  entry={entry}
                  side={side}
                  selection={state.selection}
                  state={state}
                  tabId={tab.id}
                  signal={signal}
                  open={open}
                  close={close}
                  stage={stage}
                  unstage={unstage}
                  t={t}
                />)}
              </ul>
            </section>
          ))
      )}
    </div>
    <footer className={css.commit}>
      {state.error !== undefined && <p className={css.error} role="alert">{state.error}</p>}
      {stagedCount === 0 && <p className={css.note}>{t('commit.nothingStaged')}</p>}
      <input
        className={css.input}
        value={state.message}
        placeholder={t('commit.placeholder')}
        aria-label={t('commit.placeholder')}
        disabled={state.committing}
        onChange={(event) => { actions.draft(tab.id, event.target.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && stagedCount > 0 && state.message.trim() !== '') {
            event.preventDefault()
            commit(tab.id, state.message, signal)
          }
        }}
      />
      <Button
        variant="primary"
        size="sm"
        disabled={state.committing || stagedCount === 0 || state.message.trim() === ''}
        onClick={() => { commit(tab.id, state.message, signal) }}
      >
        {state.committing ? t('commit.committing') : t('commit.action')}
      </Button>
    </footer>
  </div>
}
