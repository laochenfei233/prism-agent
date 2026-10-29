/**
 * The mobile adaptation: stylesheet, edge-swipe drawer with a popstate guard,
 * soft-keyboard tracking, and touch typing.
 *
 * The drawer reuses the app's own sidebar toggle (`layout.toggleSidebar()`)
 * and renders the expanded sidebar as a fixed overlay sheet through CSS. The
 * keyboard listener watches `visualViewport` and toggles the `prism-keyboard`
 * class the stylesheet keys off. Typing intercepts plain `Enter` on coarse
 * pointers before the editor keymap sees it and inserts a line break instead.
 *
 * @module @prism/prism-pocket/client/adapter
 */

import { POCKET_CSS } from './css.ts'
import { edgeSwipeAction } from './pure.ts'

/** The layout seam the drawer drives. */
export interface LayoutLike {
  toggleSidebar(): void
}

/** Minimum height loss that counts as "the soft keyboard is open". */
const KEYBOARD_THRESHOLD_PX = 140

/** Install every adaptation; the returned disposer removes all of it. */
export function installAdapter(layout: LayoutLike): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'prism-pocket'
  style.textContent = POCKET_CSS
  document.head.append(style)
  const backdrop = document.createElement('div')
  backdrop.className = 'prism-backdrop'
  document.body.append(backdrop)

  const disposeKeyboard = installKeyboard()
  const disposeDrawer = installDrawer(layout, backdrop)
  const disposeTyping = installTyping()

  return () => {
    closeDrawerState(layout, backdrop)
    disposeKeyboard()
    disposeDrawer()
    disposeTyping()
    style.remove()
    backdrop.remove()
  }
}

/** Track the soft keyboard through `visualViewport` and toggle the class. */
function installKeyboard(): () => void {
  const viewport = window.visualViewport
  if (viewport == null) return () => {}
  const onResize = (): void => {
    const open = window.innerHeight - viewport.height > KEYBOARD_THRESHOLD_PX
    document.documentElement.classList.toggle('prism-keyboard', open)
  }
  viewport.addEventListener('resize', onResize)
  viewport.addEventListener('scroll', onResize)
  return () => {
    viewport.removeEventListener('resize', onResize)
    viewport.removeEventListener('scroll', onResize)
    document.documentElement.classList.remove('prism-keyboard')
  }
}

/**
 * The edge-swipe drawer: swipe from the left edge opens the sidebar; the
 * browser back gesture closes it before it leaves the page.
 */
function installDrawer(layout: LayoutLike, backdrop: HTMLElement): () => void {
  let touchStart: { x: number; y: number; t: number } | null = null
  const onTouchStart = (event: TouchEvent): void => {
    const touch = event.touches[0]
    touchStart = touch === undefined ? null : { x: touch.clientX, y: touch.clientY, t: Date.now() }
  }
  const onTouchEnd = (event: TouchEvent): void => {
    const start = touchStart
    touchStart = null
    const touch = event.changedTouches[0]
    if (start === null || touch === undefined) return
    if (drawerOpen()) return
    if (edgeSwipeAction(start.x, start.y, touch.clientX, touch.clientY, Date.now() - start.t) === null) return
    openDrawer(layout)
  }
  document.addEventListener('touchstart', onTouchStart, { passive: true })
  document.addEventListener('touchend', onTouchEnd, { passive: true })

  const onBackdropClick = (): void => { closeDrawer(layout, backdrop) }
  backdrop.addEventListener('click', onBackdropClick)

  const onSidebarClick = (event: MouseEvent): void => {
    // Any navigation from inside the drawer (session row, new chat, settings)
    // dismisses it; the drawer only ever opens over the conversation.
    if (!drawerOpen()) return
    if (!(event.target instanceof Element)) return
    if (event.target.closest('[data-slot="sidebar"]') === null) return
    window.setTimeout(() => { if (drawerOpen()) closeDrawer(layout, backdrop) }, 120)
  }
  document.addEventListener('click', onSidebarClick, true)

  const onPopstate = (): void => {
    if (drawerOpen()) closeDrawer(layout, backdrop)
  }
  window.addEventListener('popstate', onPopstate)

  return () => {
    document.removeEventListener('touchstart', onTouchStart)
    document.removeEventListener('touchend', onTouchEnd)
    backdrop.removeEventListener('click', onBackdropClick)
    document.removeEventListener('click', onSidebarClick, true)
    window.removeEventListener('popstate', onPopstate)
  }
}

/** Whether the drawer overlay is currently presented. */
function drawerOpen(): boolean {
  return document.documentElement.classList.contains('prism-drawer-open')
}

/** Open the drawer: expand the sidebar, present the overlay, arm the back gesture. */
function openDrawer(layout: LayoutLike): void {
  if (drawerOpen()) return
  const sidebar = sidebarElement()
  if (sidebar === null) return
  if (sidebar.getBoundingClientRect().width < 100) layout.toggleSidebar()
  document.documentElement.classList.add('prism-drawer-open')
  window.history.pushState({ 'prism-pocket-drawer': true }, '')
}

/** Close the drawer and unwind the history sentinel. */
function closeDrawer(layout: LayoutLike, backdrop: HTMLElement): void {
  if (!drawerOpen()) return
  closeDrawerState(layout, backdrop)
  if (typeof window.history.state?.['prism-pocket-drawer'] === 'boolean') {
    window.history.back()
  }
}

/** The shared teardown path: collapse the sidebar and drop the overlay class. */
function closeDrawerState(layout: LayoutLike, backdrop: HTMLElement): void {
  if (!document.documentElement.classList.contains('prism-drawer-open')) return
  document.documentElement.classList.remove('prism-drawer-open')
  const sidebar = sidebarElement()
  if (sidebar !== null && sidebar.getBoundingClientRect().width >= 100) layout.toggleSidebar()
  backdrop.style.pointerEvents = 'none'
}

/** The sidebar slot wrapper, when the app has rendered it. */
function sidebarElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="sidebar"]')
}

/**
 * Touch typing: on coarse pointers, plain `Enter` inserts a line break
 * instead of submitting. IME composition and every modifier chord stay with
 * the editor's own keymap.
 */
function installTyping(): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter') return
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.isComposing) return
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.isContentEditable) return
    if (target.closest('[data-slot="conversation.composer.bar"]') === null
      && target.closest('[data-slot="conversation.composer.dock"]') === null) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!document.execCommand('insertLineBreak') && !document.execCommand('insertText', false, '\n')) {
      target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertLineBreak', data: null }))
    }
  }
  document.addEventListener('keydown', onKeyDown, { capture: true })
  return () => { document.removeEventListener('keydown', onKeyDown, { capture: true }) }
}
