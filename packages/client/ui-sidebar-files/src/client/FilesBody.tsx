// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2), area A11.
/**
 * The file tree's body: the session's workspace root, listed one level at a time.
 *
 * Everything the tree keeps lives in its store, keyed by tab; everything it asks
 * for goes through its injected face. The component itself only decides what to
 * draw for each absolute path and what a click means: a directory toggles, a
 * file opens through the owner's `tabActions` for a `file:` viewer to claim, and
 * anything else is shown but refuses to open. The header uses the shared
 * PathLabel for the root, followed by reload and workspace directory actions.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import clsx from 'clsx'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import {
  ContextMenu, FileTypeIcon, IconFolderCloseRegular, IconFolderOpenRegular, IconRefreshOutlineRegular, Tooltip,
  classifyFileType, useContextMenu, writeClipboard,
  IconPauseOutlineRegular, IconPlayOutlineRegular, PathLabel,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import { childPath } from './face.ts'
import type { FilesInjected, WorkspacePathApplication } from './face.ts'
import type {} from './locales.ts'
import type { FilesTabState, createFilesStore } from './store.ts'
import css from './FilesBody.module.css'

/** The body's composed props: the tab it draws, its store, its face, and its copy. */
export type FilesBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.right.tab.files.actions'>
  & PropsStore<ReturnType<typeof createFilesStore>>
  & FilesInjected
  & PropsLocale<'sidebarFiles'>

/** Natural, case-insensitive name order, so `file2` precedes `file10`. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Order one level's entries for display: directories first, then everything
 * else, each group by name. The endpoint's order is a listing fact; this is the
 * reader's.
 * @param entries - the listing as the endpoint returned it.
 * @returns a new array, directories first, then by name within each group.
 */
export function orderEntries(entries: readonly WorkspaceDirectoryEntry[]): WorkspaceDirectoryEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.type === 'directory') - Number(left.type === 'directory')
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
}

/**
 * Say why a directory could not be listed, in terms of the directory.
 * @param t - namespace-bound translate.
 * @param failure - the settled Remote failure.
 * @returns the line to show under the directory.
 */
export function failureLine(t: TranslateNS<'sidebarFiles'>, failure: RemoteFailure): string {
  switch (failure.code) {
    case 'workspace-file/not-found': return t('error.notFound')
    case 'workspace-file/outside-workspace': return t('error.outsideWorkspace')
    case 'workspace-file/not-directory': return t('error.notDirectory')
    // Carrier and unclassified host failures reach the reader as themselves:
    // this tree knows nothing useful to add to a transport-level message.
    default: return t('error.unavailable', { message: failure.message })
  }
}

/** What every level shares: the tab's tree and the row gestures. */
interface TreeContext {
  readonly state: FilesTabState
  readonly onToggle: (parent: string, path: string) => void
  readonly onOpen: (path: string) => void
  readonly paths: FilesInjected['paths']
  /** Report a failed row action above the tree. */
  readonly reportFailure: (text: string) => void
  /** Clear the previous row-action failure before a new action runs. */
  readonly clearFailure: () => void
  readonly t: TranslateNS<'sidebarFiles'>
}

/** The relative spelling of an absolute path under the tree root. */
function relativePath(root: string, path: string): string {
  const base = root.replace(/[/\\]+$/, '')
  // The tree only lists children of its root, so the prefix always matches.
  return path.slice(base.length + 1)
}

/**
 * One file row: the tree's single-click preview plus its secondary-press menu
 * (preview, default open, explicit handlers, and the two path spellings).
 * @param props.path - absolute file path.
 * @param props.name - the file's basename.
 * @param props.tree - the level's shared tree context.
 * @returns the file row.
 */
