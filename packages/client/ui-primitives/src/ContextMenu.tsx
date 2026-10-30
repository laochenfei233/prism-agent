/**
 * Pointer-anchored context menu over the standard {@link Menu}.
 *
 * A secondary press names a viewport point instead of an element, so the menu
 * supplies `Menu`'s portal anchor rect from that point and lets the existing
 * placement clamp it to the viewport. The caller keeps the browser's own menu
 * suppressed and owns the entries.
 */
import { useCallback, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { Menu } from './Menu.tsx'
import type { MenuEntry } from './Menu.tsx'

/** Viewport coordinates of the secondary press that opened a context menu. */
export interface ContextMenuPoint {
  readonly x: number
  readonly y: number
}

/** Open state and gestures a context-menu surface attaches to its own row. */
export interface ContextMenuState {
  /** The press point while the menu is open, else null. */
  readonly point: ContextMenuPoint | null
  /** Suppress the browser menu and open this menu at the press point. */
  open: (event: ReactMouseEvent) => void
  /** Dismiss the menu. */
  close: () => void
}

/**
 * Hold one context menu's press point and wire it to a row's `onContextMenu`.
 * @returns the point, the row handler, and the dismissal callback.
 */
export function useContextMenu(): ContextMenuState {
  const [point, setPoint] = useState<ContextMenuPoint | null>(null)
  const open = useCallback((event: ReactMouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setPoint({ x: event.clientX, y: event.clientY })
  }, [])
  const close = useCallback(() => { setPoint(null) }, [])
  return { point, open, close }
}

/**
 * Render the menu a {@link useContextMenu} state opened.
 * @param props.state - the press point and its dismissal callback.
 * @param props.items - selectable data rows and optional separators.
 * @param props.children - component rows rendered after `items` (a slot's entries, for example).
 * @param props.footer - rows pinned below the scrolling items area.
 * @param props.onSelect - data-row activation callback.
 * @param props.dense - reduce vertical row spacing.
 * @param props.compact - use reduced menu typography and spacing.
 * @param props.listClassName - extra class on the portaled menu card.
 * @returns the portaled menu, or nothing positioned until a press sets a point.
 */
export function ContextMenu({ state, items = [], children, footer, onSelect, dense = false, compact = false, listClassName }: {
  state: ContextMenuState
  items?: readonly MenuEntry[]
  children?: ReactNode
  footer?: readonly MenuEntry[]
  onSelect?: (id: string) => void
  dense?: boolean
  compact?: boolean
  listClassName?: string | undefined
}): ReactNode {
  const { point, close } = state
  // A context menu is one gesture: selecting a row dismisses it, so callers
  // supply behavior only.
  const select = useCallback((id: string) => {
    close()
    onSelect?.(id)
  }, [close, onSelect])
  const anchorRect = useCallback(
    (): DOMRect | null => (point === null ? null : new DOMRect(point.x, point.y, 0, 0)),
    [point],
  )
  return (
    <Menu
      open={point !== null}
      anchor={null}
      items={items}
      {...footer === undefined ? {} : { footer }}
      onSelect={select}
      onClose={close}
      portal
      getAnchorRect={anchorRect}
      dense={dense}
      compact={compact}
      listClassName={listClassName}
    >
      {children}
    </Menu>
  )
}
