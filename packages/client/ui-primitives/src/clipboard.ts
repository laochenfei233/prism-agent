// Host clipboard write shared by Web UI copy controls. Success feedback stays
// with each control; this helper reports whether the host accepted a write and
// leaves focus where it found it.

/**
 * Attempt the async Clipboard API write.
 * @param text - the exact text to place on the clipboard.
 * @returns true only when the host accepted the write.
 */
async function writeWithClipboardApi(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
  } catch (_error) {
    // A denied permission can block the async API while execCommand still works; the caller tries it below.
    return false
  }
  return true
}

/**
 * Write text to the host clipboard, preferring the async Clipboard API and
 * falling back to `execCommand('copy')` when that API is missing (jsdom,
 * insecure contexts) or refuses the write (for example, a denied clipboard
 * permission). The fallback replaces the page selection and succeeds only while
 * the triggering user gesture's transient activation is still valid.
 * @param text - the exact text to place on the clipboard.
 * @returns true only when the host accepted the write.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  // lib.dom types clipboard non-optional, but insecure contexts omit it —
  // that runtime gap is exactly what this guard detects.
  /* oxlint-disable-next-line typescript/no-unnecessary-condition */
  if (typeof navigator.clipboard?.writeText === 'function') {
    if (await writeWithClipboardApi(text)) return true
  }
  // execCommand('copy') is the only clipboard fallback where the async API
  // is missing or refused; deprecated but deliberately retained.
  /* oxlint-disable typescript/no-deprecated */
  const exec = typeof document.execCommand === 'function'
    ? document.execCommand.bind(document)
    : undefined
  if (exec === undefined) return false
  // Selecting the textarea moves focus; return it so a keyboard user stays on the copy control.
  const focused = document.activeElement
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  try {
    document.body.appendChild(el)
    el.select()
    return exec('copy')
  } catch {
    return false
  } finally {
    el.remove()
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true })
  }
  /* oxlint-enable typescript/no-deprecated */
}

/**
 * Read the host clipboard as text.
 *
 * There is no fallback: a browser that omits `navigator.clipboard.readText`
 * (insecure context, jsdom) or denies the permission rejects, and the caller
 * reports that it could not read rather than importing stale text.
 * @returns the clipboard text.
 * @throws when the host exposes no read API or refuses the read.
 */
export async function readClipboard(): Promise<string> {
  /* oxlint-disable-next-line typescript/no-unnecessary-condition */
  if (navigator.clipboard?.readText === undefined) {
    throw new Error('clipboard: this host exposes no clipboard read API')
  }
  return navigator.clipboard.readText()
}
