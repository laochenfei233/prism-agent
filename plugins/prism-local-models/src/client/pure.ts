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

/** Progress suffix: percent when the total is known, the item label otherwise. */
export function progressText(progress: ModelProgress): string {
  if (progress.phase === 'download' && progress.total !== undefined && progress.total > 0) {
    return ` ${Math.min(100, Math.round(progress.done / progress.total * 100))}%`
  }
  return ` ${progress.label}`
}
