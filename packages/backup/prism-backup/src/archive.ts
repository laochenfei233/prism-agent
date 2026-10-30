/**
 * Archive production: stream the planned members through fflate's incremental
 * ZIP writer into a staging file, with a manifest written last so it can state
 * exactly what the archive holds. Chunks are flushed to the file as they
 * arrive, honoring write backpressure, so a large backup never sits whole in
 * memory.
 * @module @prism/prism-backup/archive
 */

import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Zip, ZipDeflate } from 'fflate'
import type { PlannedMember } from './collect.ts'
import { ARCHIVE_ROOT } from './collect.ts'
import type { BackupCounts } from './types.ts'

/** Compression level used for every archive entry. */
export const ARCHIVE_COMPRESSION_LEVEL = 6

/** Manifest member path inside the archive. */
export const MANIFEST_PATH = `${ARCHIVE_ROOT}/manifest.json`

/** What the archive says about itself; a later restore reads only this. */
export interface BackupManifest {
  /** Archive format generation. */
  readonly format: 1
  /** ISO instant the archive finished collecting. */
  readonly createdAt: string
  /** Product name that produced the archive. */
  readonly app: string
  /** Product version that produced the archive. */
  readonly version: string
  /** Host platform the sources came from. */
  readonly platform: string
  /** Per-source counts. */
  readonly counts: BackupCounts
  /** Sources the policy asked for but this machine does not have. */
  readonly absent: readonly string[]
  /** Entries skipped while walking. */
  readonly warnings: readonly string[]
}

/** Facts about a written archive. */
export interface ArchiveResult {
  /** Final file size in bytes. */
  readonly sizeBytes: number
  /** Entries written, manifest included. */
  readonly entries: number
}

/**
 * Write one archive to a staging file.
 * @param members - files to copy, in write order.
 * @param manifest - self-description written last.
 * @param destination - staging file path the caller deletes after upload.
 * @returns the written archive's size and entry count.
 */
export async function writeArchive(
  members: readonly PlannedMember[],
  manifest: BackupManifest,
  destination: string,
): Promise<ArchiveResult> {
  const out = createWriteStream(destination)
  let needsDrain = false
  const archive = new Zip((error, chunk) => {
    /* v8 ignore next 3 -- fflate reports only internal zip failures, which valid entries cannot cause */
    if (error !== null) {
      throw error
    }
    if (chunk.byteLength > 0 && !out.write(chunk)) needsDrain = true
  })
  const flush = async (): Promise<void> => {
    if (needsDrain) {
      needsDrain = false
      await once(out, 'drain')
    }
  }
  const add = async (path: string, chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<void> => {
    const entry = new ZipDeflate(path, { level: ARCHIVE_COMPRESSION_LEVEL })
    archive.add(entry)
    let wrote = false
    for await (const chunk of chunks) {
      /* v8 ignore next -- a read stream never yields an empty chunk. */
      if (chunk.byteLength === 0) continue
      wrote = true
      entry.push(chunk, false)
      await flush()
    }
    if (!wrote) entry.push(new Uint8Array(0), false)
    entry.push(new Uint8Array(0), true)
    await flush()
  }
  try {
    for (const member of members) await add(member.archivePath, createReadStream(member.path))
    const text = new TextEncoder().encode(`${JSON.stringify(manifest, undefined, 2)}\n`)
    await add(MANIFEST_PATH, [text])
    archive.end()
    await flush()
    out.end()
    await once(out, 'finish')
  } catch (error: unknown) {
    out.destroy()
    archive.terminate()
    throw error
  }
  const info = await stat(destination)
  return { sizeBytes: info.size, entries: members.length + 1 }
}
