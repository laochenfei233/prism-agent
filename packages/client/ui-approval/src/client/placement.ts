// PRISM-DIVERGENCE: replay list in docs/compose/spec/approval-panel.md (S5).
/**
 * Where the reader answers a pending approval. Both surfaces — the Progress
 * panel and the Session row — stay readable either way; the placement only
 * decides which one carries the decisions, so the other one cannot answer by
 * accident.
 */
export type ApprovalPlacement = 'progress' | 'list'

/** The browser key holding the preference; the Progress panel reads the same key. */
export const APPROVAL_PLACEMENT_KEY = 'dsh.approval.placement'

/** Window event that publishes a same-tab change to every surface. */
export const APPROVAL_PLACEMENT_EVENT = 'dsh:approval-placement'

/** Shipped default: the decisions live in the Progress panel. */
export const DEFAULT_APPROVAL_PLACEMENT: ApprovalPlacement = 'progress'

let cached: ApprovalPlacement | undefined

/**
 * Read the stored placement, falling back to the shipped default. A value this
 * window never wrote is read as the default rather than trusted.
 * @returns the effective placement.
 */
export function readApprovalPlacement(): ApprovalPlacement {
  if (cached !== undefined) return cached
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(APPROVAL_PLACEMENT_KEY)
  cached = stored === 'list' || stored === 'progress' ? stored : DEFAULT_APPROVAL_PLACEMENT
  return cached
}

/**
 * Persist a placement and publish it to the surfaces of this window.
 * @param value - the placement the reader chose.
 */
export function writeApprovalPlacement(value: ApprovalPlacement): void {
  cached = value
  if (typeof localStorage !== 'undefined') localStorage.setItem(APPROVAL_PLACEMENT_KEY, value)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(APPROVAL_PLACEMENT_EVENT))
}

/**
 * Observable over the placement for a slot's `hooks` compartment. The snapshot
 * keeps one identity until the value moves, and a change in another window
 * arrives through the `storage` event.
 * @returns the source a component reads through its bound hook.
 */
export function approvalPlacementSource(): { getSnapshot: () => ApprovalPlacement; subscribe: (listener: () => void) => () => void } {
  return {
    getSnapshot: readApprovalPlacement,
    subscribe: (listener) => {
      cached = undefined
      const onStorage = (event: StorageEvent): void => {
        if (event.key !== null && event.key !== APPROVAL_PLACEMENT_KEY) return
        cached = undefined
        listener()
      }
      const onLocal = (): void => { listener() }
      window.addEventListener('storage', onStorage)
      window.addEventListener(APPROVAL_PLACEMENT_EVENT, onLocal)
      return () => {
        window.removeEventListener('storage', onStorage)
        window.removeEventListener(APPROVAL_PLACEMENT_EVENT, onLocal)
      }
    },
  }
}
