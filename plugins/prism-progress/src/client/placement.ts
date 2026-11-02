/**
 * The placement preference this panel shares with the shipped approval UI.
 *
 * Both sides are browser code on one origin: the key, the event name, and the
 * default are the whole contract. Duplicating three constants is cheaper and
 * safer than making this out-of-tree bundle import a workspace package it does
 * not otherwise need.
 */

/** Where the reader answers a pending approval. */
export type ApprovalPlacement = 'progress' | 'list'

/** Browser key holding the preference. */
export const PLACEMENT_KEY = 'dsh.approval.placement'

/** Window event a same-tab change dispatches. */
export const PLACEMENT_EVENT = 'dsh:approval-placement'

/** Shipped default: this panel carries the decisions. */
export const DEFAULT_PLACEMENT: ApprovalPlacement = 'progress'

/**
 * Read the stored placement.
 * @returns the effective placement, defaulting when nothing valid is stored.
 */
export function readPlacement(): ApprovalPlacement {
  if (typeof localStorage === 'undefined') return DEFAULT_PLACEMENT
  const stored = localStorage.getItem(PLACEMENT_KEY)
  return stored === 'list' || stored === 'progress' ? stored : DEFAULT_PLACEMENT
}

/**
 * Persist a placement and publish it to the other surface in this window.
 * @param value - the placement the reader chose.
 */
export function writePlacement(value: ApprovalPlacement): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(PLACEMENT_KEY, value)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PLACEMENT_EVENT))
}
