/**
 * Runtime identity of the supported store ids, shared by the Host catalog and
 * the browser wire guard.
 *
 * @module @deepseek-ai/dsh-session-import/source-ids
 */

import type { ImportSourceId } from './types.ts'

/** Supported store ids in display order. */
export const IMPORT_SOURCE_IDS = [
  'claude', 'codex', 'grok', 'dsh', 'mimocode',
  'opencode', 'openclaw', 'hermes', 'pi', 'gemini',
] as const satisfies readonly ImportSourceId[]

/**
 * Narrow a string to a supported store id.
 * @param value - candidate id.
 * @returns whether the value is a supported store id.
 */
export function isImportSourceId(value: string): value is ImportSourceId {
  return (IMPORT_SOURCE_IDS as readonly string[]).includes(value)
}
