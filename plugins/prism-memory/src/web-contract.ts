/**
 * Wire vocabulary of the browser memory routes: the JSON bodies the page sends
 * and the values it renders.
 *
 * Types only. The host entry validates every body at the HTTP boundary, and the
 * browser entry validates every response it decodes, so neither side trusts the
 * other's JSON.
 *
 * @module @prism/prism-memory/web-contract
 */

/** One record, projected onto the fields the page renders. */
export interface MemoryRow {
  /** Opaque `mem_<uuid>` identity. */
  readonly id: string
  /** What the claim is about. */
  readonly layer: string
  /** Claim class. */
  readonly kind: string
  /** Visibility class. */
  readonly scope: string
  /** Lifecycle state. */
  readonly status: string
  /** The claim itself. */
  readonly text: string
  /** Recall keywords. */
  readonly tags: readonly string[]
  /** Producer's certainty, `0..1`. */
  readonly confidence: number
  /** ISO-8601 write time. */
  readonly createdAt: string
  /** ISO-8601 instant this claim becomes actionable, or `null`. */
  readonly dueAt: string | null
  /** ISO-8601 time-to-live deadline, or `null`. */
  readonly expiresAt: string | null
  /** Session the claim came from, or `null` for an operator write. */
  readonly sessionId: string | null
}

/** Counts over the whole store, as the page header renders them. */
export interface MemoryCounts {
  /** Every stored record. */
  readonly total: number
  /** Records per lifecycle state. */
  readonly byStatus: Readonly<Record<string, number>>
  /** Records per layer. */
  readonly byLayer: Readonly<Record<string, number>>
}

/** Value of `overview`: everything the page needs for its first paint. */
export interface MemoryOverview {
  /** Counts over the whole store. */
  readonly counts: MemoryCounts
  /** The review inbox: the head of the pending queue, the oldest decision first. */
  readonly pending: readonly MemoryRow[]
  /** The newest live claims, matching what injection and search can reach. */
  readonly recent: readonly MemoryRow[]
}

/** Body of `search`. */
export interface MemorySearchBody {
  /** Literal query text; empty lists the most recent claims. */
  readonly query: string
  /** Requested result cap; the ranked branch is bounded by the deployment's `searchLimit`, the empty query by the page's own cap. */
  readonly limit?: number
}

/** Body of `remember`. */
export interface MemoryRememberBody {
  /** One self-contained claim. */
  readonly text: string
  /** What the claim is about; the host applies the shipped default. */
  readonly layer?: string
  /** Claim class; the host applies the shipped default. */
  readonly kind?: string
}

/** Body of `review`. */
export interface MemoryReviewBody {
  /** The pending record to settle. */
  readonly id: string
  /** Which way to settle it. */
  readonly decision: 'approve' | 'reject'
  /** Operator note recorded on the record. */
  readonly note?: string
}

/** Value of `search` and of `review`'s list refresh. */
export interface MemoryRowsValue {
  /** The rows, in the order the operation produced them. */
  readonly rows: readonly MemoryRow[]
}

/** Value of `remember`. */
export interface MemoryRememberValue {
  /** The stored or reused record. */
  readonly row: MemoryRow
  /** `created` for a new record, `existing` when an identical claim stood. */
  readonly outcome: 'created' | 'existing'
  /** Live near-duplicates the person may prefer to supersede instead. */
  readonly duplicates: readonly { readonly id: string, readonly text: string }[]
}

/** Value of `review`. */
export interface MemoryReviewValue {
  /** The settled record. */
  readonly row: MemoryRow
}

/** One browser-facing failure, shaped like a Connection RPC failure. */
export interface MemoryFailure {
  /** Stable code naming the failing layer. */
  readonly code: string
  /** Operator-readable failure text. */
  readonly message: string
}

/** Envelope every memory route answers with. */
export type MemoryResponse<T> =
  | { readonly ok: true, readonly value: T }
  | { readonly ok: false, readonly error: MemoryFailure }
