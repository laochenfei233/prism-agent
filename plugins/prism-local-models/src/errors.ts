/**
 * Typed failures for the local-model surface. Every route maps a rejection to
 * its `code` plus the actionable message, so the card can render why.
 *
 * @module @prism/prism-local-models
 */

/** Failure codes reported on the wire. */
export type LocalModelsErrorCode =
  | 'unknown-model'
  | 'unknown-variant'
  | 'busy'
  | 'not-installed'
  | 'not-implemented'
  | 'download-failed'
  | 'integrity-failed'
  | 'provision-failed'
  | 'runtime-unavailable'
  | 'invalid-request'

/** Typed error with a stable code for route mapping and UI rendering. */
export class LocalModelsError extends Error {
  /** Machine-readable failure class. */
  readonly code: LocalModelsErrorCode

  /**
   * @param code - machine-readable failure class.
   * @param message - actionable text, safe to show in the card.
   */
  constructor(code: LocalModelsErrorCode, message: string) {
    super(message)
    this.name = 'LocalModelsError'
    this.code = code
  }
}
