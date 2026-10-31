// @vitest-environment jsdom
/** Command palette behavior: filtering, selection, execution, and blocked-reason feedback. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ShortcutCatalogEntry, ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { CommandPalette } from '../src/client/CommandPalette.tsx'
import { createCommandPaletteStore } from '../src/client/palette-store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const row = (id: string, label: string, aliases: readonly string[] = [], keys: readonly string[] = []): ShortcutCatalogEntry => ({
  id: id as ShortcutCommandId, label, aliases, keys, aria: undefined, binding: null, modified: false, conflicts: [], issue: null,
})

function fixture(rows: readonly ShortcutCatalogEntry[]) {
  const store = createCommandPaletteStore().create()
  const catalog = createSnapshotStore<readonly ShortcutCatalogEntry[]>(rows)
  const invoke = vi.fn<(id: ShortcutCommandId, context: unknown) => { status: string; reason?: string } | undefined>(
    () => ({ status: 'handled' }),
  )
  const props = { actions: store.actions, useStore: bindSnapshotSelector(store), useCatalog: bindSnapshotSelector(catalog),
    invoke, t: makeTranslate(en) } as unknown as Parameters<typeof CommandPalette>[0]
  const view = render(<CommandPalette {...props} />)
  return { store, catalog, invoke, view }
}

/** Let the palette's post-close frame invoke the command. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => { requestAnimationFrame(() => { resolve(null) }) })
    await new Promise(resolve => { requestAnimationFrame(() => { resolve(null) }) })
  })
}

it('stays closed until the command opens it', () => {
  const f = fixture([row('session.new', 'New session')])
  expect(screen.queryByRole('combobox')).toBeNull()
  act(() => { f.store.actions.open() })
  expect(screen.getByRole('combobox')).toBeTruthy()
})

it('filters by alias and runs the selected command after closing', async () => {
  const f = fixture([row('session.new', 'New session', ['new chat']), row('settings.open', 'Open settings', ['preferences'])])
  act(() => { f.store.actions.open() })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'preferences' } })
  expect(screen.getAllByRole('option')).toHaveLength(1)
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  await settle()
  expect(f.invoke).toHaveBeenCalledWith('settings.open', expect.objectContaining({ modal: null }))
  expect(f.store.getSnapshot().open).toBe(false)
})

it('moves the selection with the arrow keys and runs the highlighted command', async () => {
  const f = fixture([row('session.new', 'New session'), row('settings.open', 'Open settings')])
  act(() => { f.store.actions.open() })
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
  expect(screen.getAllByRole('option').map(option => option.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  await settle()
  expect(f.invoke).toHaveBeenCalledWith('settings.open', expect.anything())
})

it('reports the command reason when the run is blocked', async () => {
  const f = fixture([row('pane.split', 'Split pane')])
  f.invoke.mockReturnValue({ status: 'blocked', reason: 'No focused pane' })
  act(() => { f.store.actions.open() })
  fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
  await settle()
  expect(screen.getByText('No focused pane')).toBeTruthy()
  expect(f.store.getSnapshot().open).toBe(false)
})

it('lists a command registered after the palette opened', () => {
  const f = fixture([row('session.new', 'New session')])
  act(() => { f.store.actions.open() })
  expect(screen.getAllByRole('option')).toHaveLength(1)
  act(() => { f.catalog.set([...f.catalog.getSnapshot(), row('terminal.new', 'New terminal')]) })
  expect(screen.getAllByRole('option')).toHaveLength(2)
})
