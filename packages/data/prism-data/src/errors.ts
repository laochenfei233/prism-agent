/**
 * Typed failures of the data settings route, plus the message a thrown value
 * contributes to a report.
 *
 * @module @prism/prism-data/errors
 */

import type { DataErrorCode } from './types.ts'

/** One refused data settings call, carrying the code the page localizes. */
export class DataError extends Error {
  /**
   * @param code - stable machine code.
   * @param message - operator- and user-facing sentence.
   */
  constructor(readonly code: DataErrorCode, message: string) {
    super(message)
    this.name = 'DataError'
  }
}

/**
 * HTTP status a failure code implies.
 * @param code - the code carried by the failure.
 * @returns 400 for a malformed request or an unusable target, 409 for a
 *   conflict, and 500 for a filesystem failure.
 */
export function statusOf(code: DataErrorCode): number {
  switch (code) {
    case 'prism-data/bad-request':
    case 'prism-data/target-invalid':
      return 400
    case 'prism-data/busy':
    case 'prism-data/target-not-empty':
      return 409
    case 'prism-data/copy-failed':
    case 'prism-data/pointer-failed':
      return 500
  }
}

/**
 * Read the message one thrown value contributes to a report sentence.
 * @param error - thrown value.
 * @returns its message, or its string form for a non-error.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
