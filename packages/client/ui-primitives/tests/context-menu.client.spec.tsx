// @vitest-environment jsdom
/** Pointer-anchored context menus: suppression, placement, selection, dismissal. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ContextMenu, useContextMenu } from '../src/ContextMenu.tsx'

afterEach(cleanup)

function Harness({ onSelect }: { onSelect?: (id: string) => void }): React.JSX.Element {
  const state = useContextMenu()
  return (
    <div data-testid="row" onContextMenu={state.open}>
      row
      <ContextMenu
        state={state}
        items={[{ id: 'copy', label: 'Copy' }, { type: 'separator', id: 'sep' }, { id: 'paste', label: 'Paste' }]}
        {...onSelect === undefined ? {} : { onSelect }}
      />
    </div>
  )
}

it('opens at the press point, suppressing the browser menu', () => {
  render(<Harness />)
  expect(screen.queryByRole('menu')).toBeNull()
  const row = screen.getByTestId('row')
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })
  fireEvent(row, event)
  expect(event.defaultPrevented).toBe(true)
  const menu = screen.getByRole('menu')
  expect(menu.style.left).toBe('40px')
  expect(menu.style.top).toBe('64px')
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Copy', 'Paste'])
})

it('runs the selected row once and dismisses', () => {
  const onSelect = vi.fn()
  render(<Harness onSelect={onSelect} />)
  fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 10, clientY: 10 })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Paste' }))
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('paste')
  expect(screen.queryByRole('menu')).toBeNull()
})

it('dismisses on Escape without activating a row', () => {
  const onSelect = vi.fn()
  render(<Harness onSelect={onSelect} />)
  fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 10, clientY: 10 })
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(onSelect).not.toHaveBeenCalled()
})

it('dismisses on an outside press', () => {
  render(<Harness />)
  fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 10, clientY: 10 })
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('menu')).toBeNull()
})

it('renders pinned footer rows without requiring a selection owner', () => {
  function FooterHarness(): React.JSX.Element {
    const state = useContextMenu()
    return (
      <div data-testid="row" onContextMenu={state.open}>
        <ContextMenu
          state={state}
          items={[{ id: 'copy', label: 'Copy' }]}
          footer={[{ id: 'settings', label: 'Settings' }]}
          compact
        />
      </div>
    )
  }
  render(<FooterHarness />)
  fireEvent.contextMenu(screen.getByTestId('row'), { clientX: 10, clientY: 10 })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }))
  expect(screen.queryByRole('menu')).toBeNull()
})
