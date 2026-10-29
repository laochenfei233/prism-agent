/**
 * Shared readers for foreign conversation stores: tolerant JSON access, JSONL
 * streaming, Zstandard frames, directory walks, and read-only SQLite handles.
 *
 * Every file and database here is untrusted input, so values are validated
 * before use instead of trusted from a static type.
 *
 * @module @deepseek-ai/dsh-session-import/sources/shared
 */

import { createReadStream } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { zstdDecompressSync } from 'node:zlib'
import type { DatabaseSync } from 'node:sqlite'
import type { ImportedMessage } from '../types.ts'

/** A JSON object read from an untrusted file or database row. */
export type JsonRecord = Readonly<Record<string, unknown>>

/**
 * Reject non-objects, arrays, and JSON null.
 * @param value - untrusted JSON value.
 * @returns a plain record, or undefined for any other JSON shape.
 */
export function recordOf(value: unknown): JsonRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

/**
 * Reject non-arrays.
 * @param value - untrusted JSON value.
 * @returns the array, or undefined for any other JSON shape.
 */
export function listOf(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

/**
 * Reject non-strings and the empty string.
 * @param value - untrusted JSON value.
 * @returns the non-empty string, or undefined.
 */
export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Reject non-finite numbers.
 * @param value - untrusted JSON value.
 * @returns the finite number, or undefined.
 */
export function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Parse a JSON text column without throwing.
 * @param value - untrusted column value.
 * @returns the parsed value, or undefined when the column is not valid JSON text.
 */
export function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/**
 * Read an epoch timestamp from milliseconds, seconds, or an ISO string.
 * @param value - untrusted timestamp field.
 * @param fallback - value to use when the field is absent or unrecognized.
 * @returns Unix epoch milliseconds.
 */
export function timeOf(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value < 1e11 ? value * 1000 : value)
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/**
 * Concatenate the text blocks of a message content value.
 *
 * Accepts a bare string or an array of typed blocks; non-text blocks
 * (reasoning, tool calls, images) contribute nothing.
 * @param value - untrusted content field.
 * @returns joined text, with blank output for content that carries no text.
 */
export function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  const blocks = listOf(value)
  if (blocks === undefined) return ''
  const parts: string[] = []
  for (const block of blocks) {
    const record = recordOf(block)
    if (record === undefined) continue
    if (record['type'] !== undefined && record['type'] !== 'text' && record['type'] !== 'input_text'
      && record['type'] !== 'output_text') continue
    const text = stringOf(record['text'])
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}

/** Phrases that mark harness-injected user text rather than a human prompt. */
const SYNTHETIC_PREFIXES = [
  '<system-reminder>',
  '<user_info>',
  '<environment_context>',
  '<command-name>',
  '<local-command-stdout>',
  '<local-command-caveat>',
] as const

/**
 * Decide whether a user message is a real human prompt.
 * @param text - candidate user text.
 * @returns whether the text should be imported.
 */
export function isHumanPrompt(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  return !SYNTHETIC_PREFIXES.some(prefix => trimmed.startsWith(prefix))
}

/**
 * Append one normalized message when its text survives cleaning.
 * @param messages - accumulator in source order.
 * @param role - speaker.
 * @param text - raw message text.
 * @param time - message timestamp in Unix epoch milliseconds.
 * @param human - whether a user message must pass {@link isHumanPrompt}.
 */
export function pushMessage(
  messages: ImportedMessage[],
  role: ImportedMessage['role'],
  text: string,
  time: number,
  human = false,
): void {
  const clean = text.trim()
  if (clean.length === 0) return
  if (role === 'user' && human && !isHumanPrompt(clean)) return
  messages.push({ role, text: clean, time })
}

/**
 * Truncate text to a UTF-8 byte budget without splitting a code point.
 * @param text - message text.
 * @param maxBytes - byte budget.
 * @returns the original text, or a prefix with a visible marker.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return text
  const marker = '\n\n[truncated]'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker))
  let end = budget
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return `${buffer.subarray(0, end).toString('utf8')}${marker}`
}

/**
 * Stream one JSONL file, parsing each line independently.
 * @param path - file to read.
 * @param visit - called with each parsed JSON value; returning `false` stops the read.
 */
export async function forEachJsonLine(
  path: string,
  visit: (value: unknown, index: number) => boolean | void,
): Promise<void> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  let index = 0
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch (error: unknown) {
        throw new Error(`${path}:${index + 1}: malformed JSON (${messageOf(error)})`)
      }
      if (visit(value, index) === false) return
      index += 1
    }
  } finally {
    lines.close()
  }
}

