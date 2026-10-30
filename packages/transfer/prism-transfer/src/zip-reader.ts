/**
 * Central-directory-driven ZIP reader for untrusted transfer archives.
 *
 * The reader parses the end-of-central-directory record (with its ZIP64
 * successors), never trusts a local header for sizes, and streams each entry
 * through an incremental inflate while comparing the decompressed bytes
 * against the central directory's CRC-32 — fflate's streaming inflate does not
 * verify checksums, and stored media must fail loudly when tampered with.
 * Entry names are validated structurally before any consumer sees them; role
 * specific rules (which names may contain colons, which prefixes are
 * materialized) belong to the import engine.
 *
 * @module @prism/prism-transfer/zip-reader
 */

import type { FileHandle } from 'node:fs/promises'
import { open } from 'node:fs/promises'
import { Inflate } from 'fflate'
import { Crc32 } from './crc32.ts'
import { TransferError } from './errors.ts'

/** Safety ceilings applied while parsing one archive. */
export interface ZipReaderLimits {
  /** Maximum central-directory entries. */
  readonly maxEntries: number
  /** Maximum UTF-8 byte length of one entry name. */
  readonly maxNameBytes: number
  /** Maximum uncompressed byte size of one entry. */
  readonly maxEntryBytes: number
}

/** House limits: the same entry count and per-entry size the writer enforces. */
export const DEFAULT_ZIP_READER_LIMITS: ZipReaderLimits = {
  maxEntries: 200_000,
  maxNameBytes: 1024,
  maxEntryBytes: 4 * 2 ** 30,
}

/** One parsed central-directory record. */
export interface ZipEntry {
  /** Decoded, structurally validated name; directory names keep the trailing `/`. */
  readonly name: string
  /** Central-directory CRC-32 of the decompressed bytes. */
  readonly crc32: number
  /** Compressed byte count on disk. */
  readonly compressedSize: number
  /** Declared uncompressed byte count. */
  readonly uncompressedSize: number
  /** Storage method: `0` stored, `8` deflate. */
  readonly method: number
  /** Absolute local-header offset. */
  readonly headerOffset: number
  /** Whether the name ends with `/` (a directory record). */
  readonly directory: boolean
}

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_FIXED_LENGTH = 22
const ZIP64_LOCATOR_LENGTH = 20
const ZIP64_EOCD_FIXED_LENGTH = 56
const CENTRAL_FIXED_LENGTH = 46
const LOCAL_FIXED_LENGTH = 30
/** Largest possible EOCD comment; bounds the backward signature search. */
const MAX_COMMENT_LENGTH = 65_535
/** File bytes pulled per read while streaming one entry. */
const READ_CHUNK_BYTES = 1 << 18
/** ZIP64 extended-information header id inside an entry's extra field. */
const ZIP64_EXTRA_HEADER_ID = 0x0001
/** Fixed central-directory byte overhead per record, bounding the directory read. */
const CENTRAL_ENTRY_SLACK_BYTES = CENTRAL_FIXED_LENGTH + 256

/** `read` that refuses short reads so truncation is always an error. */
async function readExactAt(handle: FileHandle, buffer: Uint8Array, position: number): Promise<void> {
  let read = 0
  while (read < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, read, buffer.byteLength - read, position + read)
    if (bytesRead === 0) throw new TransferError('bad-archive', 'archive is truncated')
    read += bytesRead
  }
}

/** One parsed end-of-central-directory (or ZIP64 successor) description. */
interface DirectoryLocation {
  readonly entryCount: number
  readonly directorySize: number
  readonly directoryOffset: number
}

/**
 * Locate the end-of-central-directory record from the file tail, following the
 * ZIP64 locator when the classic record holds the `0xFFFFFFFF` markers.
 * @param handle - open archive handle.
 * @param size - archive byte length.
 * @returns the located directory description.
 */
