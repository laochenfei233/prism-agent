import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'

import { Crc32 } from '../src/crc32.ts'
import { DEFAULT_ZIP_READER_LIMITS, ZipArchiveReader, type ZipEntry } from '../src/zip-reader.ts'

const tempRoot = await mkdtemp(join(tmpdir(), 'prism-transfer-zip-'))

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

/** Write bytes to one spooled archive file and open it. */
async function openArchive(bytes: Uint8Array, limits?: Partial<typeof DEFAULT_ZIP_READER_LIMITS>) {
  const path = join(tempRoot, `${randomUUID()}.zip`)
  await writeFile(path, bytes)
  return ZipArchiveReader.open(path, { ...DEFAULT_ZIP_READER_LIMITS, ...limits })
}

/** CRC-32 reference computed with node's own table-free implementation shape. */
function crcOf(bytes: Uint8Array): number {
  const checksum = new Crc32()
  checksum.update(bytes)
  return checksum.digest()
}

/** Walk local headers to find where stored entry data begins and ends. */
function localDataSpan(bytes: Uint8Array, index: number): { start: number; end: number } {
  let offset = 0
  for (let step = 0; step <= index; step += 1) {
    if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4b || bytes[offset + 2] !== 0x03 || bytes[offset + 3] !== 0x04) {
      throw new Error(`local header ${String(step)} not found at ${String(offset)}`)
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
    const nameLength = view.getUint16(26, true)
    const extraLength = view.getUint16(28, true)
    const compressedSize = view.getUint32(18, true)
    const start = offset + 30 + nameLength + extraLength
    if (step === index) return { start, end: start + compressedSize }
    offset = start + compressedSize
  }
  throw new Error('local header walk ran past the archive')
}

/** Flip one byte inside the stored data region of entry `index`. */
function corruptStoredData(bytes: Uint8Array, index: number): Uint8Array {
  const { start } = localDataSpan(bytes, index)
  const corrupted = Uint8Array.from(bytes)
  corrupted[start] = (corrupted[start]! + 1) & 0xff
  return corrupted
}

/** Walk the real central directory (via the EOCD) to find one record's offset. */
function centralRecordOf(bytes: Uint8Array, name: string): number {
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
    if (view.getUint32(0, true) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('no end of central directory')
  const head = new DataView(bytes.buffer, bytes.byteOffset + eocd)
  let offset = head.getUint32(16, true)
  const end = offset + head.getUint32(12, true)
  while (offset < end) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
    const nameLength = view.getUint16(28, true)
    const extraLength = view.getUint16(30, true)
    const commentLength = view.getUint16(32, true)
    const candidate = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (candidate === name) return offset
    offset += 46 + nameLength + extraLength + commentLength
  }
  throw new Error(`central record for "${name}" not found`)
}

/** Patch a u16 field inside one central-directory record. */
function patchCentralU16(bytes: Uint8Array, recordOffset: number, fieldOffset: number, value: number): Uint8Array {
  const patched = Uint8Array.from(bytes)
  const view = new DataView(patched.buffer)
  view.setUint16(recordOffset + fieldOffset, value, true)
  return patched
}

/** Patch a u32 field at one absolute archive offset. */
function patchU32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const patched = Uint8Array.from(bytes)
  new DataView(patched.buffer).setUint32(offset, value, true)
  return patched
}

/** Patch a u16 field at one absolute archive offset. */
function patchU16(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const patched = Uint8Array.from(bytes)
  new DataView(patched.buffer).setUint16(offset, value, true)
  return patched
}

/** The classic end-of-central-directory record's offset. */
function eocdOffsetOf(bytes: Uint8Array): number {
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
    if (view.getUint32(0, true) === 0x06054b50) return offset
  }
  throw new Error('no end of central directory')
}

/**
 * Splice a ZIP64 locator and record in front of the classic EOCD, mark the
 * classic fields as `0xFFFFFFFF`/`0xFFFF`, and let the caller mutate either
 * structure before the splice.
 */
