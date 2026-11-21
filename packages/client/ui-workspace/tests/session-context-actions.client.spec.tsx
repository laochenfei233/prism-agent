// @vitest-environment jsdom
// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2), area A12.
/** The secondary-click rows: reveal, copy path, and settings dismiss and act once. */
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { MenuOpenState } from '../src/client/contract/slots.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  CopySessionPathMenuItem, RevealSessionMenuItem, SessionSettingsMenuItem,
} from '../src/client/session-actions/SessionContextActions.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(en, commonEn) as never
const sid = 'context-session' as SessionId
const menuOpen = (setOpen: (open: boolean) => void) => (): MenuOpenState => [true, setOpen]
const useShortcuts = (selector: (rows: readonly never[]) => unknown): unknown => selector([])

it('reveals the working directory and dismisses', () => {
  const setOpen = vi.fn()
  const revealSession = vi.fn()
  render(createElement(RevealSessionMenuItem, {
    sessionId: sid, displayTitle: 'Context', useMenuOpenState: menuOpen(setOpen), useShortcuts,
    revealSession, copySessionPath: vi.fn(), t,
  } as never))
  fireEvent.click(screen.getByRole('menuitem', { name: en['menu.revealSession'] }))
  expect(revealSession).toHaveBeenCalledExactlyOnceWith(sid)
  expect(setOpen).toHaveBeenCalledExactlyOnceWith(false)
})

it('copies the working directory and dismisses', () => {
  const setOpen = vi.fn()
  const copySessionPath = vi.fn()
  render(createElement(CopySessionPathMenuItem, {
    sessionId: sid, displayTitle: 'Context', useMenuOpenState: menuOpen(setOpen), useShortcuts,
    revealSession: vi.fn(), copySessionPath, t,
  } as never))
  fireEvent.click(screen.getByRole('menuitem', { name: en['menu.copySessionPath'] }))
  expect(copySessionPath).toHaveBeenCalledExactlyOnceWith(sid)
  expect(setOpen).toHaveBeenCalledExactlyOnceWith(false)
})

it('opens settings and dismisses', () => {
  const setOpen = vi.fn()
  const openSettings = vi.fn()
  render(createElement(SessionSettingsMenuItem, {
    sessionId: sid, displayTitle: 'Context', useMenuOpenState: menuOpen(setOpen), useShortcuts, openSettings, t,
  } as never))
  fireEvent.click(screen.getByRole('menuitem', { name: en['menu.settings'] }))
  expect(openSettings).toHaveBeenCalledOnce()
  expect(setOpen).toHaveBeenCalledExactlyOnceWith(false)
})
