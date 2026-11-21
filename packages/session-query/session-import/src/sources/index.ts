/**
 * Source reader registry. Each entry turns one foreign store into scanned
 * sessions and normalized transcripts.
 *
 * @module @prism/prism-session-import/sources
 */

import type { ImportSourceId, ScannedSource } from '../types.ts'
import { claudeReader } from './claude.ts'
import { codexReader } from './codex.ts'
import { dshReader } from './dsh.ts'
import { geminiReader } from './gemini.ts'
import { grokReader } from './grok.ts'
import { hermesReader } from './hermes.ts'
import { mimocodeReader } from './mimo.ts'
import { openclawReader } from './openclaw.ts'
import { opencodeReader } from './opencode.ts'
import { piReader } from './pi.ts'

/** One reader for a foreign conversation store. */
export interface SourceReader {
  /** Store id. */
  readonly id: ImportSourceId
  /**
   * Discover sessions under a root.
   * @param root - absolute store root.
   * @returns scanned sessions plus unreadable entries.
   */
  scan(root: string): Promise<ScannedSource>
}

/** Readers keyed by store id. */
export const SOURCE_READERS: Readonly<Record<ImportSourceId, SourceReader>> = {
  claude: claudeReader,
  codex: codexReader,
  grok: grokReader,
  dsh: dshReader,
  mimocode: mimocodeReader,
  opencode: opencodeReader,
  openclaw: openclawReader,
  hermes: hermesReader,
  pi: piReader,
  gemini: geminiReader,
}
