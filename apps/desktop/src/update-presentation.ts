/**
 * The desktop shell's update-presentation wire, mirrored for the Web e2e.
 *
 * The Rust updater (apps/desktop/src-tauri/src/update.rs) emits snapshots that
 * are a superset of the client's `DesktopUpdatePresentation`
 * (packages/client/ui-settings-general/src/types.ts). The desktop-updates e2e
 * builds carrier fixture states through this module instead of importing
 * Client projects, which would mix compiler faces, so the mapping rules here
 * are the ones the shell implements: phase and facts pass through, percent is
 * floored to a whole step, and errors classify into a stable failure family
 * without raw diagnostics.
 */
import type { DesktopMessages } from './locale.ts'

/** Classified failure family, matching the client contract. */
export type DesktopUpdateFailureKind =
  | 'check'
  | 'check-network'
  | 'download'
  | 'download-network'
  | 'install'
  | 'install-network'
  | 'stop-failed'
  | 'tasks-changed'
  | 'tasks-unavailable'

/** Presentation contract the client's indicator and badge render from. */
export interface DesktopUpdatePresentation {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly percent?: number
  readonly failure?: DesktopUpdateFailureKind
}

/** Raw updater state before presentation mapping. */
export interface DesktopUpdateState {
  readonly phase: DesktopUpdatePresentation['phase']
  readonly version?: string
  readonly percent?: number
  /** The updater operation that failed; defaults to `install`. */
  readonly failedOperation?: 'check' | 'download' | 'install'
  readonly message?: string
  /** A failure that happened while preparing the install, ahead of the operation itself. */
  readonly preparationFailure?: DesktopUpdateFailureKind
}

const NETWORK_FAILURE = /\b(?:ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ETIMEDOUT)\b/u

/**
 * Classify one updater failure for both native and Web-localized summaries.
 * @param state Update failure and its operation.
 * @returns Stable presentation kind without raw diagnostics.
 */
function desktopUpdateFailureKind(state: DesktopUpdateState): DesktopUpdateFailureKind {
  if (state.failedOperation === 'install' && state.preparationFailure !== undefined) return state.preparationFailure
  const operation = state.failedOperation ?? 'install'
  return NETWORK_FAILURE.test(state.message ?? '') ? `${operation}-network` : operation
}

/**
 * Select user-facing error copy independently of raw updater diagnostics.
 * @param state Update failure and its operation.
 * @param messages Selected shell locale.
 * @returns Localized summary suitable for both a dialog and a tooltip.
 */
export function desktopUpdateErrorSummary(state: DesktopUpdateState, messages: DesktopMessages): string {
  const kind = desktopUpdateFailureKind(state)
  const summaries: Readonly<Record<DesktopUpdateFailureKind, string>> = {
    check: messages.updateCheckFailed,
    'check-network': messages.updateCheckNetworkFailed,
    download: messages.updateDownloadFailed,
    'download-network': messages.updateDownloadNetworkFailed,
    install: messages.updateInstallFailed,
    'install-network': messages.updateInstallNetworkFailed,
    'stop-failed': messages.updateStopFailed,
    'tasks-changed': messages.updateTasksChanged,
    'tasks-unavailable': messages.updateTasksUnavailable,
  }
  return summaries[kind]
}

/**
 * Map one shell state onto the presentation wire. The shell's copy table rides
 * along because the shell's own classification entry point takes it; the
 * mapping itself is locale-independent.
 * @param state - Main-process updater state.
 * @param _messages - The shell locale, accepted for entry-point parity.
 * @returns Semantic status without localized copy, diagnostics, or installation controls.
 */
export function presentDesktopUpdate(state: DesktopUpdateState, _messages: DesktopMessages): DesktopUpdatePresentation {
  return {
    phase: state.phase,
    ...(state.version === undefined ? {} : { version: state.version }),
    ...(state.percent === undefined ? {} : { percent: Math.floor(state.percent) }),
    ...(state.phase === 'error' ? { failure: desktopUpdateFailureKind(state) } : {}),
  }
}
