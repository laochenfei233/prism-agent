/**
 * Typed transfer failures. Codes are stable wire values the browser half maps
 * to zh/en copy; the message is the host detail and is never parsed.
 *
 * @module @prism/prism-transfer/errors
 */

/** Every stable refusal this plugin reports to the browser. */
export type TransferErrorCode =
  | 'bad-request'
  | 'unsupported'
  | 'busy'
  | 'bad-archive'
  | 'bad-manifest'
  | 'unsafe-path'
  | 'path-conflict'
  | 'too-many-entries'
  | 'entry-too-large'
  | 'crc-mismatch'
  | 'disk-space'
  | 'no-projects'
  | 'unknown-workspace'
  | 'bad-destination'
  | 'reserved-name'
  | 'session-version'
  | 'attachment-mismatch'
  | 'attachment-failed'
  | 'settings-format'
  | 'io'
  | 'transfer-failed'

/** HTTP status each refusal code maps to on the wire. */
const STATUS_BY_CODE: Readonly<Record<TransferErrorCode, number>> = {
  'bad-request': 400,
  'bad-archive': 400,
  'bad-manifest': 400,
  'unsafe-path': 400,
  'path-conflict': 400,
  'too-many-entries': 400,
  'entry-too-large': 400,
  'crc-mismatch': 400,
  'no-projects': 400,
  'unknown-workspace': 404,
  'bad-destination': 400,
  'reserved-name': 400,
  'session-version': 400,
  'attachment-mismatch': 400,
  'settings-format': 400,
  'unsupported': 501,
  'busy': 409,
  'disk-space': 507,
  'io': 500,
  'transfer-failed': 500,
  'attachment-failed': 500,
}

/** Typed engine refusal carrying a stable wire code. */
export class TransferError extends Error {
  /** Stable failure code mapped to zh/en copy by the browser half. */
  readonly code: TransferErrorCode

  /**
   * @param code - stable failure code.
   * @param message - human-readable host detail.
   */
  constructor(code: TransferErrorCode, message: string) {
    super(message)
    this.name = 'TransferError'
    this.code = code
  }

  /**
   * The HTTP status this refusal answers with.
   * @returns the wired status for the error's code.
   */
  get status(): number {
    return STATUS_BY_CODE[this.code]
  }
}

/**
 * Normalize one caught value into a `TransferError` so route handlers always
 * answer with a typed code.
 * @param error - value caught from engine work.
 * @param fallbackCode - code used when the value is not already a `TransferError`.
 * @returns the typed refusal.
 */
export function asTransferError(error: unknown, fallbackCode: TransferErrorCode = 'transfer-failed'): TransferError {
  if (error instanceof TransferError) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new TransferError(fallbackCode, detail)
}
