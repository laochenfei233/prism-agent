/**
 * Shared vocabulary of the data settings page: the location state it renders,
 * the actions it calls, and the failure codes both halves use. Client-safe —
 * no Node or Cordis value is imported, so the browser half reads exactly what
 * the Host produces.
 *
 * @module @prism/prism-data/types
 */

/** Machine code carried by every data settings failure. */
export type DataErrorCode =
  | 'prism-data/bad-request'
  | 'prism-data/busy'
  | 'prism-data/target-invalid'
  | 'prism-data/target-not-empty'
  | 'prism-data/copy-failed'
  | 'prism-data/pointer-failed'

/** Where the harness home is, and what the next launch would use instead. */
export interface DataLocationState {
  /** Absolute home this process runs from. */
  readonly root: string
  /** Absolute path of the launch pointer file. */
  readonly pointerPath: string
  /** Home the pointer names, when one is recorded. */
  readonly storedRoot?: string | undefined
  /** Home a fresh launch would use, present only when it differs from {@link root}. */
  readonly pendingRoot?: string | undefined
}

/** Outcome of one relocation. */
export interface RelocationResult {
  /** Absolute home the data was copied to. */
  readonly target: string
  /** Absolute home the copy came from; it is left untouched. */
  readonly previousRoot: string
  /** Regular files copied. */
  readonly files: number
  /** Total size of those files, in bytes. */
  readonly bytes: number
  /** Absolute paths of links that could not be recreated at the target. */
  readonly skippedLinks: readonly string[]
}

/** One call the settings page makes. */
export type DataRequest =
  | { readonly action: 'state' }
  | { readonly action: 'relocate'; readonly target: string }
  | { readonly action: 'reset' }

/** Successful answer body. */
export interface DataSuccess<T> {
  /** Discriminant. */
  readonly ok: true
  /** Action's result. */
  readonly value: T
}

/** Failed answer body; the HTTP status follows the code. */
export interface DataFailure {
  /** Discriminant. */
  readonly ok: false
  /** Machine code and a sentence the page can show as-is. */
  readonly error: { readonly code: DataErrorCode; readonly message: string }
}

/** Answer body of every call on `DATA_ROUTE_PATH`. */
export type DataResponse<T> = DataSuccess<T> | DataFailure