function FileEntry({ path, name, tree }: { path: string; name: string; tree: TreeContext }): ReactNode {
  const menu = useContextMenu()
  const [applications, setApplications] = useState<readonly WorkspacePathApplication[] | null>(null)
  // The handler list is a Host query; asking on open keeps a large directory
  // from querying every file it lists.
  const openMenu = (event: ReactMouseEvent): void => {
    menu.open(event)
    void tree.paths.applications(path).then(setApplications)
  }
  const copy = (text: string): void => {
    void writeClipboard(text).then((copied) => { if (!copied) tree.reportFailure(tree.t('copy.failed')) })
  }
  const items: readonly MenuEntry[] = [
    { id: 'preview', label: tree.t('menu.preview') },
    { id: 'open', label: tree.t('menu.open') },
    ...(applications !== null && applications.length > 0
      ? [{
        id: 'open-with',
        label: tree.t('menu.openWith'),
        submenu: applications.map(application => ({ id: `application:${application.id}`, label: application.name })),
      }]
      : []),
    { type: 'separator', id: 'menu-paths' },
    { id: 'copy-relative', label: tree.t('menu.copyRelative') },
    { id: 'copy-absolute', label: tree.t('menu.copyAbsolute') },
  ]
  const select = (id: string): void => {
    tree.clearFailure()
    if (id === 'preview') {
      tree.onOpen(path)
      return
    }
    if (id === 'copy-relative' || id === 'copy-absolute') {
      copy(id === 'copy-relative' ? relativePath(tree.state.root, path) : path)
      return
    }
    // Every remaining row opens the file: the default handler, or one named
    // by the `application:<id>` submenu row.
    const application = id === 'open' ? undefined : id.slice('application:'.length)
    void tree.paths.openPath(path, application).then((opened) => {
      if (!opened) tree.reportFailure(tree.t('error.openFailed'))
    })
  }
  return (
    <li className={css.item} data-files-entry="file" data-files-path={path}>
      <button type="button" className={css.row} onClick={() => { tree.onOpen(path) }} onContextMenu={openMenu}>
        <FileTypeIcon kind={classifyFileType(name)} size={16} className={css.fileIcon} />
        <span className={css.name}>{name}</span>
      </button>
      <ContextMenu state={menu} items={items} onSelect={select} />
    </li>
  )
}

/** One entry's row, and its children when it is an expanded directory. */
function Entry({ parent, entry, tree }: { parent: string; entry: WorkspaceDirectoryEntry; tree: TreeContext }): ReactNode {
  const path = childPath(parent, entry.name)
  if (entry.type === 'directory') {
    const expanded = tree.state.expanded.includes(path)
    return (
      <li className={css.item} data-files-entry="directory" data-files-path={path}>
        <button type="button" className={css.row} aria-expanded={expanded} onClick={() => { tree.onToggle(parent, path) }}>
          {expanded ? <IconFolderOpenRegular className={css.icon} /> : <IconFolderCloseRegular className={css.icon} />}
          <span className={css.name}>{entry.name}</span>
        </button>
        {expanded && <ul className={css.level}><Level path={path} tree={tree} /></ul>}
      </li>
    )
  }
  if (entry.type === 'file') return <FileEntry path={path} name={entry.name} tree={tree} />
  return (
    <li className={css.item} data-files-entry="other" data-files-path={path}>
      <span className={clsx(css.row, css.other)} aria-disabled="true" title={tree.t('entry.other')}>
        <span className={css.name}>{entry.name}</span>
      </span>
    </li>
  )
}

/** One directory's rows: its state while listing, its entries once listed. */
function Level({ path, tree }: { path: string; tree: TreeContext }): ReactNode {
  const { state, t } = tree
  const level = state.levels[path]
  if (level === undefined || level.kind === 'loading') {
    return <li className={css.note} data-files-row="loading">{t('loading')}</li>
  }
  if (level.kind === 'failed') {
    return (
      <li className={css.note} data-files-row="failed" data-files-code={level.failure.code}>
        {failureLine(t, level.failure)}
      </li>
    )
  }
  const entries = orderEntries(level.level.entries)
  return (
    <>
      {level.failure !== undefined && <li className={css.note} data-files-row="failed">{failureLine(t, level.failure)}</li>}
      {entries.length === 0 && <li className={css.note} data-files-row="empty">{t('empty')}</li>}
      {entries.map(entry => <Entry key={entry.name} parent={path} entry={entry} tree={tree} />)}
      {level.level.truncated && <li className={css.note} data-files-row="truncated">{t('truncated')}</li>}
    </>
  )
}

