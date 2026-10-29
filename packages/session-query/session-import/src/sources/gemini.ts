/**
 * Gemini CLI reader: `~/.gemini/tmp/<project>/chats/session-*.jsonl`, with
 * legacy whole-session `.json` files.
 *
 * JSONL streams re-serialize the last message as it grows, so records are
 * deduplicated by their `id`. Assistant records use type `gemini`; control
 * records and `info`/`error` entries are skipped.
 *
 * @module @prism/prism-session-import/sources/gemini
 */

import { basename } from 'node:path'
import type { ImportedMessage, ImportedSession, ScannedSession, ScannedSource } from '../types.ts'
import {
  collectFiles,
  contentText,
  forEachJsonLine,
  messageOf,
  pushMessage,
  readJsonObject,
  recordOf,
  stringOf,
  timeOf,
} from './shared.ts'

/** Map a Gemini record type to a conversation role. */
function roleOf(value: unknown): 'user' | 'assistant' | undefined {
  if (value === 'user') return 'user'
  if (value === 'gemini' || value === 'assistant' || value === 'model') return 'assistant'
  return undefined
}

/** Read one JSONL stream. */
async function loadGeminiJsonl(
  path: string,
  key: string,
  header: { readonly cwd?: string; readonly createdAt: number; readonly updatedAt: number },
): Promise<ImportedSession> {
  const messages: ImportedMessage[] = []
  const records = new Map<string, { role: 'user' | 'assistant'; text: string; time: number }>()
  await forEachJsonLine(path, (value, index) => {
    const record = recordOf(value)
    if (record === undefined) return
    const role = roleOf(record['type'])
    if (role === undefined) return
    const id = stringOf(record['id']) ?? `record:${index}`
    records.set(id, {
      role,
      text: contentText(record['content']),
      time: timeOf(record['timestamp'], header.createdAt + index),
    })
  })
  let updatedAt = header.updatedAt
  for (const record of records.values()) {
    updatedAt = Math.max(updatedAt, record.time)
    pushMessage(messages, record.role, record.text, record.time, record.role === 'user')
  }
  return {
    key,
    source: 'gemini',
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    createdAt: header.createdAt,
    updatedAt,
    messages,
  }
}

/** Read a legacy whole-session JSON file. */
async function loadGeminiJson(
  path: string,
  key: string,
  header: { readonly cwd?: string; readonly createdAt: number; readonly updatedAt: number },
): Promise<ImportedSession> {
  const snapshot = await readJsonObject(path)
  const messages: ImportedMessage[] = []
  const list = Array.isArray(snapshot['messages']) ? snapshot['messages'] : []
  for (const item of list) {
    const record = recordOf(item)
    if (record === undefined) continue
    const role = roleOf(record['role']) ?? roleOf(record['type'])
    if (role === undefined) continue
    pushMessage(
      messages,
      role,
      contentText(record['content'] ?? record['text']),
      timeOf(record['timestamp'], header.createdAt),
      role === 'user',
    )
  }
  return {
    key,
    source: 'gemini',
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
    messages,
  }
}

/** Gemini CLI store reader. */
export const geminiReader = {
  id: 'gemini' as const,
  async scan(root: string): Promise<ScannedSource> {
    const sessions: ScannedSession[] = []
    const skipped: { key: string; reason: string }[] = []
    const files = await collectFiles(
      root,
      (relative, name) => relative.includes('/chats/') && (name.endsWith('.jsonl') || name.endsWith('.json')),
      3,
    ).catch(() => [])
    for (const file of files) {
      const fallbackKey = basename(file.path).replace(/\.(jsonl|json)$/, '')
      try {
        const first = recordOf(await readFirstRecord(file.path))
        const json = file.path.endsWith('.json') && first !== undefined
          ? first
          : undefined
        const key = stringOf(json?.['sessionId'])
          ?? stringOf(json?.['session_id'])
          ?? stringOf(first?.['sessionId'])
          ?? stringOf(first?.['session_id'])
          ?? fallbackKey
        const cwd = stringOf(json?.['cwd'])
          ?? stringOf(json?.['projectPath'])
          ?? stringOf(first?.['cwd'])
        const createdAt = timeOf(json?.['startTime'] ?? first?.['startTime'], 0)
        const updatedAt = timeOf(json?.['lastUpdated'] ?? first?.['lastUpdated'], createdAt)
        const header = {
          ...(cwd === undefined ? {} : { cwd }),
          createdAt,
          updatedAt: Math.max(createdAt, updatedAt),
        }
        sessions.push({
          meta: {
            key,
            ...(cwd === undefined ? {} : { cwd }),
            createdAt: header.createdAt,
            updatedAt: header.updatedAt,
            bytes: file.bytes,
          },
          load: () => file.path.endsWith('.json')
            ? loadGeminiJson(file.path, key, header)
            : loadGeminiJsonl(file.path, key, header),
        })
      } catch (error: unknown) {
        skipped.push({ key: fallbackKey, reason: messageOf(error) })
      }
    }
    return { sessions, skipped }
  },
}

/** Read the first record of a JSONL file or the object of a JSON file. */
async function readFirstRecord(path: string): Promise<unknown> {
  if (!path.endsWith('.jsonl')) return readJsonObject(path)
  let first: unknown
  await forEachJsonLine(path, (value) => {
    first = value
    return false
  })
  return first
}
