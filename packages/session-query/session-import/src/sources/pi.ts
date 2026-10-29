/**
 * Pi reader: `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl`.
 *
 * Records form a tree through `id`/`parentId`; the active conversation is the
 * path from the newest record back to the root, so abandoned branches are not
 * imported.
 *
 * @module @prism/prism-session-import/sources/pi
 */

import { basename } from 'node:path'
import type { ImportedMessage, ImportedSession, ScannedSession, ScannedSource } from '../types.ts'
import {
  collectFiles,
  contentText,
  messageOf,
  pushMessage,
  readAllJsonLines,
  readFirstJsonLine,
  recordOf,
  statSafe,
  stringOf,
  timeOf,
  type JsonRecord,
} from './shared.ts'

/** Follow `parentId` from the newest record to the root and return root-first. */
function activeBranch(records: readonly JsonRecord[]): JsonRecord[] {
  if (records.length === 0) return []
  const byId = new Map<string, JsonRecord>()
  for (const record of records) {
    const id = stringOf(record['id'])
    if (id !== undefined) byId.set(id, record)
  }
  const branch: JsonRecord[] = []
  let current: JsonRecord | undefined = records[records.length - 1]
  while (current !== undefined) {
    branch.push(current)
    const parentId = stringOf(current['parentId'])
    if (parentId === undefined) break
    const parent = byId.get(parentId)
    if (parent === undefined || branch.length > records.length) break
    current = parent
  }
  return branch.reverse()
}

/** Read one Pi session file. */
async function loadPi(
  path: string,
  key: string,
  headerCwd: string | undefined,
  createdAt: number,
): Promise<ImportedSession> {
  const values = await readAllJsonLines(path)
  const records = values.flatMap((value) => {
    const record = recordOf(value)
    return record === undefined ? [] : [record]
  })
  const branch = activeBranch(records)
  const messages: ImportedMessage[] = []
  let cwd = headerCwd
  let updatedAt = createdAt
  let index = 0
  for (const record of branch) {
    if (record['type'] !== 'message') continue
    const message = recordOf(record['message']) ?? record
    const role = message['role']
    if (role !== 'user' && role !== 'assistant') continue
    const time = timeOf(record['timestamp'], createdAt + index)
    index += 1
    updatedAt = Math.max(updatedAt, time)
    cwd = stringOf(message['cwd']) ?? cwd
    pushMessage(messages, role, contentText(message['content']), time, role === 'user')
  }
  return {
    key,
    source: 'pi',
    ...(cwd === undefined ? {} : { cwd }),
    createdAt,
    updatedAt,
    messages,
  }
}

/** Pi store reader. */
export const piReader = {
  id: 'pi' as const,
  async scan(root: string): Promise<ScannedSource> {
    const sessions: ScannedSession[] = []
    const skipped: { key: string; reason: string }[] = []
    const files = await collectFiles(root, (_relative, name) => name.endsWith('.jsonl'), 3)
      .catch(() => [])
    for (const file of files) {
      const key = basename(file.path, '.jsonl')
      try {
        const details = await statSafe(file.path)
        const header = recordOf(await readFirstJsonLine(file.path))
        const headerId = stringOf(header?.['id']) ?? key
        const cwd = stringOf(header?.['cwd'])
        const createdAt = timeOf(header?.['timestamp'], Math.round(details?.mtimeMs ?? 0))
        sessions.push({
          meta: {
            key: headerId,
            ...(cwd === undefined ? {} : { cwd }),
            createdAt,
            updatedAt: Math.round(details?.mtimeMs ?? createdAt),
            bytes: file.bytes,
          },
          load: () => loadPi(file.path, headerId, cwd, createdAt),
        })
      } catch (error: unknown) {
        skipped.push({ key, reason: messageOf(error) })
      }
    }
    return { sessions, skipped }
  },
}