/** The file tree's body: the workspace root and whatever the reader has opened under it. */
export function FilesBody({
  useTabInfo, sessionId, useSessions, useStore, actions,
  start, refresh, setAutoRefresh, toggle, t, renderSlot, paths,
}: FilesBodyProps): ReactNode {
  const { tab } = useTabInfo()
  useEffect(() => tab.actions.bindCommands({ refresh: () => { refresh(tab.id) } }), [tab.actions, tab.id, refresh])
  const { signal, actions: tabActions } = tab
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const state = useStore(store => store.byTab[tab.id])
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollTopRef = useRef(0)
  // A failed row action (open or clipboard write) surfaces above the tree
  // until the next action replaces it.
  const [actionError, setActionError] = useState<string | null>(null)
  // Come back where the reader was: loaded levels outlive the body in the
  // store, so a remounted tree lays out at its full height before this runs
  // and the stored offset re-lands exactly. A fresh tree stores 0.
  const seeded = state !== undefined
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (seeded && body !== null) {
      body.scrollTop = state.scrollTop
      scrollTopRef.current = body.scrollTop
    }
  }, [seeded])
  // Scrolling only moves the ref; the store hears about it once, on unmount,
  // so a scroll neither re-renders the tree nor writes after the owner's
  // abort has forgotten the bucket.
  useEffect(() => () => {
    if (seeded && !signal.aborted) actions.scrolled(tab.id, scrollTopRef.current)
  }, [seeded, signal, tab.id, actions])
  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (state !== undefined || cwd === undefined || signal.aborted) return
    start(tab.id, cwd, signal)
  }, [state, cwd, tab.id, signal, start])

  if (cwd === undefined) {
    return (
      <div className={css.status} data-files-state="no-workspace">
        <p className={css.statusLine}>{t('noWorkspace')}</p>
      </div>
    )
  }
  if (state === undefined) return null
  const tree: TreeContext = {
    state,
    onToggle: (parent, path) => { toggle(tab.id, parent, path, state.expanded, signal) },
    // Every row is under the tree's root, so its address is session-relative.
    onOpen: (path) => { tabActions.openResource(fileAddressFor(sessionId, state.root, path)) },
    paths,
    reportFailure: setActionError,
    clearFailure: () => { setActionError(null) },
    t,
  }
  const reload = (): void => {
    refresh(tab.id)
  }
  return (
    <div className={css.root} data-files-state="tree" data-files-root={state.root}>
      <div className={css.header}>
        <PathLabel path={state.root} className={css.path} data-files-path />
        <span hidden>
          <button type="button" className={css.tool} aria-label={t('autoRefresh')}
            aria-pressed={state.autoRefresh} data-files-auto-refresh
            title={t(state.autoRefresh ? 'autoRefresh.disable' : 'autoRefresh.enable')}
            onClick={() => { setAutoRefresh(tab.id, !state.autoRefresh) }}>
            {state.autoRefresh ? <IconPauseOutlineRegular /> : <IconPlayOutlineRegular />}
          </button>
        </span>
        <Tooltip label={t('reload')} shortcutKeys={tab.refreshShortcut?.keys} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.tool}
            aria-label={t('reload')}
            aria-keyshortcuts={tab.refreshShortcut?.aria}
            data-files-reload
            onClick={reload}
          >
            <IconRefreshOutlineRegular />
          </button>
        </Tooltip>
        {renderSlot('sidebar.right.tab.files.actions', {
          absolutePath: state.root,
        })}
      </div>
      <div
        ref={bodyRef}
        className={css.body}
        data-files-body
        onScroll={(event) => { scrollTopRef.current = event.currentTarget.scrollTop }}
      >
        {actionError !== null && (
          <p className={css.statusLine} data-files-action-error role="alert">{actionError}</p>
        )}
        <ul className={css.level}><Level path={state.root} tree={tree} /></ul>
      </div>
    </div>
  )
}
