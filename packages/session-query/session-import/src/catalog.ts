/**
 * The supported foreign conversation stores and their documented default
 * roots. A deployment can override any root through the plugin Config.
 *
 * @module @prism/prism-session-import/catalog
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ImportSourceId } from './types.ts'
import { isImportSourceId } from './source-ids.ts'

/** One supported store. */
export interface SourceDefinition {
  /** Stable store id used by the wire contract. */
  readonly id: ImportSourceId
  /** Product name shown by the settings page. */
  readonly label: string
  /** Path segments below the OS home for the store's documented root. */
  readonly segments: readonly string[]
}

/** Supported stores in display order. */
export const SOURCE_DEFINITIONS: readonly SourceDefinition[] = [
  { id: 'claude', label: 'Claude Code', segments: ['.claude', 'projects'] },
  { id: 'codex', label: 'Codex', segments: ['.codex'] },
  { id: 'grok', label: 'Grok', segments: ['.grok', 'sessions'] },
  { id: 'dsh', label: 'DeepSeek Harness', segments: ['.dsh', 'sessions'] },
  { id: 'mimocode', label: 'MiMo Code', segments: ['.local', 'share', 'mimocode'] },
  { id: 'opencode', label: 'OpenCode', segments: ['.local', 'share', 'opencode'] },
  { id: 'openclaw', label: 'OpenClaw', segments: ['.openclaw', 'agents'] },
  { id: 'hermes', label: 'Hermes', segments: ['.hermes'] },
  { id: 'pi', label: 'Pi', segments: ['.pi', 'agent', 'sessions'] },
  { id: 'gemini', label: 'Gemini CLI', segments: ['.gemini', 'tmp'] },
]

/**
 * Resolve the documented root of one store.
 * @param definition - store definition.
 * @returns the absolute default root under the current OS home.
 */
export function defaultRoot(definition: SourceDefinition): string {
  return join(homedir(), ...definition.segments)
}

/**
 * Look up a store definition.
 * @param id - store id.
 * @returns the definition, or undefined for an unknown id.
 */
export function definitionOf(id: string): SourceDefinition | undefined {
  return SOURCE_DEFINITIONS.find(definition => definition.id === id)
}

/**
 * Narrow an arbitrary string to a supported store id.
 * @param value - candidate id.
 * @returns whether the string names a supported store.
 */
export function isSourceId(value: string): value is ImportSourceId {
  return isImportSourceId(value)
}
