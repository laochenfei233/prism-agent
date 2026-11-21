/**
 * The desktop shell's updater copy, in English.
 *
 * The Electron shell's full locale table is gone with that shell; the Tauri
 * shell classifies failures itself (apps/desktop/src-tauri/src/update.rs) and
 * never shows this copy to users — the Web client renders its own locale.
 * This table is the classification reference the presentation mirror and its
 * error summaries accept as the shell's voice.
 */

/** The shell's English updater copy; every key is a classification input. */
export const en = {
  updateCheckFailed: 'Could not check for updates. Please try again later.',
  updateCheckNetworkFailed: 'Could not check for updates. Please try again later. The connection was interrupted. Check your network and try again.',
  updateDownloadFailed: 'Could not download the update. Please try again.',
  updateDownloadNetworkFailed: 'Could not download the update. Please try again. The connection was interrupted. Check your network and try again.',
  updateInstallFailed: 'Could not install the update. Please try again later.',
  updateInstallNetworkFailed: 'Could not install the update. Please try again later. The connection was interrupted. Check your network and try again.',
  updateStopFailed: 'Tasks could not be stopped safely. The update was not installed. Please try again later.',
  updateTasksChanged: 'New tasks started. Review the update confirmation again.',
  updateTasksUnavailable: 'Task status is unavailable. Try updating again when the workspace is ready.',
} as const

/** Every shell locale supplies the complete English key set. */
export type DesktopMessages = { readonly [Key in keyof typeof en]: string }
