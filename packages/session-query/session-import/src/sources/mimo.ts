/**
 * SQLite reader for the `session` / `message` / `part` schema shared by MiMo
 * Code and current OpenCode builds.
 *
 * Messages store their role in `message.data`; visible content lives in
 * `part.data` rows of type `text`. Tool, reasoning, and synthetic parts are
 * skipped.
 *
 * @module @prism/prism-session-import/sources/chat-db
 */

import { join } from 'node:path'
import type { ImportSourceId, ImportedMessage, ImportedSession, ScannedSession, ScannedSource } from '../types.ts'
import {
  messageOf,
  numberOf,
  openReadOnlyDatabase,
  parseJsonValue,
  pushMessage,
  recordOf,
  statSafe,
  stringOf,
  timeOf,
  userTables,
} from './shared.ts'

interface ChatMessageRow {
  readonly id: string
  readonly time: number
  readonly role: 'user' | 'assistant'
}

/** Read text parts of one message in order. */
function messageText(parts: readonly unknown[]): string {
  const texts: string[] = []
  for (const part of parts) {
    const record = recordOf(part)
    if (record === undefined || record['type'] !== 'text' || record['synthetic'] === true) continue
    const text = stringOf(record['text'])
    if (text !== undefined) texts.push(text)
  }
  return texts.join('\n')
}

/**
 * Read one chat database into the normalized transcript.
 * @param dbPath - database file.
 * @param source - owning store id.
 * @param key - session id.
 * @param meta - scan metadata used for fallbacks.
 * @returns the normalized conversation.
 */
async function loadChatSession(
  dbPath: string,
  source: ImportSourceId,
  key: string,
  meta: { readonly title?: string; readonly cwd?: string; readonly createdAt: number; readonly updatedAt: number },
): Promise<ImportedSession> {
  const db = await openReadOnlyDatabase(dbPath)
  if (db === undefined) throw new Error(`${dbPath}: database is unavailable`)
  try {
    const messageRows = db.prepare(
      'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id',
    ).all(key)
    const partRows = db.prepare(
      'SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id',
    ).all(key)
    const partsByMessage = new Map<string, unknown[]>()
    for (const row of partRows) {
      const messageId = stringOf(row['message_id'])
      if (messageId === undefined) continue
      let bucket = partsByMessage.get(messageId)
      if (bucket === undefined) {
        bucket = []
        partsByMessage.set(messageId, bucket)
      }
      bucket.push(parseJsonValue(row['data']))
    }
    const rows: ChatMessageRow[] = []
    for (const row of messageRows) {
      const id = stringOf(row['id'])
      if (id === undefined) continue
      const data = recordOf(parseJsonValue(row['data']))
      const role = data?.['role']
      if (role !== 'user' && role !== 'assistant') continue
      rows.push({ id, role, time: timeOf(row['time_created'], meta.updatedAt) })
    }
    const messages: ImportedMessage[] = []
    for (const row of rows) {
      const text = messageText(partsByMessage.get(row.id) ?? [])
      pushMessage(messages, row.role, text, row.time, row.role === 'user')
    }
    return {
      key,
      source,
      ...(meta.title === undefined ? {} : { title: meta.title }),
      ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      messages,
    }
  } finally {
    db.close()
  }
}

/**
 * Scan the shared chat schema.
 * @param dbPath - SQLite file.
 * @param source - owning store id.
 * @returns scanned sessions; an absent or foreign schema yields an empty scan.
 */
export async function scanChatDatabase(dbPath: string, source: ImportSourceId): Promise<ScannedSource> {
  const details = await statSafe(dbPath)
  if (details === undefined) return { sessions: [] }
  const db = await openReadOnlyDatabase(dbPath)
  if (db === undefined) return { sessions: [] }
  const sessions: ScannedSession[] = []
  try {
    if (!userTables(db).includes('session')) return { sessions }
    const counts = new Map<string, number>()
    if (userTables(db).includes('message')) {
      for (const row of db.prepare('SELECT session_id, COUNT(*) AS count FROM message GROUP BY session_id').all()) {
        const id = stringOf(row['session_id'])
        const count = numberOf(row['count'])
        if (id !== undefined && count !== undefined) counts.set(id, count)
      }
    }
    for (const row of db.prepare('SELECT * FROM session').all()) {
      const key = stringOf(row['id'])
      if (key === undefined) continue
      if (row['parent_id'] !== null && row['parent_id'] !== undefined) continue
      if (numberOf(row['time_archived']) !== undefined) continue
      const cwd = stringOf(row['directory'])
      const title = stringOf(row['title'])
      const createdAt = timeOf(row['time_created'], details.mtimeMs)
      const updatedAt = timeOf(row['time_updated'], createdAt)
      const count = counts.get(key)
      const meta = {
        key,
        ...(title === undefined ? {} : { title }),
        ...(cwd === undefined ? {} : { cwd }),
        createdAt,
        updatedAt,
        ...(count === undefined ? {} : { messageCount: count }),
      }
      sessions.push({ meta, load: () => loadChatSession(dbPath, source, key, meta) })
    }
  } catch (error: unknown) {
    throw new Error(`${dbPath}: ${messageOf(error)}`)
  } finally {
    db.close()
  }
  return { sessions }
}

/** MiMo Code store reader. */
export const mimocodeReader = {
  id: 'mimocode' as const,
  scan: (root: string) => scanChatDatabase(join(root, 'mimocode.db'), 'mimocode'),
}
