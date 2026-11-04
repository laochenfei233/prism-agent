// @vitest-environment jsdom
/** Annotation menu toggles and the editor dialog, including the clipboard round-trip. */
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MenuOpenState, SessionAnnotationTarget } from '../src/client/contract/slots.ts'
import type { SessionAnnotation } from '../src/client/annotations.ts'
import {
  AnnotateSessionMenuItem, FavoriteSessionMenuItem, ReviewLaterSessionMenuItem, SessionAnnotationDialog,
} from '../src/client/session-actions/AnnotateSession.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(en, commonEn) as never
const sid = 'annotated-session' as SessionId
const menuOpen = (setOpen: (open: boolean) => void) => (): MenuOpenState => [true, setOpen]
const annotationsHook = (record: Record<string, SessionAnnotation>) =>
  (selector: (all: Record<string, SessionAnnotation>) => unknown) => selector(record)
const requestHook = (request: SessionAnnotationTarget | null) =>
  (selector: (pending: SessionAnnotationTarget | null) => unknown) => selector(request)

describe('annotation menu rows', () => {
  it('toggles the favorite mark on and dismisses', () => {
    const setOpen = vi.fn()
    const setAnnotation = vi.fn()
    render(createElement(FavoriteSessionMenuItem, {
      sessionId: sid, displayTitle: 'Session', useMenuOpenState: menuOpen(setOpen),
      useAnnotations: annotationsHook({}), setAnnotation, requestAnnotation: vi.fn(), t,
    } as never))
    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.favoriteSession'] }))
    expect(setAnnotation).toHaveBeenCalledExactlyOnceWith(sid, { favorite: true })
    expect(setOpen).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('shows the clear label and keeps other fields when already favorited', () => {
    const setAnnotation = vi.fn()
    render(createElement(FavoriteSessionMenuItem, {
      sessionId: sid, displayTitle: 'Session', useMenuOpenState: menuOpen(vi.fn()),
      useAnnotations: annotationsHook({ [sid]: { favorite: true, note: 'n' } }), setAnnotation,
      requestAnnotation: vi.fn(), t,
    } as never))
    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.unfavoriteSession'] }))
    expect(setAnnotation).toHaveBeenCalledExactlyOnceWith(sid, { favorite: false, note: 'n' })
  })

  it('toggles the review-later mark', () => {
    const setAnnotation = vi.fn()
    render(createElement(ReviewLaterSessionMenuItem, {
      sessionId: sid, displayTitle: 'Session', useMenuOpenState: menuOpen(vi.fn()),
      useAnnotations: annotationsHook({ [sid]: { reviewLater: true } }), setAnnotation,
      requestAnnotation: vi.fn(), t,
    } as never))
    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.unreviewSession'] }))
    expect(setAnnotation).toHaveBeenCalledExactlyOnceWith(sid, { reviewLater: false })
  })

  it('raises the editor request', () => {
    const requestAnnotation = vi.fn()
    render(createElement(AnnotateSessionMenuItem, {
      sessionId: sid, displayTitle: 'Session', useMenuOpenState: menuOpen(vi.fn()),
      useAnnotations: annotationsHook({}), setAnnotation: vi.fn(), requestAnnotation, t,
    } as never))
    fireEvent.click(screen.getByRole('menuitem', { name: en['menu.annotate'] }))
    expect(requestAnnotation).toHaveBeenCalledExactlyOnceWith(sid, 'Session')
  })
})

describe('annotation dialog', () => {
  const request: SessionAnnotationTarget = { sessionId: sid, displayTitle: 'Deploy session' }

  /** Render the dialog over one stored annotation and return the write/settlement spies. */
  function open(annotation: SessionAnnotation | undefined) {
    const setAnnotation = vi.fn()
    const settleSessionAnnotation = vi.fn()
    const copyAnnotationPrompt = vi.fn(async (_text: string) => true)
    const readAnnotationClipboard = vi.fn(async () => '')
    render(createElement(SessionAnnotationDialog, {
      useAnnotationRequest: requestHook(request),
      useAnnotations: annotationsHook(annotation === undefined ? {} : { [sid]: annotation }),
      settleSessionAnnotation,
      setAnnotation,
      copyAnnotationPrompt,
      readAnnotationClipboard,
      t,
    } as never))
    return { setAnnotation, settleSessionAnnotation, copyAnnotationPrompt, readAnnotationClipboard }
  }

  it('renders nothing without a request', () => {
    const { container } = render(createElement(SessionAnnotationDialog, {
      useAnnotationRequest: requestHook(null), useAnnotations: annotationsHook({}),
      settleSessionAnnotation: vi.fn(), setAnnotation: vi.fn(),
      copyAnnotationPrompt: vi.fn(), readAnnotationClipboard: vi.fn(), t,
    } as never))
    expect(container.innerHTML).toBe('')
  })

  it('seeds the draft and saves every field the user edits', () => {
    const { setAnnotation, settleSessionAnnotation } = open({ favorite: true, priority: 2, tags: ['deploy'], note: 'old' })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en['annotation.tagsField'] }).value).toBe('deploy')
    // Every control writes its own field: the two marks, the priority select,
    // the tag text, and the note.
    fireEvent.click(screen.getByRole('checkbox', { name: en['annotation.favoriteField'] }))
    fireEvent.click(screen.getByRole('checkbox', { name: en['annotation.reviewLaterField'] }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '4' } })
    fireEvent.change(screen.getByRole('textbox', { name: en['annotation.tagsField'] }), { target: { value: 'deploy, release' } })
    fireEvent.change(screen.getByRole('textbox', { name: en['annotation.noteField'] }), { target: { value: ' new note ' } })
    fireEvent.click(screen.getByRole('button', { name: commonEn.save }))
    expect(setAnnotation).toHaveBeenCalledExactlyOnceWith(sid, {
      reviewLater: true, priority: 4, tags: ['deploy', 'release'], note: 'new note',
    })
    expect(settleSessionAnnotation).toHaveBeenCalledOnce()
  })

  it('closes without writing when cancelled', () => {
    const { setAnnotation, settleSessionAnnotation } = open(undefined)
    fireEvent.click(screen.getByRole('button', { name: commonEn.cancel }))
    expect(setAnnotation).not.toHaveBeenCalled()
    expect(settleSessionAnnotation).toHaveBeenCalledOnce()
  })

  it('copies a prompt carrying the title and current annotation', async () => {
    const { copyAnnotationPrompt } = open({ favorite: true })
    fireEvent.click(screen.getByRole('button', { name: en['annotation.copyPrompt'] }))
    await waitFor(() => { expect(copyAnnotationPrompt).toHaveBeenCalledOnce() })
    const text = copyAnnotationPrompt.mock.calls[0]?.[0] ?? ''
    expect(text).toContain('Deploy session')
    expect(text).toContain('"favorite": true')
  })

  it('reports a refused and a failed copy', async () => {
    const refused = open(undefined)
    refused.copyAnnotationPrompt.mockResolvedValue(false)
    fireEvent.click(screen.getByRole('button', { name: en['annotation.copyPrompt'] }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['annotation.copyFailed']) })
    cleanup()
    const failed = open(undefined)
    failed.copyAnnotationPrompt.mockRejectedValue(new Error('denied'))
    fireEvent.click(screen.getByRole('button', { name: en['annotation.copyPrompt'] }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['annotation.copyFailed']) })
  })

  it('imports a clipboard answer into the draft', async () => {
    const { setAnnotation, readAnnotationClipboard } = open(undefined)
    readAnnotationClipboard.mockResolvedValue('{"favorite": true, "priority": 1, "tags": "a, b", "note": "next"}')
    fireEvent.click(screen.getByRole('button', { name: en['annotation.import'] }))
    await waitFor(() => { expect(screen.getByRole<HTMLInputElement>('textbox', { name: en['annotation.tagsField'] }).value).toBe('a, b') })
    fireEvent.click(screen.getByRole('button', { name: commonEn.save }))
    expect(setAnnotation).toHaveBeenCalledExactlyOnceWith(sid, {
      favorite: true, priority: 1, tags: ['a', 'b'], note: 'next',
    })
  })

  it('imports an answer that omits priority and note as their defaults', async () => {
    const { setAnnotation, readAnnotationClipboard } = open(undefined)
    readAnnotationClipboard.mockResolvedValue('{"favorite": true}')
    fireEvent.click(screen.getByRole('button', { name: en['annotation.import'] }))
    await waitFor(() => {
      expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en['annotation.favoriteField'] }).checked).toBe(true)
    })
    fireEvent.click(screen.getByRole('button', { name: commonEn.save }))
    expect(setAnnotation).toHaveBeenCalledExactlyOnceWith(sid, { favorite: true })
  })

  it('reports an unreadable clipboard and unparseable text without touching the draft', async () => {
    const unreadable = open({ note: 'kept' })
    unreadable.readAnnotationClipboard.mockRejectedValue(new Error('denied'))
    fireEvent.click(screen.getByRole('button', { name: en['annotation.import'] }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['annotation.readFailed']) })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en['annotation.noteField'] }).value).toBe('kept')
    cleanup()
    const unparseable = open({ note: 'kept' })
    unparseable.readAnnotationClipboard.mockResolvedValue('no json')
    fireEvent.click(screen.getByRole('button', { name: en['annotation.import'] }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en['annotation.importFailed']) })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en['annotation.noteField'] }).value).toBe('kept')
  })
})
