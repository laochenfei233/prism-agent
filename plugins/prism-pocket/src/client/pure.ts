/**
 * Pocket client pure logic: activation policy, gesture recognition, and the
 * origin check the settings page renders. No DOM access here, so the unit
 * tests pin the decisions the adapter depends on.
 *
 * @module @prism/prism-pocket/client/pure
 */

/** Narrowest viewport the desktop layout is still trusted to handle on its own. */
export const POCKET_MAX_WIDTH = 768

/** How close to the left edge a swipe must start, in CSS pixels. */
export const EDGE_ZONE_PX = 28

/** Horizontal travel that turns a touch into a drawer-open swipe. */
export const EDGE_SWIPE_DISTANCE_PX = 56

/** Vertical slop tolerated while swiping along the edge. */
export const EDGE_SWIPE_SLOP_PX = 48

/** The swipe must feel like a flick, not a drag. */
export const EDGE_SWIPE_MAX_MS = 700

/** The remembered explicit `?pocket=` choice. */
export type PocketOverride = 'on' | 'off'

/**
 * The activation decision: an explicit URL choice wins; otherwise the
 * adaptations apply to narrow coarse-pointer viewports only.
 * @param width - viewport width in CSS pixels.
 * @param coarsePointer - whether the primary input is touch.
 * @param override - the remembered explicit choice, when present.
 */
export function shouldActivate(
  width: number,
  coarsePointer: boolean,
  override: PocketOverride | undefined,
): boolean {
  if (override === 'on') return true
  if (override === 'off') return false
  return coarsePointer && width <= POCKET_MAX_WIDTH
}

/** The gesture an edge touch resolved to, if any. */
export type EdgeSwipeAction = 'open'

/**
 * Resolve a completed touch as a left-edge drawer-open swipe.
 * @param startX - touch start X in CSS pixels.
 * @param startY - touch start Y in CSS pixels.
 * @param endX - touch end X.
 * @param endY - touch end Y.
 * @param durationMs - wall time between start and end.
 */
export function edgeSwipeAction(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  durationMs: number,
): EdgeSwipeAction | null {
  if (startX > EDGE_ZONE_PX) return null
  if (endX - startX < EDGE_SWIPE_DISTANCE_PX) return null
  if (Math.abs(endY - startY) > EDGE_SWIPE_SLOP_PX) return null
  if (durationMs > EDGE_SWIPE_MAX_MS) return null
  return 'open'
}

/**
 * Decode a base64url VAPID public key into the bytes `pushManager.subscribe`
 * expects for `applicationServerKey`.
 * @param b64url - the key from the status route.
 */
export function applicationServerKeyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (b64url.length % 4)) % 4)
  const base64 = (b64url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const output = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output
}