async function locateDirectory(handle: FileHandle, size: number): Promise<DirectoryLocation> {
  const tailLength = Math.min(size, EOCD_FIXED_LENGTH + MAX_COMMENT_LENGTH)
  const tail = Buffer.alloc(tailLength)
  await readExactAt(handle, tail, size - tailLength)
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let eocd = -1
  for (let position = tail.length - EOCD_FIXED_LENGTH; position >= 0; position -= 1) {
    if (view.getUint32(position, true) === EOCD_SIGNATURE) {
      eocd = position
      break
    }
  }
  if (eocd < 0) throw new TransferError('bad-archive', 'not a zip archive (no end of central directory)')
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
    throw new TransferError('bad-archive', 'multi-disk archives are not supported')
  }
  const diskEntries = view.getUint16(eocd + 8, true)
  const totalEntries = view.getUint16(eocd + 10, true)
  const directorySize = view.getUint32(eocd + 12, true)
  const directoryOffset = view.getUint32(eocd + 16, true)
  if (directoryOffset !== 0xffffffff && directorySize !== 0xffffffff
    && totalEntries !== 0xffff && diskEntries === totalEntries) {
    return { entryCount: totalEntries, directorySize, directoryOffset }
  }
  const locatorAt = eocd - ZIP64_LOCATOR_LENGTH
  if (locatorAt < 0 || view.getUint32(locatorAt, true) !== ZIP64_LOCATOR_SIGNATURE) {
    throw new TransferError('bad-archive', 'zip64 end of central directory locator is missing')
  }
  if (view.getUint32(locatorAt + 4, true) !== 0 || view.getUint16(locatorAt + 16, true) !== 1) {
    throw new TransferError('bad-archive', 'multi-disk zip64 archives are not supported')
  }
  const zip64Offset = recordOffsetOfTail(view, locatorAt + 8)
  const record = Buffer.alloc(ZIP64_EOCD_FIXED_LENGTH)
  await readExactAt(handle, record, zip64Offset)
  const recordView = new DataView(record.buffer, record.byteOffset, record.byteLength)
  if (recordView.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) {
    throw new TransferError('bad-archive', 'zip64 end of central directory record is missing')
  }
  if (recordView.getUint32(16, true) !== 0 || recordView.getUint32(20, true) !== 0) {
    throw new TransferError('bad-archive', 'multi-disk zip64 archives are not supported')
  }
  return {
    entryCount: largeFieldOf(recordView, 32),
    directorySize: largeFieldOf(recordView, 40),
    directoryOffset: largeFieldOf(recordView, 48),
  }
}

/** Little-endian unsigned 64-bit field; exact through `Number.MAX_SAFE_INTEGER`. */
function largeFieldOf(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TransferError('bad-archive', 'archive field exceeds the supported size range')
  }
  return Number(value)
}

/** Read an 8-byte tail field that encodes a file offset. */
function recordOffsetOfTail(view: DataView, offset: number): number {
  return largeFieldOf(view, offset)
}

/** Structural validation of one entry name, before any consumer sees it. */
function validateEntryName(name: string, limits: ZipReaderLimits): void {
  if (name.length === 0) throw new TransferError('bad-archive', 'archive contains an empty entry name')
  if (Buffer.byteLength(name, 'utf8') > limits.maxNameBytes) {
    throw new TransferError('bad-archive', `entry name exceeds ${String(limits.maxNameBytes)} bytes`)
  }
  if (name.startsWith('/') || name.includes('\\') || name.includes('\u0000')) {
    throw new TransferError('unsafe-path', `entry name "${name}" is not a relative forward-slash path`)
  }
  if (/^[A-Za-z]:/u.test(name)) {
    throw new TransferError('unsafe-path', `entry name "${name}" carries a drive prefix`)
  }
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new TransferError('unsafe-path', `entry name "${name}" contains the forbidden segment "${segment}"`)
    }
  }
}

/**
 * Parse and validate every central-directory record from one in-memory
 * directory region.
 * @param directory - the raw central directory bytes.
 * @param limits - reader ceilings.
 * @returns the parsed entries in directory order.
 */