/**
 * Read only the first JSONL record of a file.
 * @param path - file to read.
 * @returns the first parsed value, or undefined for an empty file.
 */
export async function readFirstJsonLine(path: string): Promise<unknown> {
  let first: unknown
  await forEachJsonLine(path, (value) => {
    first = value
    return false
  })
  return first
}

/**
 * Read every JSONL record of a file.
 * @param path - file to read.
 * @returns parsed records in file order.
 */
export async function readAllJsonLines(path: string): Promise<unknown[]> {
  const values: unknown[] = []
  await forEachJsonLine(path, (value) => {
    values.push(value)
  })
  return values
}

/**
 * Stream one JSONL file, decompressing a `.zst`/`.zstd` container first.
 * @param path - file to read.
 * @param visit - called with each parsed JSON value; returning `false` stops the read.
 */
export async function forEachDecodedJsonLine(
  path: string,
  visit: (value: unknown, index: number) => boolean | void,
): Promise<void> {
  if (!path.endsWith('.zst') && !path.endsWith('.zstd')) {
    await forEachJsonLine(path, visit)
    return
  }
  const lines = (await readTextFile(path)).split('\n')
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error: unknown) {
      throw new Error(`${path}:${index + 1}: malformed JSON (${messageOf(error)})`)
    }
    if (visit(value, index) === false) return
  }
}

/**
 * Read only the first JSONL record of a plain or Zstandard-compressed file.
 * @param path - file to read.
 * @returns the first parsed value, or undefined for an empty file.
 */
export async function readFirstDecodedJsonLine(path: string): Promise<unknown> {
  let first: unknown
  await forEachDecodedJsonLine(path, (value) => {
    first = value
    return false
  })
  return first
}

/**
 * Read the first JSONL record of a stored log without decoding later frames.
 * @param path - plain or Zstandard-compressed JSONL file.
 * @returns the first parsed value, or undefined for an empty file.
 */
export async function readFirstStoredJsonLine(path: string): Promise<unknown> {
  if (!path.endsWith('.zst') && !path.endsWith('.zstd')) return readFirstJsonLine(path)
  const buffer = await readFile(path)
  const [range] = zstdFrameRanges(buffer)
  if (range === undefined) return undefined
  const text = zstdDecompressSync(buffer.subarray(range.start, range.end)).toString('utf8')
  const line = text.split('\n').find(candidate => candidate.trim().length > 0)
  return line === undefined ? undefined : JSON.parse(line)
}

/**
 * Read one JSON file whose content must be a JSON object.
 * @param path - file to read.
 * @returns the parsed object.
 */
export async function readJsonObject(path: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  const record = recordOf(parsed)
  if (record === undefined) throw new Error(`${path}: expected a JSON object`)
  return record
}

const ZSTD_MAGIC = 0xfd2fb528

/**
 * Split a concatenated Zstandard container into complete frames.
 *
 * The Session persistence backend writes one checksummed frame per durable
 * batch; Node's one-shot decoder stops after the first frame, so the boundary
 * walk is required here. A torn final frame is ignored. The framing rules match
 * `dsh-session-persistence-jsonl`'s private scanner.
 * @param buffer - the complete container bytes.
 * @returns byte ranges of complete frames in source order.
 */
