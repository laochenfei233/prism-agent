/** Command palette: filters the live command catalog and runs the selected command. */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Modal, ShortcutKeys, Toast, focusWithoutRing, rankByName } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot, PropsStore } from '@deepseek-ai/dsh-client-store'
import type { ShortcutCatalogEntry, ShortcutCommandId, Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { createCommandPaletteStore } from './palette-store.ts'
import layout from './Reference.module.css'
import css from './CommandPalette.module.css'

/** Live catalog and the command runner the palette dispatches into. */
export interface CommandPaletteInjected {
  invoke: Shortcuts['invoke']
  hooks: { catalog: ObservableSnapshot<readonly ShortcutCatalogEntry[]> }
}
type Store = PropsStore<ReturnType<typeof createCommandPaletteStore>>
type Locale = PropsLocale<'shortcuts'>

/**
 * Render one searchable list of every registered command.
 * @param props - palette store, live catalog, and localized copy.
 * @returns the palette dialog while open, plus the blocked-reason toast it reports after closing.
 */
export function CommandPalette({ useStore, actions, useCatalog, invoke, t }:
  PropsRuntime<'shell.overlay'> & Store & Locale & InjectFace<CommandPaletteInjected>) {
  const { open, query, focusRequest } = useStore(state => state)
  const catalog = useCatalog(value => value)
  const [index, setIndex] = useState(0)
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null)
  const sequence = useRef(0)
  const search = useRef<HTMLInputElement>(null)
  const rows = useMemo(() => rankByName(catalog.map(row => ({ name: row.label, label: row.aliases.join(' '), row })),
    query.trim()).map(match => match.row), [catalog, query])
  const selected = rows[Math.min(index, Math.max(rows.length - 1, 0))]
  const cancel = (): void => { actions.close() }
  const run = (id: ShortcutCommandId): void => {
    cancel()
    // The modal primitive restores the invoking focus while it unmounts, so the command resolves against that element.
    requestAnimationFrame(() => {
      const result = invoke(id, { region: 'page', modal: null, target: document.activeElement })
      if (result?.status !== 'blocked') return
      sequence.current += 1
      setToast({ text: result.reason, seq: sequence.current })
    })
  }
  useLayoutEffect(() => {
    if (open && search.current !== null) focusWithoutRing(search.current)
  }, [open, focusRequest])
  useLayoutEffect(() => {
    if (!open || selected === undefined) return
    document.getElementById(`palette-${selected.id}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, selected])
  const move = (delta: number): void => {
    if (rows.length === 0) return
    setIndex(current => (Math.min(current, rows.length - 1) + delta + rows.length) % rows.length)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
    else if (event.key === 'Home') { event.preventDefault(); setIndex(0) }
    else if (event.key === 'End') { event.preventDefault(); setIndex(Math.max(rows.length - 1, 0)) }
    else if (event.key === 'Enter' && selected !== undefined) { event.preventDefault(); run(selected.id) }
  }
  return <>
    <Modal open={open} onClose={cancel} title={t('palette.title')} headless shortcutModal="commands"
      className={layout.dialog as string}>
      <div className={layout.contents}>
        <header className={layout.header}>
          <h2 className={layout.title}>{t('palette.title')}</h2>
        </header>
        <div className={layout.searchRow}>
          <div className={layout.searchField} role="search" aria-label={t('palette.search')}>
            <input ref={search} data-modal-autofocus className={layout.search} type="search" role="combobox"
              aria-expanded="true" aria-controls="command-palette-list" aria-autocomplete="list"
              aria-activedescendant={selected === undefined ? undefined : `palette-${selected.id}`}
              aria-label={t('palette.search')} placeholder={t('palette.search')} value={query}
              onChange={(event) => { setIndex(0); actions.search(event.target.value) }} onKeyDown={onKeyDown} />
          </div>
        </div>
        <div className={layout.list}>
          <ul id="command-palette-list" role="listbox" aria-label={t('palette.title')} className={layout.rows}>
            {rows.map((row, position) => <li key={row.id} id={`palette-${row.id}`} role="option"
              aria-selected={position === index} className={position === index ? `${layout.row} ${css.selected}` : layout.row}
              onClick={() => { run(row.id) }}>
              <span className={layout.commandLabel}>{row.label}</span>
              <span className={layout.binding}>
                {row.keys.length === 0
                  ? <span className={layout.unbound}>{t('unbound')}</span>
                  : <ShortcutKeys keys={row.keys} className={layout.keyBadge} />}
              </span>
            </li>)}
          </ul>
          {rows.length === 0 && <p className={layout.hint} role="status">{t('palette.empty')}</p>}
        </div>
      </div>
    </Modal>
    {toast !== null && <Toast key={toast.seq} text={toast.text} onDone={() => { setToast(null) }} />}
  </>
}
