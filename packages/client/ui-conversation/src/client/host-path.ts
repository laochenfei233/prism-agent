/**
 * Browser-shell bridge reporting the harness-host path of a picked file. A
 * shell may install it on the application document (`__DSH_HOST_PATHS__`);
 * otherwise the WebView2 Desktop shell is detected through the file itself,
 * which carries its host path on the non-standard `path` property. A served
 * Web page's `File` has no path, so every non-image file uploads there.
 */
export interface HostPathBridge {
  /** Absolute harness-host path of one picked file, or empty when the shell has none for it. */
  pathFor(file: File): string
}

/**
 * The path each `File` reports about itself, empty when the runtime provides none.
 * @param file - picked or dropped browser file.
 * @returns the absolute host path when the runtime exposes one, otherwise empty.
 */
export function fileHostPath(file: File): string {
  const path = (file as { path?: unknown }).path
  return typeof path === 'string' ? path : ''
}

/**
 * The shell-installed bridge, when this document runs inside the Desktop application.
 * @returns the bridge the shell installed, or undefined in a plain browser.
 */
export function hostPathBridge(): HostPathBridge | undefined {
  return (globalThis as { __DSH_HOST_PATHS__?: HostPathBridge }).__DSH_HOST_PATHS__
}
