/**
 * Atomic JSON writes for the plugin's small state files: a temporary sibling
 * is written and renamed, so a crash never leaves a half-written body.
 *
 * @module @prism/prism-pocket/atomic-json
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Write one JSON body with owner-only permissions.
 * @param file - absolute destination path; its directory is created on demand.
 * @param body - the value to serialize.
 */
export function writeJsonFile(file: string, body: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(body, undefined, 2), { mode: 0o600, encoding: 'utf8' })
  renameSync(temp, file)
}