function parseDirectory(directory: Buffer, limits: ZipReaderLimits): ZipEntry[] {
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const entries: ZipEntry[] = []
  const foldKeys = new Set<string>()
  let offset = 0
  while (offset < directory.byteLength) {
    if (entries.length >= limits.maxEntries) {
      throw new TransferError('too-many-entries', `archive holds more than ${String(limits.maxEntries)} entries`)
    }
    if (offset + CENTRAL_FIXED_LENGTH > directory.byteLength) {
      throw new TransferError('bad-archive', 'central directory is truncated')
    }
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new TransferError('bad-archive', 'central directory record signature mismatch')
    }
    if ((view.getUint16(offset + 8, true) & 1) !== 0) {
      throw new TransferError('bad-archive', 'encrypted entries are not supported')
    }
    const method = view.getUint16(offset + 10, true)
    if (method !== 0 && method !== 8) {
      throw new TransferError('bad-archive', `unsupported compression method ${String(method)}`)
    }
    const crc = view.getUint32(offset + 16, true)
    let compressedSize = view.getUint32(offset + 20, true)
    let uncompressedSize = view.getUint32(offset + 24, true)
    let headerOffset = view.getUint32(offset + 42, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    if (view.getUint16(offset + 34, true) !== 0) {
      throw new TransferError('bad-archive', 'entries spanning disks are not supported')
    }
    const nameStart = offset + CENTRAL_FIXED_LENGTH
    const extraStart = nameStart + nameLength
    const recordEnd = extraStart + extraLength + commentLength
    if (recordEnd > directory.byteLength) {
      throw new TransferError('bad-archive', 'central directory is truncated')
    }
    // ZIP64 extended information carries 8-byte fields in the fixed order
    // (uncompressed, compressed, header offset), and only for fields the
    // classic record stored as `0xFFFFFFFF`.
    let extraOffset = extraStart
    const extraEnd = extraStart + extraLength
    while (extraOffset + 4 <= extraEnd) {
      const headerId = view.getUint16(extraOffset, true)
      const size = view.getUint16(extraOffset + 2, true)
      const fieldStart = extraOffset + 4
      if (fieldStart + size > extraEnd) {
        throw new TransferError('bad-archive', 'entry extra field is truncated')
      }
      if (headerId === ZIP64_EXTRA_HEADER_ID) {
        let fieldOffset = fieldStart
        const take64 = (): number => {
          if (fieldOffset + 8 > fieldStart + size) {
            throw new TransferError('bad-archive', 'zip64 extra field is truncated')
          }
          const value = largeFieldOf(view, fieldOffset)
          fieldOffset += 8
          return value
        }
        if (uncompressedSize === 0xffffffff) uncompressedSize = take64()
        if (compressedSize === 0xffffffff) compressedSize = take64()
        if (headerOffset === 0xffffffff) headerOffset = take64()
      }
      extraOffset = fieldStart + size
    }
    let name: string
    try {
      name = decoder.decode(directory.subarray(nameStart, extraStart))
    } catch {
      throw new TransferError('bad-archive', 'entry name is not valid UTF-8')
    }
    validateEntryName(name, limits)
    const directoryEntry = name.endsWith('/')
    if (!directoryEntry && uncompressedSize > limits.maxEntryBytes) {
      throw new TransferError('entry-too-large', `entry "${name}" exceeds the supported size`)
    }
    const foldKey = name.normalize('NFC').toLowerCase()
    if (foldKeys.has(foldKey)) {
      throw new TransferError('path-conflict', `archive contains conflicting entries folding to "${foldKey}"`)
    }
    foldKeys.add(foldKey)
    entries.push({
      name,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      method,
      headerOffset,
      directory: directoryEntry,
    })
    offset = recordEnd
  }
  return entries
}

/** Random-access reader over one spooled archive file. */
export class ZipArchiveReader {
  private constructor(
    private readonly handle: FileHandle,
    private readonly size: number,
    private readonly limits: ZipReaderLimits,
    private readonly parsed: readonly ZipEntry[],
    private readonly byName: ReadonlyMap<string, ZipEntry>,
  ) {}

