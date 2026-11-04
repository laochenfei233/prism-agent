/**
 * The annotation actions: two one-click toggles and the editor row in
 * `sidebar.workspaces.session.menu.item`, plus the `shell.overlay` dialog that
 * answers the editor request. The dialog lives outside the row menu because
 * the row unmounts with the menu; its draft is keyed by Session so a new
 * request starts fresh.
 */
import { useState } from 'react'
import {
  Button, IconLikeFillRegular, IconListPenOutlineRegular, IconQueueOutlineRegular, MenuItemButton, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  annotationPrompt, type AnnotationDraft, composeAnnotation, DEFAULT_PRIORITY, formatTags,
  parseAnnotationImport, type SessionAnnotation, type SessionPriority,
} from '../annotations.ts'
import type {
  SessionAnnotationDialogProps, SessionAnnotationInjected, SessionAnnotationTarget, SessionMenuItemProps,
} from '../contract/slots.ts'
import css from '../rows/WorkspaceBrowser.module.css'

/** The five priority rows of the editor's select, in display order. */
const PRIORITY_KEYS = ['priority.1', 'priority.2', 'priority.3', 'priority.4', 'priority.5'] as const

/**
 * Menu row (order 150): toggle the row's favorite mark.
 * @param props - owner share, the annotation share, and the menu open state.
 * @returns the row.
 */
export function FavoriteSessionMenuItem(props: SessionMenuItemProps<SessionAnnotationInjected>) {
  const { sessionId, useMenuOpenState, useAnnotations, setAnnotation, t } = props
  const [, setMenuOpen] = useMenuOpenState()
  const annotation = useAnnotations(all => all[sessionId])
  const favorite = annotation?.favorite === true
  return (
    <MenuItemButton
      icon={<IconLikeFillRegular />}
      onSelect={() => {
        setMenuOpen(false)
        setAnnotation(sessionId, { ...annotation, favorite: !favorite })
      }}
    >
      {t(favorite ? 'menu.unfavoriteSession' : 'menu.favoriteSession')}
    </MenuItemButton>
  )
}

/**
 * Menu row (order 160): toggle the row's review-later mark.
 * @param props - owner share, the annotation share, and the menu open state.
 * @returns the row.
 */
export function ReviewLaterSessionMenuItem(props: SessionMenuItemProps<SessionAnnotationInjected>) {
  const { sessionId, useMenuOpenState, useAnnotations, setAnnotation, t } = props
  const [, setMenuOpen] = useMenuOpenState()
  const annotation = useAnnotations(all => all[sessionId])
  const reviewLater = annotation?.reviewLater === true
  return (
    <MenuItemButton
      icon={<IconQueueOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        setAnnotation(sessionId, { ...annotation, reviewLater: !reviewLater })
      }}
    >
      {t(reviewLater ? 'menu.unreviewSession' : 'menu.reviewLaterSession')}
    </MenuItemButton>
  )
}

/**
 * Menu row (order 250): ask for the editor dialog.
 * @param props - owner share, the annotation share, and the menu open state.
 * @returns the row.
 */
export function AnnotateSessionMenuItem({
  sessionId, displayTitle, useMenuOpenState, requestAnnotation, t,
}: SessionMenuItemProps<SessionAnnotationInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      icon={<IconListPenOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        requestAnnotation(sessionId, displayTitle)
      }}
    >
      {t('menu.annotate')}
    </MenuItemButton>
  )
}

/**
 * The `shell.overlay` entry: nothing while no edit is requested, otherwise one
 * dialog per request, seeded from the Session's stored annotation.
 * @param props - the request hook, the annotation hook, the write and clipboard
 * hops, settlement, and the locale seat.
 * @returns the open dialog, or null.
 */
export function SessionAnnotationDialog({
  useAnnotationRequest, useAnnotations, settleSessionAnnotation, setAnnotation,
  copyAnnotationPrompt, readAnnotationClipboard, t,
}: SessionAnnotationDialogProps) {
  const request = useAnnotationRequest(pending => pending)
  const annotations = useAnnotations(all => all)
  if (request === null) return null
  return (
    <AnnotationForm
      key={request.sessionId}
      request={request}
      annotation={annotations[request.sessionId]}
      setAnnotation={setAnnotation}
      copyAnnotationPrompt={copyAnnotationPrompt}
      readAnnotationClipboard={readAnnotationClipboard}
      onSettle={settleSessionAnnotation}
      t={t}
    />
  )
}

