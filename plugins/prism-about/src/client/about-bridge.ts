/**
 * The shell-injected update carrier, read and derived for the About section.
 *
 * The desktop shell defines `globalThis.dshDesktop` with `protocolVersion: 1`
 * and an optional `updates` bridge (bundle-time injection; see
 * apps/desktop/scripts/bundle-runtime.mjs). Anywhere else — a plain browser,
 * the unpackaged `dsh web` page, or a stale runtime — the carrier is absent
 * and the section degrades to a static line. The update source is fixed to
 * this repository's GitHub Releases; the client never selects artifacts or
 * authorizes installation, it only renders shell-owned state.
 */

/** Update lifecycle phase, mirroring the shell's presentation wire. */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'ready'
  | 'error'

/** Classified failure family, mirroring the shell's presentation wire. */
export type UpdateFailureKind =
  | 'check'
  | 'check-network'
  | 'download'
  | 'download-network'
  | 'install'
  | 'install-network'
  | 'stop-failed'

/** One update-state snapshot; a superset of the shell's presentation wire. */
export interface AboutUpdateState {
  readonly phase: UpdatePhase
  readonly version?: string
  readonly percent?: number
  readonly failure?: UpdateFailureKind
  readonly currentVersion?: string
  /** Unix epoch milliseconds of the last completed check. */
  readonly lastCheck?: number
  readonly lastError?: string
  readonly source?: { readonly repo?: string; readonly releaseUrl?: string }
}

/**
 * The carrier API. `status`/`open`/`subscribe` are the shared presentation
 * contract; `check` is this shell's additive manual-check extension, probed
 * for feature detection so an older shell still degrades to `open`.
 */
export interface DesktopUpdateCarrier {
  status(): Promise<AboutUpdateState>
  open(): Promise<void>
  subscribe(listener: (state: AboutUpdateState) => void): () => void
  check?(): Promise<AboutUpdateState>
}

/** Reads the shell-injected carrier; null outside the desktop shell. */
export function readCarrier(): DesktopUpdateCarrier | null {
  const global = globalThis as {
    dshDesktop?: { protocolVersion?: number; updates?: Partial<DesktopUpdateCarrier> }
  }
  const carrier = global.dshDesktop
  const updates = carrier?.updates
  if (carrier?.protocolVersion !== 1) return null
  if (
    typeof updates?.status !== 'function'
    || typeof updates?.open !== 'function'
    || typeof updates?.subscribe !== 'function'
  ) {
    return null
  }
  return updates as DesktopUpdateCarrier
}

/** Which action the primary button offers. */
export type ButtonState = 'idle' | 'checking' | 'upToDate' | 'available' | 'error' | 'progress'

/**
 * Derives the primary button from the phase; `checked` marks that a manual
 * check has completed, which turns a quiet idle into the explicit up-to-date
 * state. `progress` means the phase owns the button's place (the progress
 * area renders instead) — a successful install ends with the shell exiting,
 * so there is no action to offer during download and install.
 */
export function deriveButtonState(phase: UpdatePhase, checked: boolean): ButtonState {
  if (phase === 'checking') return 'checking'
  if (phase === 'downloading' || phase === 'verifying' || phase === 'installing' || phase === 'ready') {
    return 'progress'
  }
  if (phase === 'available') return 'available'
  if (phase === 'error') return 'error'
  return checked ? 'upToDate' : 'idle'
}
