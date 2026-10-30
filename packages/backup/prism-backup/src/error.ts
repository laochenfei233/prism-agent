/**
 * The one failure type the feature throws. Each layer raises it next to the
 * check that failed, carrying a machine code from the shared table and the
 * underlying failure as `cause`, so the settings page shows an actionable
 * sentence and the run record keeps the classification.
 * @module @prism/prism-backup/error
 */

import type { BackupErrorCode } from './types.ts'

/** A backup failure that names its cause in the feature's own vocabulary. */
export class BackupError extends Error {
  override readonly name = 'BackupError'

  /**
   * @param code - machine classification the page and the run record keep.
   * @param message - actionable sentence naming what to change.
   * @param options - underlying failure, kept as `cause`.
   */
  constructor(
    readonly code: BackupErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Classify an arbitrary thrown value as a {@link BackupError}, keeping one
 * already carrying a code.
 * @param error - the thrown value.
 * @param fallback - code to use when it carries none.
 * @param context - sentence prefix naming the operation that failed.
 * @returns the classified failure.
 */
export function asBackupError(error: unknown, fallback: BackupErrorCode, context: string): BackupError {
  if (error instanceof BackupError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new BackupError(fallback, `${context}: ${message}`, { cause: error })
}

/**
 * HTTP status the route answers with for one code.
 * @param code - machine classification of the failure.
 * @returns 400 for a rejected body, 409 for a run already in flight, and 502 otherwise.
 */
export function statusOf(code: BackupErrorCode): number {
  if (code === 'prism-backup/bad-request') return 400
  if (code === 'prism-backup/busy') return 409
  return 502
}
