/**
 * Hermes reader: `~/.hermes/state.db` (`sessions` and `messages` tables) plus
 * exported `sessions/session_*.json` snapshots.
 *
 * Column names are discovered from the live schema because the store evolved
 * across builds; the reader accepts the documented `role` and `content` fields
 * and skips rows it cannot classify.
 *
 * @module @prism/prism-session-import/sources/hermes
 */

import { join } from 'node:path'
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
  readJsonObject,
  recordOf,
  statSafe,
  stringOf,
  tableColumns,
  timeOf,
  userTables,
} from './shared.ts'

/** Decode a stored message content value that may be JSON text or a block array. */
function storedText(value: unknown): string {
  return contentText(parseJsonValue(value) ?? value)
}

/** Read one SQLite-backed Hermes session. */
async function loadHermesDatabase(
  path: string,
  sessionId: string,
  meta: { readonly title?: string; readonly cwd?: string; readonly createdAt: number; readonly updatedAt: number },
): Promise<ImportedSession> {
  const db = await openReadOnlyDatabase(path)
  if (db === undefined) throw new Error(`${path}: database is unavailable`)
  try {
    const columns = tableColumns(db, 'messages')
    const roleColumn = pickColumn(columns, 'role', 'type')
    const contentColumn = pickColumn(columns, 'content', 'text', 'body')
    const timeColumn = pickColumn(columns, 'created_at', 'timestamp', 'time_created', 'created_at_ms')
    if (roleColumn === undefined || contentColumn === undefined) {
      throw new Error('messages table has no role/content column')
    }
    const order = timeColumn === undefined ? '' : ` ORDER BY ${timeColumn}`
    const messages: ImportedMessage[] = []
    let updatedAt = meta.updatedAt
    for (const row of db.prepare(
      `SELECT ${roleColumn} AS role, ${contentColumn} AS content${timeColumn === undefined ? '' : `, ${timeColumn} AS time`} FROM messages WHERE session_id = ?${order}`,
    ).all(sessionId)) {
      const role = row['role']
      if (role !== 'user' && role !== 'assistant') continue
      const time = timeOf(row['time'], updatedAt)
      updatedAt = Math.max(updatedAt, time)
      pushMessage(messages, role, storedText(row['content']), time, role === 'user')
    }
    return {
      key: sessionId,
      source: 'hermes',
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

/** Scan the SQLite-backed store. */
async function scanDatabase(database: string): Promise<ScannedSource> {
  const db: DatabaseSync | undefined = await openReadOnlyDatabase(database)
  if (db === undefined) return { sessions: [] }
  const sessions: ScannedSession[] = []
  try {
    const tables = userTables(db)
    if (!tables.includes('sessions') || !tables.includes('messages')) return { sessions }
    const sessionColumns = tableColumns(db, 'sessions')
    const idColumn = pickColumn(sessionColumns, 'id', 'session_id')
    const titleColumn = pickColumn(sessionColumns, 'title', 'name')
    const cwdColumn = pickColumn(sessionColumns, 'workspace', 'cwd', 'directory')
    const createdColumn = pickColumn(sessionColumns, 'created_at', 'time_created', 'created_at_ms')
    const updatedColumn = pickColumn(sessionColumns, 'updated_at', 'updated', 'time_updated')
    if (idColumn === undefined) return { sessions }
    const counts = new Map<string, number>()
    for (const row of db.prepare('SELECT session_id, COUNT(*) AS count FROM messages GROUP BY session_id').all()) {
      const id = stringOf(row['session_id'])
      const count = numberOf(row['count'])
      if (id !== undefined && count !== undefined) counts.set(id, count)
    }
    const fallbackTime = Math.round((await statSafe(database))?.mtimeMs ?? 0)
    for (const row of db.prepare('SELECT * FROM sessions').all()) {
      const key = stringOf(row[idColumn])
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
      sessions.push({ meta, load: () => loadHermesDatabase(database, key, meta) })
    }
  } finally {
    db.close()
  }
  return { sessions }
}

/** Scan exported JSON snapshots. */
async function scanSnapshots(root: string): Promise<ScannedSource> {
  const sessions: ScannedSession[] = []
  const skipped: { key: string; reason: string }[] = []
  const files = await collectFiles(
    join(root, 'sessions'),
    (_relative, name) => name.endsWith('.json'),
    1,
  ).catch(() => [])
  for (const file of files) {
    try {
      const snapshot = await readJsonObject(file.path)
      const key = stringOf(snapshot['session_id'])
      if (key === undefined) {
        skipped.push({ key: file.path, reason: 'missing session_id' })
        continue
      }
      const list = Array.isArray(snapshot['messages']) ? snapshot['messages'] : []
      const messages: ImportedMessage[] = []
      let createdAt = timeOf(snapshot['created_at'], file.bytes)
      let updatedAt = timeOf(snapshot['updated_at'], createdAt)
      for (const item of list) {
        const message = recordOf(item)
        if (message === undefined) continue
        const role = message['role']
        if (role !== 'user' && role !== 'assistant') continue
        const time = timeOf(message['timestamp'] ?? message['created_at'], createdAt)
        createdAt = Math.min(createdAt, time)
        updatedAt = Math.max(updatedAt, time)
        pushMessage(messages, role, storedText(message['content']), time, role === 'user')
      }
      const title = stringOf(snapshot['title'])
      const cwd = stringOf(snapshot['workspace']) ?? stringOf(snapshot['cwd'])
      const meta = {
        key,
        ...(title === undefined ? {} : { title }),
        ...(cwd === undefined ? {} : { cwd }),
        createdAt,
        updatedAt,
        bytes: file.bytes,
      }
      sessions.push({
        meta,
        load: () => Promise.resolve({
          key,
          source: 'hermes',
          ...(title === undefined ? {} : { title }),
          ...(cwd === undefined ? {} : { cwd }),
          createdAt,
          updatedAt,
          messages,
        }),
      })
    } catch (error: unknown) {
      skipped.push({ key: file.path, reason: messageOf(error) })
    }
  }
  return { sessions, skipped }
}

/** Hermes store reader. */
export const hermesReader = {
  id: 'hermes' as const,
  async scan(root: string): Promise<ScannedSource> {
    const database = join(root, 'state.db')
    const scanned: ScannedSource[] = []
    if ((await statSafe(database)) !== undefined) scanned.push(await scanDatabase(database))
    scanned.push(await scanSnapshots(root))
    return {
      sessions: scanned.flatMap(source => source.sessions),
      skipped: scanned.flatMap(source => source.skipped ?? []),
    }
  },
}
