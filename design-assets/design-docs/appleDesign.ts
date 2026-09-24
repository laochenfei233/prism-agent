/**
 * Apple Design — Global Constants & Utilities
 *
 * Centralized spring presets, material helpers, and reduced-motion detection
 * for all renderer components.
 */

// ─── Spring Presets ──────────────────────────────────────────────────────────
/** Apple Design — Default UI spring (damping 1.0, response 0.3) */
export const SPRING_DEFAULT = { type: 'spring' as const, damping: 1.0, response: 0.3 }

/** Apple Design — Snappy micro-interaction (damping 1.0, response 0.15) */
export const SPRING_SNAPPY = { type: 'spring' as const, damping: 1.0, response: 0.15 }

/** Apple Design — Gentle motion for larger surfaces (damping 1.0, response 0.4) */
export const SPRING_GENTLE = { type: 'spring' as const, damping: 1.0, response: 0.4 }

/** Apple Design — Momentum/flick (damping 0.8, response 0.35) */
export const SPRING_MOMENTUM = { type: 'spring' as const, damping: 0.8, response: 0.35 }

/** Apple Design — Sheet/drawer (damping 0.8, response 0.3) */
export const SPRING_SHEET = { type: 'spring' as const, damping: 0.8, response: 0.3 }

/** Apple Design — Tab indicator slide (damping 1.0, response 0.25) */
export const SPRING_TAB = { type: 'spring' as const, damping: 1.0, response: 0.25 }

/** Apple Design — Toast notification (damping 0.85, response 0.3) */
export const SPRING_TOAST = { type: 'spring' as const, damping: 0.85, response: 0.3 }

// ─── Reduced Motion ──────────────────────────────────────────────────────────
/** Check if user prefers reduced motion */
export function getPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Get transition config — spring if motion allowed, instant if reduced */
export function getTransition(spring = SPRING_DEFAULT): object {
  return getPrefersReducedMotion() ? { duration: 0 } : spring
}

// ─── Pointer-down Feedback ───────────────────────────────────────────────────
/** Common whileTap for buttons — scale 0.97 on press */
export const TAP_SCALE = { scale: 0.97 }

/** Smaller scale for compact elements */
export const TAP_SCALE_SM = { scale: 0.95 }

// ─── Material Classes ────────────────────────────────────────────────────────
/**
 * Material CSS class names for different weights.
 * Use these as className on elements that need translucent surfaces.
 */
export const MATERIAL = {
  thin: 'material-thin',
  regular: 'material-regular',
  thick: 'material-thick',
  ultraThin: 'material-ultra-thin'
} as const

// ─── Common Variants ─────────────────────────────────────────────────────────
/** Fade + slide up entry */
export const FADE_UP = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 }
}

/** Scale + fade entry */
export const SCALE_FADE = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.97 }
}

/** Slide from left */
export const SLIDE_LEFT = {
  initial: { x: -20, opacity: 0 },
  animate: { x: 0, opacity: 1 },
  exit: { x: -20, opacity: 0 }
}