  /**
   * Open one archive file, parse and validate its central directory, and keep
   * the handle for entry reads.
   * @param path - spooled archive path.
   * @param limits - reader ceilings; defaults when omitted.
   * @returns the open reader.
   */
  static async open(path: string, limits: ZipReaderLimits = DEFAULT_ZIP_READER_LIMITS): Promise<ZipArchiveReader> {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      if (size < EOCD_FIXED_LENGTH) throw new TransferError('bad-archive', 'archive is too small to be a zip')
      const location = await locateDirectory(handle, size)
      if (location.entryCount > limits.maxEntries) {
        throw new TransferError('too-many-entries', `archive holds more than ${String(limits.maxEntries)} entries`)
      }
      if (location.directoryOffset + location.directorySize > size) {
        throw new TransferError('bad-archive', 'central directory extends past the end of the archive')
      }
      // Fixed bytes plus per-record slack bound the directory read before any
      // allocation, so a hostile record count cannot demand gigabytes.
      const maxDirectorySize = location.entryCount * CENTRAL_ENTRY_SLACK_BYTES + limits.maxNameBytes + MAX_COMMENT_LENGTH
      if (location.directorySize > maxDirectorySize) {
        throw new TransferError('too-many-entries', 'central directory size exceeds the entry budget')
      }
      const directory = Buffer.alloc(location.directorySize)
      await readExactAt(handle, directory, location.directoryOffset)
      const entries = parseDirectory(directory, limits)
      const byName = new Map(entries.map(entry => [entry.name, entry]))
      return new ZipArchiveReader(handle, size, limits, entries, byName)
    } catch (error: unknown) {
      await handle.close()
      throw error
    }
  }

  /** Every parsed entry in central-directory order. */
  get entries(): readonly ZipEntry[] {
    return this.parsed
  }

  /**
   * Look one entry up by exact name.
   * @param name - the entry name as stored.
   * @returns the entry, or `undefined` when absent.
   */
  entryByName(name: string): ZipEntry | undefined {
    return this.byName.get(name)
  }

  /**
   * Stream one entry's decompressed bytes, verifying the declared uncompressed
   * size and the central-directory CRC-32 before completion. The generator
   * throws `crc-mismatch` on tampering and `bad-archive` on truncation or a
   * local header that disagrees with the central directory.
   * @param entry - an entry returned by `entries` or `entryByName`.
   * @param signal - optional cancellation observed between file reads.
   * @returns the decompressed bytes in bounded chunks.
   */
  async *bytes(entry: ZipEntry, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    if (entry.directory) return
    if (entry.uncompressedSize > this.limits.maxEntryBytes) {
      throw new TransferError('entry-too-large', `entry "${entry.name}" exceeds the supported size`)
    }
    if (entry.headerOffset + LOCAL_FIXED_LENGTH > this.size) {
      throw new TransferError('bad-archive', 'entry header extends past the end of the archive')
    }
    const local = Buffer.alloc(LOCAL_FIXED_LENGTH)
    await readExactAt(this.handle, local, entry.headerOffset)
    const localView = new DataView(local.buffer, local.byteOffset, local.byteLength)
    if (localView.getUint32(0, true) !== LOCAL_SIGNATURE) {
      throw new TransferError('bad-archive', 'local header signature mismatch')
    }
    const localNameLength = localView.getUint16(26, true)
    const localExtraLength = localView.getUint16(28, true)
    const dataStart = entry.headerOffset + LOCAL_FIXED_LENGTH + localNameLength + localExtraLength
    if (dataStart + entry.compressedSize > this.size) {
      throw new TransferError('bad-archive', 'entry data extends past the end of the archive')
    }
    const localName = Buffer.alloc(localNameLength)
    await readExactAt(this.handle, localName, entry.headerOffset + LOCAL_FIXED_LENGTH)
    if (!localName.equals(Buffer.from(entry.name, 'utf8'))) {
      throw new TransferError('bad-archive', 'local header name disagrees with the central directory')
    }
    const checksum = new Crc32()
    let written = 0
    let inflateFailure: Error | undefined
    const pending: Uint8Array[] = []
    const drain = function* (): Generator<Uint8Array> {
      while (pending.length > 0) {
        const chunk = pending.shift()
        if (chunk !== undefined && chunk.byteLength > 0) yield chunk
      }
    }
    if (entry.method === 0) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, Math.max(entry.compressedSize, 1)))
      for (let offset = 0; offset < entry.compressedSize; offset += chunk.byteLength) {
        signal?.throwIfAborted()
        const length = Math.min(chunk.byteLength, entry.compressedSize - offset)
        const view = length === chunk.byteLength ? chunk : Buffer.alloc(length)
        await readExactAt(this.handle, view, dataStart + offset)
        checksum.update(view)
        written += view.byteLength
        yield view
      }
    } else {
      // fflate's synchronous Inflate reports chunks through `(data, final)`;
      // malformed streams are thrown from `push`, never surfaced in the
      // callback.
      const inflator = new Inflate((chunk) => {
        checksum.update(chunk)
        written += chunk.byteLength
        pending.push(chunk)
      })
      const compressed = Buffer.alloc(Math.min(READ_CHUNK_BYTES, Math.max(entry.compressedSize, 1)))
      for (let offset = 0; offset < entry.compressedSize; offset += compressed.byteLength) {
        signal?.throwIfAborted()
        const length = Math.min(compressed.byteLength, entry.compressedSize - offset)
        const view = length === compressed.byteLength ? compressed : Buffer.alloc(length)
        await readExactAt(this.handle, view, dataStart + offset)
        try {
          inflator.push(view, false)
        } catch (pushError: unknown) {
          inflateFailure = pushError instanceof Error ? pushError : new Error(String(pushError))
        }
        if (inflateFailure !== undefined) {
          throw new TransferError('bad-archive', `entry "${entry.name}" is not valid deflate data: ${inflateFailure.message}`)
        }
        yield* drain()
      }
      try {
        inflator.push(new Uint8Array(), true)
      } catch (pushError: unknown) {
        inflateFailure = pushError instanceof Error ? pushError : new Error(String(pushError))
      }
      if (inflateFailure !== undefined) {
        throw new TransferError('bad-archive', `entry "${entry.name}" is not valid deflate data: ${inflateFailure.message}`)
      }
      yield* drain()
    }
    signal?.throwIfAborted()
    if (written !== entry.uncompressedSize) {
      throw new TransferError(
        'bad-archive',
        `entry "${entry.name}" decompressed to ${String(written)} bytes, expected ${String(entry.uncompressedSize)}`,
      )
    }
    if (checksum.digest() !== entry.crc32) {
      throw new TransferError('crc-mismatch', `entry "${entry.name}" failed its checksum`)
    }
  }

  /** Release the file handle. */
  async close(): Promise<void> {
    await this.handle.close()
  }
}
