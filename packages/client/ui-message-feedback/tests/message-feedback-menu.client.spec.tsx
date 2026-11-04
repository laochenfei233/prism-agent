// @vitest-environment jsdom
/**
 * Message-menu feedback rows: both judgments render as menu rows, and either
 * one dismisses the menu before opening the Session's dialog for that message.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { MessageId } from '@deepseek-ai/dsh-api-remotes/client'
import { MessageFeedbackMenuItems } from '../src/client/MessageFeedbackMenuItems.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const MSG = 'm-1' as MessageId
const t = makeTranslate(zh, commonZh)

/** Render the rows over recording verbs and a stub menu-open hook. */
function mount() {
  const openDialog = vi.fn()
  const setMenuOpen = vi.fn()
  const useMenuOpenState = (() => [true, setMenuOpen]) as never
  const props = { messageId: MSG, openDialog, useMenuOpenState, t } as unknown as
    Parameters<typeof MessageFeedbackMenuItems>[0]
  return { ...render(<MessageFeedbackMenuItems {...props} />), openDialog, setMenuOpen }
}

describe('MessageFeedbackMenuItems', () => {
  it('renders one row per judgment', () => {
    const ui = mount()

    expect(ui.getByRole('menuitem', { name: zh['action.like'] })).toBeDefined()
    expect(ui.getByRole('menuitem', { name: zh['action.dislike'] })).toBeDefined()
  })

  it('dismisses the menu and opens the dialog for a positive judgment', () => {
    const ui = mount()

    fireEvent.click(ui.getByRole('menuitem', { name: zh['action.like'] }))

    expect(ui.setMenuOpen).toHaveBeenCalledExactlyOnceWith(false)
    expect(ui.openDialog).toHaveBeenCalledExactlyOnceWith(MSG, 'positive')
  })

  it('dismisses the menu and opens the dialog for a negative judgment', () => {
    const ui = mount()

    fireEvent.click(ui.getByRole('menuitem', { name: zh['action.dislike'] }))

    expect(ui.setMenuOpen).toHaveBeenCalledExactlyOnceWith(false)
    expect(ui.openDialog).toHaveBeenCalledExactlyOnceWith(MSG, 'negative')
  })
})
