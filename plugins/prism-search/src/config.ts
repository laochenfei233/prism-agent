/**
 * Plugin configuration: the selected ordering model and the search bounds. All
 * fields are volatile, so a saved model applies to the next search without
 * restarting the Host.
 *
 * @module @prism/prism-search
 */

import type { Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { PrismSearchOptions } from './provider.ts'

/** Plugin configuration fields. */
export interface Config {
  /** Provider route of the model that orders results; empty disables ordering. */
  rerankProvider: Volatile<string>
  /** Model id of that model; empty disables ordering. */
  rerankModel: Volatile<string>
  /** Pages fetched for their readable text; 0 disables fetching. */
  fetchTopN: Volatile<number>
  /** Per-engine time bound in milliseconds. */
  engineTimeoutMs: Volatile<number>
  /** Per-page time bound in milliseconds. */
  fetchTimeoutMs: Volatile<number>
  /** Time bound for the ordering call in milliseconds. */
  rerankTimeoutMs: Volatile<number>
  /** Characters kept from one page's readable text. */
  maxSnippetChars: Volatile<number>
  /** Candidates offered to the ordering model. */
  maxRerankCandidates: Volatile<number>
}

/** Validated configuration schema the Loader applies before `apply`. */
export const Config = Schema.object({
  rerankProvider: Schema.string().default('').volatile(),
  rerankModel: Schema.string().default('').volatile(),
  fetchTopN: Schema.number().step(1).min(0).max(20).default(8).volatile(),
  engineTimeoutMs: Schema.number().step(1).min(500).max(60000).default(8000).volatile(),
  fetchTimeoutMs: Schema.number().step(1).min(500).max(60000).default(8000).volatile(),
  rerankTimeoutMs: Schema.number().step(1).min(1000).max(120000).default(20000).volatile(),
  maxSnippetChars: Schema.number().step(1).min(120).max(20000).default(1200).volatile(),
  maxRerankCandidates: Schema.number().step(1).min(2).max(30).default(12).volatile(),
})

/**
 * Snapshot the current configuration into one search's controls.
 * @param config - the live volatile fields.
 * @returns the controls, with every integer bounded by its accepted range.
 */
export function resolveOptions(config: Config): PrismSearchOptions {
  return {
    rerankProvider: config.rerankProvider.get().trim(),
    rerankModel: config.rerankModel.get().trim(),
    fetchTopN: bounded(config.fetchTopN.get(), 8, 0, 20),
    engineTimeoutMs: bounded(config.engineTimeoutMs.get(), 8000, 500, 60000),
    fetchTimeoutMs: bounded(config.fetchTimeoutMs.get(), 8000, 500, 60000),
    rerankTimeoutMs: bounded(config.rerankTimeoutMs.get(), 20000, 1000, 120000),
    maxSnippetChars: bounded(config.maxSnippetChars.get(), 1200, 120, 20000),
    maxRerankCandidates: bounded(config.maxRerankCandidates.get(), 12, 2, 30),
  }
}

/** A configured integer, clamped to its accepted range instead of failing a search. */
function bounded(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return fallback
  return Math.min(Math.max(value, min), max)
}
