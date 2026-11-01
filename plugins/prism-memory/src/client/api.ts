/**
 * Browser client for the memory routes: one typed request per operation, with
 * every response narrowed at this wire boundary before the page renders it.
 *
 * Requests are document-relative so a host mount prefix keeps working.
 *
 * @module @prism/prism-memory/client/api
 */

import type {
  MemoryOverview,
  MemoryReviewValue,
  MemoryRow,
  MemoryRowsValue,
  MemoryRememberValue,
} from '../web-contract.ts'

/** Path prefix below `/api` every request of this client addresses. */
const BASE = 'api/prism-memory'

/** Capabilities the page's apply closure provides. */
export interface MemoryPanelFace {
  /** Read counts, the review inbox, and the newest claims. */
  readonly load: () => Promise<MemoryOverview>
  /** Rank the whole corpus against one query. */
  readonly search: (query: string) => Promise<readonly MemoryRow[]>
  /** Store one operator claim. */
  readonly remember: (text: string, layer: string) => Promise<MemoryRememberValue>
  /** Settle one pending claim. */
  readonly review: (id: string, decision: 'approve' | 'reject') => Promise<MemoryRow>
}

/** One memory operation failed; `code` names the failing layer. */
export class MemoryRequestError extends Error {
  /**
   * @param code - Host failure code, or this client's own validation code.
   * @param message - Operator-readable failure text.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'MemoryRequestError'
  }
}

/** Read one decoded value as a JSON object, or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Whether one decoded value is a complete memory row. */
function isRow(value: unknown): value is MemoryRow {
  const row = asRecord(value)
  if (row === null) return false
  return typeof row.id === 'string'
    && typeof row.layer === 'string'
    && typeof row.kind === 'string'
    && typeof row.scope === 'string'
    && typeof row.status === 'string'
    && typeof row.text === 'string'
    && typeof row.confidence === 'number'
    && typeof row.createdAt === 'string'
    && (row.dueAt === null || typeof row.dueAt === 'string')
    && (row.expiresAt === null || typeof row.expiresAt === 'string')
    && (row.sessionId === null || typeof row.sessionId === 'string')
    && Array.isArray(row.tags) && row.tags.every(tag => typeof tag === 'string')
}

/** Whether one decoded value is a list of memory rows. */
function isRows(value: unknown): value is MemoryRowsValue {
  const rows = asRecord(value)
  return rows !== null && Array.isArray(rows.rows) && rows.rows.every(isRow)
}

/** Whether one decoded value is the overview value. */
function isOverview(value: unknown): value is MemoryOverview {
  const overview = asRecord(value)
  if (overview === null) return false
  const counts = asRecord(overview.counts)
  return counts !== null
    && typeof counts.total === 'number'
    && asRecord(counts.byStatus) !== null
    && asRecord(counts.byLayer) !== null
    && Array.isArray(overview.pending) && overview.pending.every(isRow)
    && Array.isArray(overview.recent) && overview.recent.every(isRow)
}

/** Whether one decoded value is the write value. */
function isRememberValue(value: unknown): value is MemoryRememberValue {
  const stored = asRecord(value)
  if (stored === null) return false
  return isRow(stored.row)
    && (stored.outcome === 'created' || stored.outcome === 'existing')
    && Array.isArray(stored.duplicates)
    && stored.duplicates.every((entry) => {
      const duplicate = asRecord(entry)
      return duplicate !== null && typeof duplicate.id === 'string' && typeof duplicate.text === 'string'
    })
}

/** Whether one decoded value is the review value. */
function isReviewValue(value: unknown): value is MemoryReviewValue {
  const settled = asRecord(value)
  return settled !== null && isRow(settled.row)
}

/**
 * Send one route request and narrow its answer.
 * @param route - route name below the plugin's prefix.
 * @param body - JSON request body.
 * @param decode - narrows the envelope's value, or answers null when it cannot.
 * @returns the narrowed value.
 */
async function post<T>(route: string, body: unknown, decode: (value: unknown) => T | null): Promise<T> {
  let payload: unknown
  try {
    const response = await fetch(`${BASE}/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    payload = await response.json()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new MemoryRequestError('prism-memory/unreachable', reason)
  }
  const envelope = asRecord(payload)
  if (envelope === null || typeof envelope.ok !== 'boolean') {
    throw new MemoryRequestError('prism-memory/invalid-response', `the host answered with an unreadable ${route} envelope`)
  }
  if (!envelope.ok) {
    const failure = asRecord(envelope.error)
    throw new MemoryRequestError(
      typeof failure?.code === 'string' ? failure.code : 'prism-memory/invalid-response',
      typeof failure?.message === 'string' ? failure.message : `the host rejected ${route}`,
    )
  }
  const value = decode(envelope.value)
  if (value === null) {
    throw new MemoryRequestError('prism-memory/invalid-response', `the host answered with an unreadable ${route} value`)
  }
  return value
}

/**
 * Build the page's request face.
 * @returns one callback per operation the page performs.
 */
export function createMemoryApi(): MemoryPanelFace {
  return {
    load: () => post('overview', {}, value => isOverview(value) ? value : null),
    search: query => post('search', { query }, value => isRows(value) ? value.rows : null),
    remember: (text, layer) => post('remember', { text, layer }, value => isRememberValue(value) ? value : null),
    review: async (id, decision) => {
      const settled = await post('review', { id, decision }, value => isReviewValue(value) ? value : null)
      return settled.row
    },
  }
}
