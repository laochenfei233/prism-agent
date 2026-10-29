/**
 * OpenCode reader. Current builds keep the shared `session`/`message`/`part`
 * SQLite schema; older builds wrote one JSON file per record under
 * `storage/session`, `storage/message`, and `storage/part`.
 *
 * @module @deepseek-ai/dsh-session-import/sources/opencode
 */

import { basename, join } from 'node:path'
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import type { ImportedMessage, ImportedSession, ScannedSession, ScannedSource } from '../types.ts'
import { scanChatDatabase } from './mimo.ts'
import {
  collectFiles,
  contentText,
  messageOf,
  pushMessage,
  readJsonObject,
  recordOf,
  statSafe,
  stringOf,
  timeOf,
} from './shared.ts'

interface LegacySession {
  readonly key: string
  readonly directory: string
  readonly title?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** Read legacy storage session records. */
async function scanLegacy(root: string): Promise<ScannedSource> {
  const sessions: ScannedSession[] = []
  const skipped: { key: string; reason: string }[] = []
  const files = await collectFiles(
    join(root, 'storage', 'session'),
    (_relative, name) => name.endsWith('.json'),
    3,
  ).catch(() => [])
  for (const file of files) {
    try {
      const record = await readJsonObject(file.path)
      const key = stringOf(record['id']) ?? basename(file.path, '.json')
      const directory = stringOf(record['directory'])
        ?? stringOf(recordOf(record['path'])?.['cwd'])
        ?? stringOf(recordOf(record['path'])?.['root'])
      if (directory === undefined) {
        skipped.push({ key, reason: 'missing directory' })
        continue
      }
      const time = recordOf(record['time'])
      const title = stringOf(record['title'])
      const meta: LegacySession = {
        key,
        directory,
        ...(title === undefined ? {} : { title }),
        createdAt: timeOf(time?.['created'] ?? record['time_created'], file.bytes),
        updatedAt: timeOf(time?.['updated'] ?? record['time_updated'], file.bytes),
      }
      sessions.push({
        meta: {
          key,
          ...(meta.title === undefined ? {} : { title: meta.title }),
          cwd: meta.directory,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          bytes: file.bytes,
        },
        load: () => loadLegacySession(root, meta),
      })
    } catch (error: unknown) {
      skipped.push({ key: basename(file.path, '.json'), reason: messageOf(error) })
    }
  }
  return { sessions, skipped }
}

/** Read one legacy session's messages and parts. */
async function loadLegacySession(root: string, session: LegacySession): Promise<ImportedSession> {
  const messages: ImportedMessage[] = []
  const messageDirectory = join(root, 'storage', 'message', session.key)
  let entries: Dirent[]
  try {
    entries = await readdir(messageDirectory, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const record = await readJsonObject(join(messageDirectory, entry.name))
    const role = record['role']
    if (role !== 'user' && role !== 'assistant') continue
    const time = recordOf(record['time'])
    const partDirectory = join(root, 'storage', 'part', stringOf(record['id']) ?? basename(entry.name, '.json'))
    const partFiles = await collectFiles(partDirectory, (_relative, name) => name.endsWith('.json'), 1)
      .catch(() => [])
    const texts: string[] = []
    for (const partFile of partFiles) {
      const part = await readJsonObject(partFile.path)
      if (part['type'] !== 'text' || part['synthetic'] === true) continue
      texts.push(contentText(part['text']))
    }
    pushMessage(
      messages,
      role,
      texts.join('\n'),
      timeOf(time?.['created'] ?? record['time_created'], session.updatedAt),
      role === 'user',
    )
  }
  return {
    key: session.key,
    source: 'opencode',
    ...(session.title === undefined ? {} : { title: session.title }),
    cwd: session.directory,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages,
  }
}

/** OpenCode store reader. */
export const opencodeReader = {
  id: 'opencode' as const,
  async scan(root: string): Promise<ScannedSource> {
    const database = join(root, 'opencode.db')
    if ((await statSafe(database)) !== undefined) return scanChatDatabase(database, 'opencode')
    return scanLegacy(root)
  },
}