/** One request's dialog: the draft seeds from the stored annotation on mount and dies with it. */
function AnnotationForm({
  request, annotation, setAnnotation, copyAnnotationPrompt, readAnnotationClipboard, onSettle, t,
}: {
  request: SessionAnnotationTarget
  annotation: SessionAnnotation | undefined
  setAnnotation: SessionAnnotationDialogProps['setAnnotation']
  copyAnnotationPrompt: SessionAnnotationDialogProps['copyAnnotationPrompt']
  readAnnotationClipboard: SessionAnnotationDialogProps['readAnnotationClipboard']
  onSettle: () => void
  t: SessionAnnotationDialogProps['t']
}) {
  const [draft, setDraft] = useState<AnnotationDraft>({
    favorite: annotation?.favorite === true,
    reviewLater: annotation?.reviewLater === true,
    priority: annotation?.priority ?? DEFAULT_PRIORITY,
    tags: formatTags(annotation?.tags),
    note: annotation?.note ?? '',
  })
  const [notice, setNotice] = useState<string | null>(null)
  const update = (patch: Partial<AnnotationDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    setNotice(null)
  }
  // The dialog publishes what the draft means, not the raw fields, so the
  // clipboard prompt and the stored record agree on one set of values.
  const composed = composeAnnotation(draft)
  const save = (): void => {
    setAnnotation(request.sessionId, composed)
    onSettle()
  }
  // clipboard: the prompt leaves with the current draft as its context; the
  // import replaces the draft only after it parses, so a bad answer never
  // wipes what the user typed.
  const copyPrompt = async (): Promise<void> => {
    try {
      if (await copyAnnotationPrompt(annotationPrompt(t('annotation.prompt'), request.displayTitle, composed))) return
      setNotice(t('annotation.copyFailed'))
    } catch (error: unknown) {
      console.warn('annotation prompt copy failed:', error)
      setNotice(t('annotation.copyFailed'))
    }
  }
  const importFromClipboard = async (): Promise<void> => {
    let text: string
    try {
      text = await readAnnotationClipboard()
    } catch (error: unknown) {
      console.warn('annotation clipboard read failed:', error)
      setNotice(t('annotation.readFailed'))
      return
    }
    try {
      const imported = parseAnnotationImport(text)
      setDraft({
        favorite: imported.favorite === true,
        reviewLater: imported.reviewLater === true,
        priority: imported.priority ?? DEFAULT_PRIORITY,
        tags: formatTags(imported.tags),
        note: imported.note ?? '',
      })
      setNotice(null)
    } catch (error: unknown) {
      console.warn('annotation import rejected:', error)
      setNotice(t('annotation.importFailed'))
    }
  }
  return (
    <Modal
      open
      onClose={onSettle}
      closeLabel={t('close')}
      title={t('annotation.title')}
      description={t('annotation.desc', { title: request.displayTitle })}
      footer={(
        <>
          <Button variant="outline" onClick={onSettle}>{t('cancel')}</Button>
          <Button variant="primary" onClick={save}>{t('save')}</Button>
        </>
      )}
    >
      <label className={css.annotationToggle}>
        <input
          type="checkbox"
          checked={draft.favorite}
          onChange={(e) => { update({ favorite: e.target.checked }) }}
        />
        <span>{t('annotation.favoriteField')}</span>
      </label>
      <label className={css.annotationToggle}>
        <input
          type="checkbox"
          checked={draft.reviewLater}
          onChange={(e) => { update({ reviewLater: e.target.checked }) }}
        />
        <span>{t('annotation.reviewLaterField')}</span>
      </label>
      <label className={css.annotationField}>
        <span>{t('annotation.priorityField')}</span>
        <select
          className={css.annotationSelect}
          value={draft.priority}
          onChange={(e) => { update({ priority: Number(e.target.value) as SessionPriority }) }}
        >
          {PRIORITY_KEYS.map((key, index) => (
            <option key={key} value={index + 1}>{t(key)}</option>
          ))}
        </select>
      </label>
      <label className={css.annotationField}>
        <span>{t('annotation.tagsField')}</span>
        <input
          className={css.renameInput}
          value={draft.tags}
          maxLength={640}
          placeholder={t('annotation.tagsPlaceholder')}
          onChange={(e) => { update({ tags: e.target.value }) }}
        />
      </label>
      <label className={css.annotationField}>
        <span>{t('annotation.noteField')}</span>
        <textarea
          className={css.annotationNote}
          rows={4}
          value={draft.note}
          placeholder={t('annotation.notePlaceholder')}
          onChange={(e) => { update({ note: e.target.value }) }}
        />
      </label>
      <div className={css.annotationTools}>
        <Button variant="outline" onClick={() => { void copyPrompt() }}>{t('annotation.copyPrompt')}</Button>
        <Button variant="outline" onClick={() => { void importFromClipboard() }}>{t('annotation.import')}</Button>
        <span className={css.annotationHint}>{t('annotation.hint')}</span>
      </div>
      {notice !== null && <div className={css.renameError} role="alert">{notice}</div>}
    </Modal>
  )
}