function spliceZip64(
  bytes: Uint8Array,
  mutate: (parts: { record: DataView; locator: DataView }) => void = () => {},
): Uint8Array {
  const eocd = eocdOffsetOf(bytes)
  const view = new DataView(bytes.buffer, bytes.byteOffset + eocd)
  const totalEntries = view.getUint16(10, true)
  const directorySize = view.getUint32(12, true)
  const directoryOffset = view.getUint32(16, true)
  const record = new Uint8Array(56)
  const recordView = new DataView(record.buffer)
  recordView.setUint32(0, 0x06064b50, true)
  recordView.setBigUint64(4, 44n, true)
  recordView.setUint16(12, 45, true)
  recordView.setUint16(14, 45, true)
  recordView.setBigUint64(32, BigInt(totalEntries), true)
  recordView.setBigUint64(40, BigInt(directorySize), true)
  recordView.setBigUint64(48, BigInt(directoryOffset), true)
  const locator = new Uint8Array(20)
  const locatorView = new DataView(locator.buffer)
  locatorView.setUint32(0, 0x07064b50, true)
  locatorView.setBigUint64(8, BigInt(eocd), true)
  locatorView.setUint32(16, 1, true)
  mutate({ record: recordView, locator: locatorView })
  const patched = Uint8Array.from(bytes)
  const patchedView = new DataView(patched.buffer, patched.byteOffset + eocd)
  patchedView.setUint32(16, 0xffffffff, true)
  patchedView.setUint32(12, 0xffffffff, true)
  patchedView.setUint16(10, 0xffff, true)
  const zip64 = new Uint8Array(patched.length + 76)
  zip64.set(patched.subarray(0, eocd))
  zip64.set(record, eocd)
  zip64.set(locator, eocd + 56)
  zip64.set(patched.subarray(eocd), eocd + 76)
  return zip64
}

/**
 * Append one raw extra field into the named central-directory record,
 * growing the directory and fixing the EOCD's directory-size field.
 */
function insertCentralExtra(bytes: Uint8Array, name: string, field: readonly number[]): Uint8Array {
  const record = centralRecordOf(bytes, name)
  const recordView = new DataView(bytes.buffer, bytes.byteOffset + record)
  const nameLength = recordView.getUint16(28, true)
  const extraStart = record + 46 + nameLength
  const recordEnd = extraStart + recordView.getUint16(30, true) + recordView.getUint16(32, true)
  const eocd = eocdOffsetOf(bytes)
  const directorySize = new DataView(bytes.buffer, bytes.byteOffset + eocd).getUint32(12, true)
  const spliced = new Uint8Array(bytes.length + field.length)
  spliced.set(bytes.subarray(0, extraStart))
  spliced.set(field, extraStart)
  spliced.set(bytes.subarray(extraStart, recordEnd), extraStart + field.length)
  spliced.set(bytes.subarray(recordEnd), recordEnd + field.length)
  const splicedView = new DataView(spliced.buffer)
  splicedView.setUint16(record + 30, recordView.getUint16(30, true) + field.length, true)
  splicedView.setUint32(eocd + field.length + 12, directorySize + field.length, true)
  return spliced
}

/** One zip64 extra field body: id, size, then three u64 slots. */
function zip64Extra(values: { uncompressed?: bigint; compressed?: bigint; headerOffset?: bigint; declaredSize?: number }): number[] {
  const body: number[] = []
  const slot = (value: bigint | undefined): void => {
    for (let index = 0; index < 8; index += 1) body.push(Number((value ?? 0n) >> BigInt(8 * index) & 0xffn))
  }
  slot(values.uncompressed)
  slot(values.compressed)
  slot(values.headerOffset)
  const data = body.slice(0, values.declaredSize ?? body.length)
  return [0x01, 0x00, data.length & 0xff, data.length >> 8 & 0xff, ...data]
}

/** Deterministic pseudo-random bytes, incompressible enough to inflate deflate sizes. */
function pseudoRandomBytes(length: number): Uint8Array {
  let state = 0x12345678
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    bytes[index] = state >>> 24
  }
  return bytes
}