export function zstdFrameRanges(buffer: Buffer): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const start = offset
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid Zstandard frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset >= buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved Zstandard frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (offset + 3 > buffer.length) return ranges
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      if (blockType === 0x03) throw new Error(`reserved Zstandard block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockHeader >>> 3
      if (offset + payloadBytes > buffer.length) return ranges
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (offset + 4 > buffer.length) return ranges
      offset += 4
    }
    ranges.push({ start, end: offset })
  }
  return ranges
}

/**
 * Decode a plain or Zstandard-compressed text file.
 * @param path - file to read.
 * @returns decoded UTF-8 text.
 */
export async function readTextFile(path: string): Promise<string> {
  const buffer = await readFile(path)
  if (path.endsWith('.zst') || path.endsWith('.zstd')) {
    const ranges = zstdFrameRanges(buffer)
    if (ranges.length === 0) throw new Error(`${path}: no complete Zstandard frame`)
    return ranges.map(range => zstdDecompressSync(buffer.subarray(range.start, range.end)).toString('utf8')).join('')
  }
  return buffer.toString('utf8')
}

/**
 * Stat a path without throwing on absence.
 * @param path - path to inspect.
 * @returns file stats, or undefined when the path is missing.
 */
export async function statSafe(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  } catch (error: unknown) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * Whether a path is an existing directory.
 * @param path - path to inspect.
 * @returns true when the path resolves to a directory.
 */
export async function isDirectory(path: string): Promise<boolean> {
  return (await statSafe(path))?.isDirectory() === true
}

/**
 * Resolve a path through `realpath` when it exists, otherwise resolve it lexically.
 * @param path - candidate path.
 * @returns canonical absolute path.
 */
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error: unknown) {
    if (isMissing(error)) return resolve(path)
    throw error
  }
}

/** One file found under a source root. */
export interface WalkedFile {
  /** Absolute path. */
  readonly path: string
  /** File size in bytes. */
  readonly bytes: number
}

/**
 * Collect files under a root without following symbolic links.
 * @param root - directory to walk.
 * @param match - relative path and basename filter.
 * @param maxDepth - directory levels below the root; zero lists only direct children.
 * @returns matching files in directory order.
 */
export async function collectFiles(
  root: string,
  match: (relative: string, basename: string) => boolean,
  maxDepth = 8,
): Promise<WalkedFile[]> {
  const found: WalkedFile[] = []
  const visit = async (directory: string, depth: number, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (depth < maxDepth) await visit(path, depth + 1, relative)
        continue
      }
      if (!entry.isFile() || !match(relative, entry.name)) continue
      const details = await statSafe(path)
      if (details !== undefined) found.push({ path, bytes: details.size })
    }
  }
  await visit(root, 0, '')
  return found
}

/**
 * Open an existing SQLite database read-only.
 * @param path - database file.
 * @returns the handle, or undefined when the file is absent or unreadable.
 */
export async function openReadOnlyDatabase(path: string): Promise<DatabaseSync | undefined> {
  if ((await statSafe(path)) === undefined) return undefined
  const { DatabaseSync } = await import('node:sqlite')
  return new DatabaseSync(path, { readOnly: true })
}

/**
 * List user table names in a SQLite database.
 * @param source - open read-only handle.
 * @returns table names.
 */
export function userTables(source: DatabaseSync): string[] {
  const rows = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  return rows.flatMap((row) => {
    const name = stringOf(row['name'])
    return name === undefined ? [] : [name]
  })
}

/**
 * List column names of one table.
 * @param source - open read-only handle.
 * @param table - table whose columns are read.
 * @returns column names.
 */
export function tableColumns(source: DatabaseSync, table: string): string[] {
  const rows = source.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all()
  return rows.flatMap((row) => {
    const name = stringOf(row['name'])
    return name === undefined ? [] : [name]
  })
}

/**
 * Quote one SQLite identifier that came from a fixed source schema.
 * @param name - identifier text.
 * @returns double-quoted identifier.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * Pick the first existing column from a candidate list.
 * @param columns - available table columns.
 * @param candidates - preferred names in priority order.
 * @returns the selected column, or undefined when none exists.
 */
export function pickColumn(columns: readonly string[], ...candidates: readonly string[]): string | undefined {
  return candidates.find(candidate => columns.includes(candidate))
}

/**
 * Format an unknown error for a per-session failure entry.
 * @param error - caught value.
 * @returns its message, or the string form of a non-Error value.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
    || (error as NodeJS.ErrnoException).code === 'ENOTDIR'
}
