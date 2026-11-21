// @vitest-environment jsdom
/** Message-body context menu: selection fallback, copy, quote, side conversation, plugin rows. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { zh } from '../src/client/locale.ts'
import { ChatMessageActionsProvider, useMessageContextMenu } from '../src/client/chat/chat-message-actions.tsx'
import type { ChatMessageActions } from '../src/client/chat/chat-message-actions.tsx'

afterEach(() => {
  cleanup()
  window.getSelection()?.removeAllRanges()
})

const t = makeTranslate(zh) as never

function Body(): React.JSX.Element {
  const menu = useMessageContextMenu(t)
  return (
    <div ref={menu.ref} data-testid="body" onContextMenu={menu.onContextMenu}>
      {menu.menu}
      first line
      <span data-testid="tail"> second line</span>
    </div>
  )
}

function Harness({ actions }: { actions?: ChatMessageActions }): React.JSX.Element {
  return actions === undefined
    ? <Body />
    : <ChatMessageActionsProvider actions={actions}><Body /></ChatMessageActionsProvider>
}

function installClipboard(writeText: (text: string) => Promise<void>): () => void {
  const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return () => {
    if (prior === undefined) Reflect.deleteProperty(navigator, 'clipboard')
    else Object.defineProperty(navigator, 'clipboard', prior)
  }
}

it('copies the selected text when a selection lives inside the body', async () => {
  const writeText = vi.fn(async () => {})
  const restore = installClipboard(writeText)
  try {
    render(<Harness />)
    const body = screen.getByTestId('body')
    const range = document.createRange()
    range.selectNodeContents(body.querySelector('[data-testid="tail"]')!)
    window.getSelection()?.addRange(range)
    fireEvent.contextMenu(body, { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: zh['context.copy'] }))
    expect(writeText).toHaveBeenCalledExactlyOnceWith('second line')
  } finally { restore() }
})

it('falls back to the whole body text and appends it as a quote', () => {
  const actions = { appendQuote: vi.fn(), askInSideConversation: vi.fn() }
  render(<Harness actions={actions} />)
  fireEvent.contextMenu(screen.getByTestId('body'), { clientX: 10, clientY: 10 })
  fireEvent.click(screen.getByRole('menuitem', { name: zh['context.addToTask'] }))
  expect(actions.appendQuote).toHaveBeenCalledExactlyOnceWith('first line second line')
  expect(actions.askInSideConversation).not.toHaveBeenCalled()
})

it('starts a side conversation with the same text', () => {
  const actions = { appendQuote: vi.fn(), askInSideConversation: vi.fn() }
  render(<Harness actions={actions} />)
  fireEvent.contextMenu(screen.getByTestId('body'), { clientX: 10, clientY: 10 })
  fireEvent.click(screen.getByRole('menuitem', { name: zh['context.askSide'] }))
  expect(actions.askInSideConversation).toHaveBeenCalledExactlyOnceWith('first line second line')
})

it('disables the actions that need a provider when none is mounted', () => {
  render(<Harness />)
  fireEvent.contextMenu(screen.getByTestId('body'), { clientX: 10, clientY: 10 })
  expect(screen.getByRole('menuitem', { name: zh['context.addToTask'] }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('menuitem', { name: zh['context.askSide'] }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('menuitem', { name: zh['context.copy'] }).hasAttribute('disabled')).toBe(false)
})

it('does nothing when the pressed body holds no text', () => {
  const writeText = vi.fn(async () => {})
  const restore = installClipboard(writeText)
  try {
    function EmptyBody(): React.JSX.Element {
      const menu = useMessageContextMenu(t)
      return (
        <div ref={menu.ref} data-testid="empty" onContextMenu={menu.onContextMenu}>
          {menu.menu}
        </div>
      )
    }
    render(<EmptyBody />)
    fireEvent.contextMenu(screen.getByTestId('empty'), { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByRole('menuitem', { name: zh['context.copy'] }))
    expect(writeText).not.toHaveBeenCalled()
  } finally { restore() }
})

it('renders the plugin rows a settled message supplies, after the shipped rows', () => {
  const onPlugin = vi.fn()
  function BodyWithPlugins(): React.JSX.Element {
    const renderSlot = ((name: string) => name === 'conversation.chat.message.menu.item'
      ? <MenuItemButton onSelect={onPlugin}>plugin row</MenuItemButton>
      : null) as never
    const menu = useMessageContextMenu(t, { messageId: 'm-1' as never, renderSlot })
    return (
      <div ref={menu.ref} data-testid="body" onContextMenu={menu.onContextMenu}>
        {menu.menu}
        first line
      </div>
    )
  }
  render(<BodyWithPlugins />)
  fireEvent.contextMenu(screen.getByTestId('body'), { clientX: 10, clientY: 10 })

  const labels = screen.getAllByRole('menuitem').map(item => item.textContent)
  expect(labels).toEqual([zh['context.copy'], zh['context.addToTask'], zh['context.askSide'], 'plugin row'])
  fireEvent.click(screen.getByRole('menuitem', { name: 'plugin row' }))
  expect(onPlugin).toHaveBeenCalledTimes(1)
})
