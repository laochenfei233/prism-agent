/**
 * Verified downloads: stream one catalog file to its destination through a
 * `.part` temp file, hashing while writing, and rename only after the digest
 * matches the catalog pin. Every failure removes the temp file.
 *
 * @module @prism/prism-local-models
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { LocalModelsError } from './errors.ts'

/** Options for one verified download. */
export interface DownloadOptions {
  /** Absolute upstream URL. */
  readonly url: string
  /** Absolute destination path (written as `<dest>.part` until verified). */
  readonly destPath: string
  /** Pinned byte size. */
  readonly sizeBytes: number
  /** Pinned sha256. */
  readonly sha256: string
  /** Cancels the download; the rejection carries `AbortError`. */
  readonly signal: AbortSignal
  /** Called after each chunk with the bytes written so far. */
  readonly onProgress: (done: number) => void
}

/**
 * Download one file, verify size and sha256, and move it into place.
 * @throws {LocalModelsError} `download-failed` for transport errors, `integrity-failed` for size or digest mismatches; aborts rethrow their `AbortError`.
 */
export async function downloadFile(options: DownloadOptions): Promise<void> {
  const temp = `${options.destPath}.part`
  try {
    const response = await fetch(options.url, { redirect: 'follow', signal: options.signal })
    if (!response.ok || response.body === null) {
      throw new LocalModelsError('download-failed', `GET ${options.url} answered ${response.status}`)
    }
    const hash = createHash('sha256')
    let done = 0
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        done += chunk.byteLength
        options.onProgress(done)
        callback(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), counter, createWriteStream(temp))
    if (done !== options.sizeBytes) {
      throw new LocalModelsError('integrity-failed', `${options.destPath} downloaded ${done} bytes but the catalog pins ${options.sizeBytes}`)
    }
    if (hash.digest('hex') !== options.sha256) {
      throw new LocalModelsError('integrity-failed', `${options.destPath} does not match its catalog checksum; the upstream file may have changed`)
    }
    await rename(temp, options.destPath)
  } catch (error) {
    await rm(temp, { force: true }).catch((cleanupError: unknown) => {
      console.warn(`local-models: failed to remove ${temp}: ${String(cleanupError)}`)
    })
    throw error
  }
}

/** Stream-read one file's sha256; used to re-verify manually placed files. */
export async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(absolutePath), async function* (source) {
    for await (const chunk of source) hash.update(chunk as Buffer)
  })
  return hash.digest('hex')
}
