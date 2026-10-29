/**
 * OpenClaw reader: one SQLite database per agent under
 * `~/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite`.
 *
 * Current builds store the transcript as an append-only `transcript_events`
 * table; the event payload is plain JSON or a Zstandard blob. The payload
 * schema is not part of a published format, so extraction accepts the common
 * `message` wrappers and reports a session whose events carry no recognizable
 * messages as empty.
 *
 * @module @prism/prism-session-import/sources/openclaw
 */

import { zstdDecompressSync } from 'node:zlib'
import type { DatabaseSync } from 'node:sqlite'
import type { ImportedMessage, ImportedSession, ScannedSession, ScannedSource } from '../types.ts'
import {
  collectFiles,
  contentText,
  messageOf,
  numberOf,
  openReadOnlyDatabase,
  parseJsonValue,
  pickColumn,
  pushMessage,
  recordOf,
  statSafe,
  stringOf,
  tableColumns,
  timeOf,
  userTables,
  zstdFrameRanges,
  type JsonRecord,
} from './shared.ts'

interface OpenClawDatabase {
  readonly path: string
  readonly sessions: ScannedSession[]
}

/** Decode one event payload from its JSON text or Zstandard blob. */
function eventRecord(row: Readonly<Record<string, unknown>>): JsonRecord | undefined {
  const json = parseJsonValue(row['event_json'])
  if (json !== undefined) return recordOf(json)
  const blob = row['event_zstd']
  if (blob instanceof Uint8Array) {
    const buffer = Buffer.from(blob)
    const ranges = zstdFrameRanges(buffer)
    if (ranges.length === 0) return undefined
    const text = ranges
      .map(range => zstdDecompressSync(buffer.subarray(range.start, range.end)).toString('utf8'))
      .join('')
    return recordOf(parseJsonValue(text))
  }
  return undefined
}

/** Find a message shape inside one OpenClaw event. */
function messageOfEvent(event: JsonRecord): { role: 'user' | 'assistant'; text: string } | undefined {
  const data = recordOf(event['data'])
  const message = recordOf(event['message']) ?? recordOf(data?.['message'])
  const candidates = [message, data, event]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const role = candidate['role']
    if (role !== 'user' && role !== 'assistant') continue
    const text = contentText(candidate['content'] ?? candidate['text'])
    if (text.trim().length > 0) return { role, text }
  }
  return undefined
}

/** Load one OpenClaw session from its database. */
async function loadOpenClaw(
  path: string,
  sessionId: string,
  meta: { readonly title?: string; readonly cwd?: string; readonly createdAt: number; readonly updatedAt: number },
): Promise<ImportedSession> {
  const db = await openReadOnlyDatabase(path)
  if (db === undefined) throw new Error(`${path}: database is unavailable`)
  try {
    const messages: ImportedMessage[] = []
    let updatedAt = meta.updatedAt
    let index = 0
    for (const row of db.prepare(
      'SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq',
    ).all(sessionId)) {
      const event = eventRecord(row)
      const time = timeOf(event?.['timestamp'] ?? event?.['created_at'], meta.createdAt + index)
      index += 1
      updatedAt = Math.max(updatedAt, time)
      if (event === undefined) continue
      const message = messageOfEvent(event)
      if (message === undefined) continue
      pushMessage(messages, message.role, message.text, time, message.role === 'user')
    }
    return {
      key: sessionId,
      source: 'openclaw',
      ...(meta.title === undefined ? {} : { title: meta.title }),
      ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
      createdAt: meta.createdAt,
      updatedAt,
      messages,
    }
  } finally {
    db.close()
  }
}

/** Scan one agent database. */
async function scanDatabase(path: string): Promise<OpenClawDatabase> {
  const db: DatabaseSync | undefined = await openReadOnlyDatabase(path)
  if (db === undefined) return { path, sessions: [] }
  const fallbackTime = Math.round((await statSafe(path))?.mtimeMs ?? 0)
  const sessions: ScannedSession[] = []
  try {
    const tables = userTables(db)
    if (!tables.includes('transcript_events')) return { path, sessions }
    const counts = new Map<string, number>()
    for (const row of db.prepare(
      'SELECT session_id, COUNT(*) AS count FROM transcript_events GROUP BY session_id',
    ).all()) {
      const id = stringOf(row['session_id'])
      const count = numberOf(row['count'])
      if (id !== undefined && count !== undefined) counts.set(id, count)
    }
    const windows = tables.includes('session_windows')
      ? db.prepare('SELECT * FROM session_windows').all()
      : []
    const columns = windows.length > 0 ? tableColumns(db, 'session_windows') : []
    const idColumn = pickColumn(columns, 'session_id', 'session_key', 'id')
    const titleColumn = pickColumn(columns, 'title', 'name')
    const cwdColumn = pickColumn(columns, 'cwd', 'workspace', 'workspace_dir')
    const createdColumn = pickColumn(columns, 'created_at', 'created_at_ms')
    const updatedColumn = pickColumn(columns, 'updated_at', 'last_active_at')
    const rows: readonly Readonly<Record<string, unknown>>[] = windows.length > 0 && idColumn !== undefined
      ? windows
      : [...counts.keys()].map(id => ({ session_id: id }))
    for (const row of rows) {
      const key = idColumn === undefined
        ? stringOf(row['session_id'])
        : stringOf(row[idColumn])
      if (key === undefined) continue
      const title = titleColumn === undefined ? undefined : stringOf(row[titleColumn])
      const cwd = cwdColumn === undefined ? undefined : stringOf(row[cwdColumn])
      const createdAt = createdColumn === undefined ? fallbackTime : timeOf(row[createdColumn], fallbackTime)
      const updatedAt = updatedColumn === undefined ? createdAt : timeOf(row[updatedColumn], createdAt)
      const count = counts.get(key)
      const meta = {
        key,
        ...(title === undefined ? {} : { title }),
        ...(cwd === undefined ? {} : { cwd }),
        createdAt,
        updatedAt,
        ...(count === undefined ? {} : { messageCount: count }),
      }
      sessions.push({ meta, load: () => loadOpenClaw(path, key, meta) })
    }
  } finally {
    db.close()
  }
  return { path, sessions }
}

/** OpenClaw store reader. */
export const openclawReader = {
  id: 'openclaw' as const,
  async scan(root: string): Promise<ScannedSource> {
    const sessions: ScannedSession[] = []
    const skipped: { key: string; reason: string }[] = []
    const files = await collectFiles(
      root,
      (_relative, name) => name === 'openclaw-agent.sqlite',
      3,
    ).catch(() => [])
    for (const file of files) {
      try {
        const scanned = await scanDatabase(file.path)
        sessions.push(...scanned.sessions)
      } catch (error: unknown) {
        skipped.push({ key: file.path, reason: messageOf(error) })
      }
    }
    return { sessions, skipped }
  },
}
