/**
 * The workspace browser's batch-mode surface, extracted from WorkspaceBrowser:
 * the toolbar over the current selection (count, select all, clear, actions
 * menu, exit) and the actions menu itself. Presentational only — the
 * selection state and the run semantics stay in WorkspaceBrowser and arrive
 * as callbacks. The pocket plugin styles this DOM and interaction tests assert
 * its structure, so element structure and class names are load-bearing.
 */
import { useState } from 'react'
import {
  IconArchiveCheckOutlineRegular, IconArchiveOutlineRegular, IconLikeFillRegular, IconListPenOutlineRegular,
  IconQueueOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionPriority } from '../annotations.ts'
import type { BatchAction, WorkspaceBrowserProps } from '../contract/slots.ts'
import css from './WorkspaceBrowser.module.css'

/** Priority rows of the batch menu, in display order. */
const BATCH_PRIORITIES = [
  { id: 'priority-1', priority: 1, label: 'priority.1' },
  { id: 'priority-2', priority: 2, label: 'priority.2' },
  { id: 'priority-3', priority: 3, label: 'priority.3' },
  { id: 'priority-4', priority: 4, label: 'priority.4' },
  { id: 'priority-5', priority: 5, label: 'priority.5' },
] as const satisfies readonly { id: string; priority: SessionPriority; label: Parameters<WorkspaceBrowserProps['t']>[0] }[]

/**
 * Resolve one batch-menu row id to the action it runs.
 * @param id - the menu's row id.
 * @returns the action, or undefined for a non-action row.
 */
function batchActionOf(id: string): BatchAction | undefined {
  switch (id) {
    case 'archive': return { kind: 'archive' }
    case 'unarchive': return { kind: 'unarchive' }
    case 'favorite': return { kind: 'favorite' }
    case 'unfavorite': return { kind: 'unfavorite' }
    case 'review-later': return { kind: 'reviewLater' }
    case 'unreview': return { kind: 'unreview' }
    case 'clear-tags': return { kind: 'clearTags' }
    case 'priority-1': return { kind: 'priority', priority: 1 }
    case 'priority-2': return { kind: 'priority', priority: 2 }
    case 'priority-3': return { kind: 'priority', priority: 3 }
    case 'priority-4': return { kind: 'priority', priority: 4 }
    case 'priority-5': return { kind: 'priority', priority: 5 }
    /* v8 ignore next -- the menu emits only the ids listed above. */
    default: return undefined
  }
}

/**
 * The batch menu: every action the browser can run over the current selection.
 * @param props.disabled - whether no Session is selected; the anchor button disables.
 * @param props.onPick - run one resolved action over the selection.
 * @param props.t - the browser root's locale seat.
 * @returns the menu element.
 */
function BatchActionsMenu({ disabled, onPick, t }: {
  disabled: boolean
  onPick: (action: BatchAction) => void
  t: WorkspaceBrowserProps['t']
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={[
        { id: 'archive', label: t('batch.archive'), icon: <IconArchiveOutlineRegular /> },
        { id: 'unarchive', label: t('batch.unarchive'), icon: <IconArchiveCheckOutlineRegular /> },
        { type: 'separator' as const, id: 'batch-mark-separator' },
        { id: 'favorite', label: t('batch.favorite'), icon: <IconLikeFillRegular /> },
        { id: 'unfavorite', label: t('batch.unfavorite'), icon: <IconLikeFillRegular /> },
        { id: 'review-later', label: t('batch.reviewLater'), icon: <IconQueueOutlineRegular /> },
        { id: 'unreview', label: t('batch.unreview'), icon: <IconQueueOutlineRegular /> },
        { type: 'separator' as const, id: 'batch-tags-separator' },
        { id: 'clear-tags', label: t('batch.clearTags'), icon: <IconListPenOutlineRegular /> },
        { type: 'separator' as const, id: 'batch-priority-separator' },
        { type: 'label' as const, id: 'batch-priority', text: t('batch.priority') },
        ...BATCH_PRIORITIES.map(row => ({ id: row.id, label: t(row.label) })),
      ]}
      onSelect={(id) => {
        setOpen(false)
        const action = batchActionOf(id)
        if (action !== undefined) onPick(action)
      }}
      align="end"
      dense
      listClassName={css.viewOptionsMenu}
      portal
      anchor={(
        <button
          type="button"
          className={css.batchAction}
          disabled={disabled}
          aria-disabled={disabled}
          onClick={() => { setOpen(v => !v) }}
        >
          {t('batch.actions')}
        </button>
      )}
    />
  )
}

/**
 * The batch-mode toolbar: selection count, the bulk pick buttons, the actions
 * menu, and the exit; the browser renders it only while batch mode is on.
 * @param props.count - number of currently selected Sessions.
 * @param props.onSelectAll - select every visible non-blank Session.
 * @param props.onClear - drop the whole selection.
 * @param props.onPick - run one batch action over the selection.
 * @param props.onExit - leave batch mode, dropping the selection.
 * @param props.t - the browser root's locale seat.
 * @returns the toolbar element.
 */
export function BatchActionsToolbar({ count, onSelectAll, onClear, onPick, onExit, t }: {
  /** Number of currently selected Sessions; drives the clear and menu disabled states. */
  count: number
  /** Select every visible non-blank Session. */
  onSelectAll: () => void
  /** Drop the whole selection. */
  onClear: () => void
  /** Run one batch action over the selection. */
  onPick: (action: BatchAction) => void
  /** Leave batch mode, dropping the selection. */
  onExit: () => void
  /** The browser root's locale seat. */
  t: WorkspaceBrowserProps['t']
}) {
  return (
    <div className={css.batchBar} role="toolbar" aria-label={t('batch.mode')}>
      <span className={css.batchCount}>{t('batch.count', { n: count })}</span>
      <button
        type="button"
        className={css.batchAction}
        onClick={onSelectAll}
      >
        {t('batch.selectAll')}
      </button>
      <button
        type="button"
        className={css.batchAction}
        disabled={count === 0}
        onClick={onClear}
      >
        {t('batch.clear')}
      </button>
      <BatchActionsMenu disabled={count === 0} onPick={onPick} t={t} />
      <button type="button" className={css.batchAction} onClick={onExit}>{t('batch.exit')}</button>
    </div>
  )
}
