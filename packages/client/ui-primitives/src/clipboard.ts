// Host clipboard access shared by Web UI copy and paste controls. Success
// feedback stays with each control; these helpers only report what the host
// accepted.

/**
 * Write text to the host clipboard, preferring the async Clipboard API and
 * falling back to `execCommand('copy')` on hosts (jsdom, insecure contexts)
 * that omit it.
 * @param text - the exact text to place on the clipboard.
 * @returns true only when the host accepted the write.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  // lib.dom types clipboard non-optional, but insecure contexts omit it —
  // that runtime gap is exactly what this guard detects.
  /* oxlint-disable-next-line typescript/no-unnecessary-condition */
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Denied permissions / iframe policy — do not claim success.
      return false
    }
  }
  // jsdom and older hosts: best-effort execCommand path when present.
  // execCommand('copy') is the only clipboard fallback where the async API
  // is missing; deprecated but deliberately retained.
  /* oxlint-disable typescript/no-deprecated */
  const exec = typeof document.execCommand === 'function'
    ? document.execCommand.bind(document)
    : undefined
  if (exec === undefined) return false
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  try {
    return exec('copy')
  } catch {
    return false
  } finally {
    el.remove()
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
