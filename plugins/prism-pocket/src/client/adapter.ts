/**
 * The mobile adaptation: stylesheet, soft-keyboard tracking, and touch typing.
 *
 * The sidebar is the shell's own narrow-viewport drawer (below
 * SIDEBAR_DRAWER_BREAKPOINT the frame presents the sidebar column as an
 * overlay with a mask, and the header's sidebar toggle drives it); this
 * adaptation adds nothing to that seam. The keyboard listener watches
 * `visualViewport` and toggles the `prism-keyboard` class the stylesheet keys
 * off. Typing intercepts plain `Enter` on coarse pointers before the editor
 * keymap sees it and inserts a line break instead.
 *
 * @module @prism/prism-pocket/client/adapter
 */

import { POCKET_ADAPTATION_CSS } from './css.ts'

/** Minimum height loss that counts as "the soft keyboard is open". */
const KEYBOARD_THRESHOLD_PX = 140

/** Install every adaptation; the returned disposer removes all of it. */
export function installAdapter(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'prism-pocket'
  style.textContent = POCKET_ADAPTATION_CSS
  document.head.append(style)

  const disposeKeyboard = installKeyboard()
  const disposeTyping = installTyping()

  return () => {
    disposeKeyboard()
    disposeTyping()
    style.remove()
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
