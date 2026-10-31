/**
 * Durable model state under the models root: which variant is selected, what
 * landed on disk, and what was verified. The document is the source of truth
 * for idle/ready/error; active operations own their transient state and write
 * through on completion.
 *
 * @module @prism/prism-local-models
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProbeOutcome } from './types.ts'

/** Persisted state of one installed file. */
export interface FileRecord {
  /** Byte size at verification time. */
  readonly sizeBytes: number
  /** mtime at verification time; a changed mtime forces re-verification. */
  readonly mtimeMs: number
  /** Whether sha256 was verified against the catalog pin. */
  readonly verified: boolean
}

/** Persisted state of one model family. */
export interface FamilyRecord {
  /** Installed (or selected) variant id. */
  readonly variantId?: string
  /** `idle` (nothing usable), `ready` (all files verified), `error`. */
  readonly status: 'idle' | 'ready' | 'error'
  /** Actionable failure text when `status` is `error`. */
  readonly error?: string
  /** Verified file records keyed by variant-relative path. */
  readonly files?: Readonly<Record<string, FileRecord>>
  /** Most recent smoke-inference outcome, when a probe ran. */
  readonly probe?: ProbeOutcome
}

/** The registry document persisted at `<modelsRoot>/registry.json`. */
export interface RegistryDocument {
  /** Format version; currently always 1. */
  readonly version: 1
  /** Per-family records keyed by family id. */
  readonly families: Readonly<Record<string, FamilyRecord>>
}

/** Empty document used before anything was installed. */
export function emptyRegistryDocument(): RegistryDocument {
  return { version: 1, families: {} }
}

/** Outcome of one integrity check against a catalog pin. */
export type IntegrityResult = 'match' | 'missing' | 'size-mismatch' | 'hash-mismatch'

/**
 * The registry store. Reads tolerate a missing document; a corrupt one fails
 * loudly instead of resetting operator state.
 */
export class ModelRegistry {
  private readonly documentPath: string

  /**
   * @param modelsRoot - absolute directory holding `registry.json` and the model trees.
   */
  constructor(modelsRoot: string) {
    this.documentPath = join(modelsRoot, 'registry.json')
  }

  /** Read the document, returning the empty document when none exists yet. */
  async load(): Promise<RegistryDocument> {
    let text: string
    try {
      text = await readFile(this.documentPath, 'utf8')
    } catch {
      return emptyRegistryDocument()
    }
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || (value as RegistryDocument).version !== 1
      || typeof (value as RegistryDocument).families !== 'object' || (value as RegistryDocument).families === null) {
      throw new Error(`local-models: ${this.documentPath} is not a version-1 registry document; fix or delete it by hand`)
    }
    return value as RegistryDocument
  }

  /**
   * Persist the document atomically (temp file plus rename).
   * @param document - the document to write.
   */
  async save(document: RegistryDocument): Promise<void> {
    await mkdir(dirname(this.documentPath), { recursive: true })
    const temp = `${this.documentPath}.tmp`
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    await rename(temp, this.documentPath)
  }

  /**
   * Verify one file against its catalog pin, streaming the hash.
   * @param absolutePath - file to check.
   * @param sizeBytes - pinned byte size.
   * @param sha256 - pinned digest.
   */
  static async verifyFile(absolutePath: string, sizeBytes: number, sha256: string): Promise<IntegrityResult> {
    let stats
    try {
      stats = await stat(absolutePath)
    } catch {
      return 'missing'
    }
    if (stats.size !== sizeBytes) return 'size-mismatch'
    const hash = createHash('sha256')
    const handle = await (await import('node:fs/promises')).open(absolutePath, 'r')
    try {
      const chunk = Buffer.alloc(1024 * 1024)
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null)
        if (bytesRead === 0) break
        hash.update(bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead))
      }
    } finally {
      await handle.close()
    }
    return hash.digest('hex') === sha256 ? 'match' : 'hash-mismatch'
  }

  /**
   * Absolute path of one variant directory.
   * @param modelsRoot - the models root.
   * @param modelId - family id.
   * @param variantId - variant id.
   */
  static variantDir(modelsRoot: string, modelId: string, variantId: string): string {
    return join(modelsRoot, modelId, variantId)
  }
}