describe('Crc32', () => {
  it('matches the standard check vector', () => {
    expect(crcOf(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('is zero for empty input and splits cleanly across chunks', () => {
    const bytes = new TextEncoder().encode('The quick brown fox jumps over the lazy dog')
    expect(crcOf(new Uint8Array())).toBe(0)
    const split = new Crc32()
    split.update(bytes.subarray(0, 7))
    split.update(bytes.subarray(7))
    expect(split.digest()).toBe(crcOf(bytes))
  })
})

describe('ZipArchiveReader.open', () => {
  it('round-trips a plain archive: listing, byte reads, CRC verification', async () => {
    const text = new TextEncoder().encode('hello archive\n')
    const media = new TextEncoder().encode('fake png bytes')
    const bytes = zipSync({
      'project/选题.md': new TextEncoder().encode('# 选题\n'),
      'sessions/abc123/session.v4.jsonl': text,
      'sessions/abc123/media/sha256:abcd.png': media,
      'empty.txt': new Uint8Array(),
    }, { level: 6 })
    const reader = await openArchive(bytes)
    try {
      expect(reader.entries.map(entry => entry.name)).toEqual([
        'project/选题.md',
        'sessions/abc123/session.v4.jsonl',
        'sessions/abc123/media/sha256:abcd.png',
        'empty.txt',
      ])
      const entry = reader.entryByName('sessions/abc123/session.v4.jsonl')!
      const chunks: Uint8Array[] = []
      for await (const chunk of reader.bytes(entry)) chunks.push(chunk)
      const joined = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
      expect(joined.equals(Buffer.from(text))).toBe(true)
      const empty = reader.entryByName('empty.txt')!
      for await (const chunk of reader.bytes(empty)) chunks.push(chunk)
      expect(reader.entryByName('missing.txt')).toBeUndefined()
    } finally {
      await reader.close()
    }
  })

  it('reads a stored (level 0) archive identically', async () => {
    const content = new TextEncoder().encode('stored media bytes')
    const bytes = zipSync({ 'media.bin': content }, { level: 0 })
    const reader = await openArchive(bytes)
    try {
      const chunks: Uint8Array[] = []
      for await (const chunk of reader.bytes(reader.entries[0]!)) chunks.push(chunk)
      expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).equals(Buffer.from(content))).toBe(true)
    } finally {
      await reader.close()
    }
  })

  it('parses a hand-built ZIP64 directory (locator + record + 0xFFFFFFFF markers)', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('zip64') }, { level: 6 })
    // Locate the classic EOCD, then splice the ZIP64 record and locator in
    // immediately before it — the layout real ZIP64 writers produce.
    let eocd = -1
    for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
      if (view.getUint32(0, true) === 0x06054b50) {
        eocd = offset
        break
      }
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + eocd)
    const totalEntries = view.getUint16(10, true)
    const directorySize = view.getUint32(12, true)
    const directoryOffset = view.getUint32(16, true)
    const zip64Record = new Uint8Array(56)
    const recordView = new DataView(zip64Record.buffer)
    recordView.setUint32(0, 0x06064b50, true)
    recordView.setBigUint64(4, 44n, true)
    recordView.setUint16(12, 45, true)
    recordView.setUint16(14, 45, true)
    recordView.setBigUint64(32, BigInt(totalEntries), true)
    recordView.setBigUint64(40, BigInt(directorySize), true)
    recordView.setBigUint64(48, BigInt(directoryOffset), true)
    const locator = new Uint8Array(20)
    const locatorView = new DataView(locator.buffer)
    locatorView.setUint32(0, 0x07064b50, true)
    locatorView.setBigUint64(8, BigInt(eocd), true)
    locatorView.setUint32(16, 1, true)
    const patched = Uint8Array.from(bytes)
    const patchedView = new DataView(patched.buffer, patched.byteOffset + eocd)
    patchedView.setUint32(16, 0xffffffff, true)
    patchedView.setUint32(12, 0xffffffff, true)
    patchedView.setUint16(10, 0xffff, true)
    const zip64 = new Uint8Array(patched.length + 76)
    zip64.set(patched.subarray(0, eocd))
    zip64.set(zip64Record, eocd)
    zip64.set(locator, eocd + 56)
    zip64.set(patched.subarray(eocd), eocd + 76)
    const reader = await openArchive(zip64)
    try {
      expect(reader.entries).toHaveLength(1)
      expect(reader.entries[0]!.name).toBe('a.txt')
    } finally {
      await reader.close()
    }
  })

  it('rejects non-archives and truncated files', async () => {
    await expect(openArchive(new TextEncoder().encode('definitely not a zip archive at all'))).rejects.toMatchObject({
      code: 'bad-archive',
    })
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    await expect(openArchive(bytes.subarray(0, bytes.length - 10))).rejects.toMatchObject({ code: 'bad-archive' })
    await expect(openArchive(new Uint8Array(8))).rejects.toMatchObject({ code: 'bad-archive' })
  })

  it('rejects a central directory that claims to extend past the file', async () => {
    const bytes = Uint8Array.from(zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 }))
    let eocd = -1
    for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset)
      if (view.getUint32(0, true) === 0x06054b50) {
        eocd = offset
        break
      }
    }
    const view = new DataView(bytes.buffer)
    view.setUint32(eocd + 12, 0xffffffff, true)
    await expect(openArchive(bytes)).rejects.toMatchObject({ code: 'bad-archive' })
  })

  it.each([
    ['parent traversal', { '../evil.txt': new Uint8Array([1]) }],
    ['absolute path', { '/etc/passwd': new Uint8Array([1]) }],
    ['backslash', { 'a\\b.txt': new Uint8Array([1]) }],
    ['drive prefix', { 'C:evil.txt': new Uint8Array([1]) }],
    ['dot segment', { 'a/./b.txt': new Uint8Array([1]) }],
    ['dot-dot segment', { 'a/../b.txt': new Uint8Array([1]) }],
    ['NUL in name', { 'a\u0000b.txt': new Uint8Array([1]) }],
    ['empty segment', { 'a//b.txt': new Uint8Array([1]) }],
  ])('rejects unsafe entry names: %s', async (_label, files) => {
    const bytes = zipSync(files, { level: 6 })
    await expect(openArchive(bytes)).rejects.toMatchObject({ code: 'unsafe-path' })
  })

  it('rejects case-folding and NFC duplicate entries', async () => {
    const bytes = zipSync({
      'project/a.txt': new Uint8Array([1]),
      'project/A.txt': new Uint8Array([2]),
    }, { level: 6 })
    await expect(openArchive(bytes)).rejects.toMatchObject({ code: 'path-conflict' })
    const nfcBytes = zipSync({
      'project/cafe\u0301.txt': new Uint8Array([1]),
      'project/café.txt': new Uint8Array([2]),
    }, { level: 6 })
    await expect(openArchive(nfcBytes)).rejects.toMatchObject({ code: 'path-conflict' })
  })

  it('rejects encrypted, unsupported-method, and non-UTF-8 records', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    const record = centralRecordOf(bytes, 'a.txt')
    await expect(openArchive(patchCentralU16(bytes, record, 8, 1))).rejects.toMatchObject({ code: 'bad-archive' })
    await expect(openArchive(patchCentralU16(bytes, record, 10, 12))).rejects.toMatchObject({ code: 'bad-archive' })
    const utf16Name = Uint8Array.from(bytes)
    utf16Name[record + 46] = 0xff
    await expect(openArchive(utf16Name)).rejects.toMatchObject({ code: 'bad-archive' })
  })

  it('enforces the entry-count and name-length ceilings', async () => {
    const bytes = zipSync({
      'a.txt': new Uint8Array([1]),
      'b.txt': new Uint8Array([2]),
      'c.txt': new Uint8Array([3]),
    }, { level: 6 })
    await expect(openArchive(bytes, { maxEntries: 2 })).rejects.toMatchObject({ code: 'too-many-entries' })
    const longName = 'x'.repeat(2000)
    const longBytes = zipSync({ [longName]: new Uint8Array([1]) }, { level: 6 })
    await expect(openArchive(longBytes)).rejects.toMatchObject({ code: 'bad-archive' })
  })

  it('rejects a declared per-entry size beyond the ceiling', async () => {
    const bytes = zipSync({ 'big.bin': new Uint8Array([1, 2, 3]) }, { level: 6 })
    await expect(openArchive(bytes, { maxEntryBytes: 2 })).rejects.toMatchObject({ code: 'entry-too-large' })
  })

  it('rejects a classic multi-disk archive', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    const eocd = eocdOffsetOf(bytes)
    await expect(openArchive(patchU16(bytes, eocd + 4, 1))).rejects.toMatchObject({
      message: 'multi-disk archives are not supported',
    })
  })

  it('rejects zip64 archives whose locator reports multiple disks', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    await expect(openArchive(spliceZip64(bytes, ({ locator }) => { locator.setUint32(4, 1, true) })))
      .rejects.toMatchObject({ message: 'multi-disk zip64 archives are not supported' })
    await expect(openArchive(spliceZip64(bytes, ({ locator }) => { locator.setUint16(16, 2, true) })))
      .rejects.toMatchObject({ message: 'multi-disk zip64 archives are not supported' })
  })

  it('rejects a locator that points short of a whole zip64 record', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    const zip64 = spliceZip64(bytes, ({ locator }) => {
      locator.setBigUint64(8, BigInt(bytes.length + 76 - 10), true)
    })
    await expect(openArchive(zip64)).rejects.toMatchObject({ message: 'archive is truncated' })
  })

  it('rejects a zip64 record with the wrong signature', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    const zip64 = spliceZip64(bytes, ({ locator }) => { locator.setBigUint64(8, 0n, true) })
    await expect(openArchive(zip64)).rejects.toMatchObject({
      message: 'zip64 end of central directory record is missing',
    })
  })

  it('rejects a zip64 record that reports multiple disks', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    const zip64 = spliceZip64(bytes, ({ record }) => { record.setUint32(16, 1, true) })
    await expect(openArchive(zip64)).rejects.toMatchObject({ message: 'multi-disk zip64 archives are not supported' })
  })

  it('rejects zip64 fields beyond the supported size range', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    const zip64 = spliceZip64(bytes, ({ record }) => { record.setBigUint64(32, 0x2000000000000000n, true) })
    await expect(openArchive(zip64)).rejects.toMatchObject({
      message: 'archive field exceeds the supported size range',
    })
  })

  it('rejects an entry record with an empty name', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    const record = centralRecordOf(bytes, 'a.txt')
    await expect(openArchive(patchCentralU16(bytes, record, 28, 0))).rejects.toMatchObject({
      message: 'archive contains an empty entry name',
    })
  })

  it('rejects entries that span disks', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    const record = centralRecordOf(bytes, 'a.txt')
    await expect(openArchive(patchCentralU16(bytes, record, 34, 1))).rejects.toMatchObject({
      message: 'entries spanning disks are not supported',
    })
  })

  it('enforces the entry ceiling against the real directory contents, not the declared count', async () => {
    const bytes = zipSync({
      'a.txt': new Uint8Array([1]),
      'b.txt': new Uint8Array([2]),
    }, { level: 6 })
    const eocd = eocdOffsetOf(bytes)
    const undercounted = patchU16(patchU16(bytes, eocd + 8, 1), eocd + 10, 1)
    await expect(openArchive(undercounted, { maxEntries: 1 })).rejects.toMatchObject({ code: 'too-many-entries' })
  })

  it('rejects a directory region that claims more bytes than its records fill', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    const eocd = eocdOffsetOf(bytes)
    const size = new DataView(bytes.buffer, bytes.byteOffset + eocd).getUint32(12, true)
    // The +20 claim still fits inside the file (the EOCD follows), while the
    // +46 claim needs trailing padding to pass the extent check first.
    await expect(openArchive(patchU32(bytes, eocd + 12, size + 20))).rejects.toMatchObject({
      message: 'central directory is truncated',
    })
    const padded = new Uint8Array(bytes.length + 64)
    padded.set(bytes)
    await expect(openArchive(patchU32(padded, eocd + 12, size + 46))).rejects.toMatchObject({
      message: 'central directory record signature mismatch',
    })
  })

  it('rejects a record whose comment overruns the directory', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    const record = centralRecordOf(bytes, 'a.txt')
    await expect(openArchive(patchCentralU16(bytes, record, 32, 0xffff))).rejects.toMatchObject({
      message: 'central directory is truncated',
    })
  })

  it('rejects an extra field that declares more bytes than the record carries', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    const padded = insertCentralExtra(bytes, 'a.txt', [0x0a, 0x00, 0x00, 0x01, 1, 2, 3, 4])
    await expect(openArchive(padded)).rejects.toMatchObject({ message: 'entry extra field is truncated' })
  })

  it('rejects a zip64 extra field whose declared slots overrun the field', async () => {
    const bytes = zipSync({ 'five!': new TextEncoder().encode('five!') }, { level: 6 })
    const record = centralRecordOf(bytes, 'five!')
    const marked = patchU32(patchU32(bytes, record + 20, 0xffffffff), record + 24, 0xffffffff)
    const padded = insertCentralExtra(marked, 'five!', zip64Extra({ uncompressed: 5n, declaredSize: 8 }))
    await expect(openArchive(padded)).rejects.toMatchObject({ message: 'zip64 extra field is truncated' })
  })

  it('resolves classic 0xFFFFFFFF fields through a zip64 extra field', async () => {
    const payload = new TextEncoder().encode('five!')
    const bytes = zipSync({ 'five!': payload }, { level: 0 })
    const record = centralRecordOf(bytes, 'five!')
    const base = new DataView(bytes.buffer, bytes.byteOffset + record)
    const headerOffset = base.getUint32(42, true)
    const marked = patchU32(patchU32(bytes, record + 20, 0xffffffff), record + 24, 0xffffffff)
    const markedOffset = patchU32(marked, record + 42, 0xffffffff)
    const padded = insertCentralExtra(markedOffset, 'five!', zip64Extra({
      uncompressed: BigInt(payload.byteLength),
      compressed: BigInt(payload.byteLength),
      headerOffset: BigInt(headerOffset),
    }))
    const reader = await openArchive(padded)
    try {
      const entry = reader.entryByName('five!')!
      expect(entry.uncompressedSize).toBe(payload.byteLength)
      expect(entry.compressedSize).toBe(payload.byteLength)
      expect(entry.headerOffset).toBe(headerOffset)
      const chunks: Uint8Array[] = []
      for await (const chunk of reader.bytes(entry)) chunks.push(chunk)
      expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).equals(Buffer.from(payload))).toBe(true)
    } finally {
      await reader.close()
    }
  })

  it('ignores a zip64 extra field when the classic fields are real', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    // A non-zip64 field first (skipped whole), then a zip64 field the classic
    // markers tell the parser not to consume.
    const withNtfs = insertCentralExtra(bytes, 'a.txt', [0x0a, 0x00, 0x04, 0x00, 1, 2, 3, 4])
    const padded = insertCentralExtra(withNtfs, 'a.txt', zip64Extra({ uncompressed: 1n, compressed: 1n }))
    const reader = await openArchive(padded)
    try {
      expect(reader.entries[0]?.uncompressedSize).toBe(1)
    } finally {
      await reader.close()
    }
  })

  it('rejects a directory whose declared size exceeds the entry-count budget', async () => {
    // Two max-length names grow the real directory past the per-entry budget's
    // fixed slack, so trailing padding can push the declared size over it while
    // the EOCD stays inside the reader's tail-search window.
    const longName = 'x'.repeat(1020) + '.txt'
    const bytes = zipSync({
      [longName]: new Uint8Array([1]),
      [`y${longName.slice(1)}`]: new Uint8Array([2]),
    }, { level: 6 })
    const eocd = eocdOffsetOf(bytes)
    const directorySize = new DataView(bytes.buffer, bytes.byteOffset + eocd).getUint32(12, true)
    const junk = new Uint8Array(65_400)
    const padded = new Uint8Array(bytes.length + junk.length)
    padded.set(bytes)
    padded.set(junk, bytes.length)
    const claimed = directorySize + 22 + junk.length
    await expect(openArchive(patchU32(padded, eocd + 12, claimed))).rejects.toMatchObject({
      message: 'central directory size exceeds the entry budget',
    })
  })

  it('rejects a directory whose declared offset reaches past the archive', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    await expect(openArchive(patchU32(bytes, eocdOffsetOf(bytes) + 16, bytes.length + 1000))).rejects.toMatchObject({
      message: 'central directory extends past the end of the archive',
    })
  })
})

