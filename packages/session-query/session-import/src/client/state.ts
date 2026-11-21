/**
 * Pure helpers for the import settings page: group identity, selection,
 * merge detection, outcome counts, and display formatting.
 *
 * @module @prism/prism-session-import/client/state
 */

import type {
  ImportApplyResult,
  ImportOutcome,
  ImportPlan,
  PlanGroup,
} from '../types.ts'

/**
 * Stable key for one planned project group.
 * @param group - planned group.
 * @param index - group position, which distinguishes folders-less groups.
 * @returns the canonical path, or a positional key for a group without one.
 */
export function groupId(group: PlanGroup, index: number): string {
  return group.path ?? `ungrouped:${index}`
}

/**
 * Every group id in plan order.
 * @param plan - planned import.
 * @returns group ids.
 */
export function groupIds(plan: ImportPlan): string[] {
  return plan.groups.map((group, index) => groupId(group, index))
}

/**
 * Session keys selected through their project groups.
 * @param plan - planned import.
 * @param included - selected group ids.
 * @returns session keys in plan order.
 */
export function selectedSessionIds(plan: ImportPlan, included: readonly string[]): string[] {
  const selected = new Set(included)
  return plan.groups.flatMap((group, index) => (
    selected.has(groupId(group, index)) ? group.sessions.map(session => session.key) : []
  ))
}

/**
 * Groups that would merge into an existing project among the selected ones.
 * @param plan - planned import.
 * @param included - selected group ids.
 * @returns groups whose `existingWorkspace` is present.
 */
export function mergeGroupsFor(plan: ImportPlan, included: readonly string[]): PlanGroup[] {
  const selected = new Set(included)
  return plan.groups.filter((group, index) => selected.has(groupId(group, index)) && group.merge)
}

/**
 * Count outcomes in one apply result.
 * @param result - completed import.
 * @returns counts keyed by outcome.
 */
export function outcomeCounts(result: ImportApplyResult): Record<ImportOutcome, number> {
  const counts: Record<ImportOutcome, number> = { imported: 0, duplicate: 0, skipped: 0, failed: 0 }
  for (const entry of result.results) counts[entry.outcome] += 1
  return counts
}

/**
 * Format a byte count for a source card.
 * @param bytes - stored bytes; zero means unknown.
 * @returns compact human form, or an em dash when unknown.
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Format a timestamp as a calendar day.
 * @param time - Unix epoch milliseconds; zero means unknown.
 * @returns `YYYY-MM-DD`, or an em dash when unknown.
 */
export function formatDay(time: number): string {
  if (time <= 0) return '—'
  return new Date(time).toISOString().slice(0, 10)
}
