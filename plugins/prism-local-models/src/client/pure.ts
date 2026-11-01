/**
 * Pure presentation helpers for the local-models card.
 *
 * @module @prism/prism-local-models/client/pure
 */

import type { ModelProgress } from '../types.ts'

/** Human byte size. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * Download completion as a whole percentage.
 * @param progress - the family's reported progress.
 * @returns 0–100 while a byte download has a known total, otherwise undefined.
 */
export function progressPercent(progress: ModelProgress): number | undefined {
  if (progress.phase !== 'download' || progress.total === undefined || progress.total <= 0) return undefined
  return Math.min(100, Math.round(progress.done / progress.total * 100))
}

/** Progress suffix: percent when the total is known, the item label otherwise. */
export function progressText(progress: ModelProgress): string {
  const percent = progressPercent(progress)
  return percent === undefined ? ` ${progress.label}` : ` ${percent}%`
}