describe('ZipArchiveReader.bytes integrity', () => {
  it('fails with crc-mismatch when stored bytes are tampered', async () => {
    const bytes = zipSync({
      'media.bin': new TextEncoder().encode('stored payload that must survive intact'),
      'other.txt': new TextEncoder().encode('untouched'),
    }, { level: 0 })
    const reader = await openArchive(corruptStoredData(bytes, 0))
    try {
      await expect(async () => {
        for await (const chunk of reader.bytes(reader.entries[0]!)) void chunk
      }).rejects.toMatchObject({ code: 'crc-mismatch' })
    } finally {
      await reader.close()
    }
  })

  it('fails with crc-mismatch when the recorded checksum lies about deflate data', async () => {
    const bytes = zipSync({ 'log.jsonl': new TextEncoder().encode('{"type":"session"}\n') }, { level: 6 })
    const record = centralRecordOf(bytes, 'log.jsonl')
    const patched = Uint8Array.from(bytes)
    const view = new DataView(patched.buffer)
    view.setUint32(record + 16, 0xdeadbeef, true)
    const reader = await openArchive(patched)
    try {
      await expect(async () => {
        for await (const chunk of reader.bytes(reader.entries[0]!)) void chunk
      }).rejects.toMatchObject({ code: 'crc-mismatch' })
    } finally {
      await reader.close()
    }
  })

  it('fails with bad-archive when a local header disagrees with the directory', async () => {
    const bytes = zipSync({
      'first.txt': new TextEncoder().encode('one'),
      'second.txt': new TextEncoder().encode('two'),
    }, { level: 6 })
    const record = centralRecordOf(bytes, 'second.txt')
    const view = new DataView(bytes.buffer, bytes.byteOffset + record)
    const headerOffset = view.getUint32(42, true)
    const patched = Uint8Array.from(bytes)
    patched[headerOffset + 30] = (patched[headerOffset + 30]! + 1) & 0xff
    const reader = await openArchive(patched)
    try {
      const entry = reader.entryByName('second.txt')!
      await expect(async () => {
        for await (const chunk of reader.bytes(entry)) void chunk
      }).rejects.toMatchObject({ code: 'bad-archive' })
    } finally {
      await reader.close()
    }
  })

  it('fails with bad-archive when deflate data is garbage', async () => {
    const bytes = zipSync({ 'log.txt': new TextEncoder().encode('deflate me please') }, { level: 6 })
    const { start } = localDataSpan(bytes, 0)
    const patched = Uint8Array.from(bytes)
    for (let offset = start; offset < start + 8; offset += 1) patched[offset] = 0xa5
    const reader = await openArchive(patched)
    try {
      await expect(async () => {
        for await (const chunk of reader.bytes(reader.entries[0]!)) void chunk
      }).rejects.toMatchObject({ code: 'bad-archive' })
    } finally {
      await reader.close()
    }
  })

  it('fails with bad-archive when the decompressed size disagrees with the directory', async () => {
    const bytes = zipSync({ 'log.txt': new TextEncoder().encode('size will be patched') }, { level: 6 })
    const record = centralRecordOf(bytes, 'log.txt')
    const patched = Uint8Array.from(bytes)
    const view = new DataView(patched.buffer)
    view.setUint32(record + 24, 999, true)
    const reader = await openArchive(patched)
    try {
      await expect(async () => {
        for await (const chunk of reader.bytes(reader.entries[0]!)) void chunk
      }).rejects.toMatchObject({ code: 'bad-archive' })
    } finally {
      await reader.close()
    }
  })

  it('fails mid-stream when corrupted deflate data breaks an intermediate chunk', async () => {
    const payload = new TextEncoder().encode('The quick brown fox jumps over the lazy dog. '.repeat(50))
    const bytes = zipSync({ 'log.txt': payload }, { level: 6 })
    const { start } = localDataSpan(bytes, 0)
    const corrupted = Uint8Array.from(bytes.subarray(start, start + 10))
    corrupted[2] = 0xff
    bytes.set(corrupted, start)
    const reader = await openArchive(bytes)
    try {
      await expect(async () => {
        for await (const chunk of reader.bytes(reader.entries[0]!)) void chunk
      }).rejects.toMatchObject({ code: 'bad-archive' })
    } finally {
      await reader.close()
    }
  })

  it('serves stored entries larger than one read chunk, and observes an abort between chunks', async () => {
    const payload = pseudoRandomBytes(300_000)
    const reader = await openArchive(zipSync({ 'media.bin': payload }, { level: 0 }))
    try {
      const entry = reader.entries[0]!
      const chunks: Uint8Array[] = []
      for await (const chunk of reader.bytes(entry)) chunks.push(chunk)
      expect(chunks.length).toBe(2)
      expect(chunks[0]!.byteLength).toBe(1 << 18)
      expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).equals(Buffer.from(payload))).toBe(true)
      const aborted = new AbortController()
      const abortedIterator = reader.bytes(entry, aborted.signal)[Symbol.asyncIterator]()
      await abortedIterator.next()
      aborted.abort()
      await expect(abortedIterator.next()).rejects.toThrow()
    } finally {
      await reader.close()
    }
  })

  it('serves deflate entries whose compressed size spans multiple read chunks', async () => {
    const payload = pseudoRandomBytes(400_000)
    const reader = await openArchive(zipSync({ 'blob.bin': payload }, { level: 6 }))
    try {
      expect(reader.entries[0]!.compressedSize).toBeGreaterThan(1 << 18)
      const chunks: Uint8Array[] = []
      for await (const chunk of reader.bytes(reader.entries[0]!)) chunks.push(chunk)
      expect(chunks.length).toBeGreaterThan(1)
      expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).equals(Buffer.from(payload))).toBe(true)
    } finally {
      await reader.close()
    }
  })

  it('yields nothing for a directory record', async () => {
    const reader = await openArchive(zipSync({ 'docs/a.txt': new Uint8Array([1]) }, { level: 6 }))
    try {
      // The open() parser refuses trailing-slash names, so a directory entry
      // can only reach bytes() from a caller that fabricates one.
      const directory: ZipEntry = {
        name: 'docs/',
        crc32: 0,
        compressedSize: 0,
        uncompressedSize: 0,
        method: 0,
        headerOffset: 0,
        directory: true,
      }
      const chunks: Uint8Array[] = []
      for await (const chunk of reader.bytes(directory)) chunks.push(chunk)
      expect(chunks).toEqual([])
    } finally {
      await reader.close()
    }
  })

  it('refuses entries whose local header offset reaches past the archive', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    const record = centralRecordOf(bytes, 'a.txt')
    const reader = await openArchive(patchU32(bytes, record + 42, bytes.length + 100))
    try {
      await expect(async () => {
        for await (const chunk of reader.bytes(reader.entries[0]!)) void chunk
      }).rejects.toMatchObject({ message: 'entry header extends past the end of the archive' })
    } finally {
      await reader.close()
    }
  })

  it('refuses an entry whose local header signature is wrong', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    const record = centralRecordOf(bytes, 'a.txt')
    const headerOffset = new DataView(bytes.buffer, bytes.byteOffset + record).getUint32(42, true)
    const patched = patchU32(bytes, headerOffset, 0x02014b50)
    const reader = await openArchive(patched)
    try {
      await expect(async () => {
        for await (const chunk of reader.bytes(reader.entries[0]!)) void chunk
      }).rejects.toMatchObject({ message: 'local header signature mismatch' })
    } finally {
      await reader.close()
    }
  })

  it('refuses an entry whose data region claims more bytes than the archive holds', async () => {
    const bytes = zipSync({ 'a.txt': new TextEncoder().encode('x') }, { level: 6 })
    const record = centralRecordOf(bytes, 'a.txt')
    const compressed = new DataView(bytes.buffer, bytes.byteOffset + record).getUint32(20, true)
    const reader = await openArchive(patchU32(bytes, record + 20, compressed + 1000))
    try {
      await expect(async () => {
        for await (const chunk of reader.bytes(reader.entries[0]!)) void chunk
      }).rejects.toMatchObject({ message: 'entry data extends past the end of the archive' })
    } finally {
      await reader.close()
    }
  })
})
