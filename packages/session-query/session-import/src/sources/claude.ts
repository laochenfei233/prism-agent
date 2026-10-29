/**
 * Claude Code reader: `~/.claude/projects/<project>/<session>.jsonl`.
 *
 * Each line is one record of a linked conversation; assistant responses are
 * split across lines that share `message.id`, tool results arrive as `user`
 * records, and injected reminders carry `isMeta`. Only genuine user prompts and
 * assistant text are retained.
 *
 * @module @deepseek-ai/dsh-session-import/sources/claude
 */

import { basename, join } from 'node:path'
import { readdir } from 'node:fs/promises'
import type { ImportedMessage, ImportedSession, ScannedSession, ScannedSource } from '../types.ts'
import {
  contentText,
  forEachJsonLine,
  messageOf,
  pushMessage,
  recordOf,
  statSafe,
  stringOf,
  timeOf,
} from './shared.ts'

/** Session id of one Claude transcript file. */
function keyOf(path: string): string {
  return basename(path, '.jsonl')
}

/** Read the first conversational record's cwd and timestamp without parsing the file. */
async function readClaudeMeta(
  path: string,
  key: string,
): Promise<ScannedSession | undefined> {
  const details = await statSafe(path)
  if (details === undefined) return undefined
  let cwd: string | undefined
  let createdAt: number | undefined
  let title: string | undefined
  try {
    await forEachJsonLine(path, (value, index) => {
      const record = recordOf(value)
      if (record === undefined) return index < 20
      const kind = record['type']
      if (kind === 'ai-title') {
        title = stringOf(record['aiTitle']) ?? title
      }
      if (kind !== 'user' && kind !== 'assistant') return index < 20
      cwd = stringOf(record['cwd']) ?? cwd
      createdAt = timeOf(record['timestamp'], createdAt ?? details.mtimeMs)
      return false
    })
  } catch (error: unknown) {
    throw new Error(`${path}: ${messageOf(error)}`)
  }
  if (createdAt === undefined) return undefined
  const created = createdAt
  return {
    meta: {
      key,
      ...(title === undefined ? {} : { title }),
      ...(cwd === undefined ? {} : { cwd }),
      createdAt: created,
      updatedAt: Math.round(details.mtimeMs),
      bytes: details.size,
    },
    load: () => loadClaude(path, key, cwd, created),
  }
}

/** Read one Claude transcript file into the normalized conversation. */
async function loadClaude(
  path: string,
  key: string,
  initialCwd: string | undefined,
  initialCreatedAt: number,
): Promise<ImportedSession> {
  const messages: ImportedMessage[] = []
  let cwd = initialCwd
  let title: string | undefined
  let model: string | undefined
  let createdAt = initialCreatedAt
  let updatedAt = initialCreatedAt
  await forEachJsonLine(path, (value) => {
    const record = recordOf(value)
    if (record === undefined) return
    if (record['isSidechain'] === true) return
    const kind = record['type']
    if (kind === 'ai-title') {
      title = stringOf(record['aiTitle']) ?? title
      return
    }
    if (kind !== 'user' && kind !== 'assistant') return
    if (record['isMeta'] === true || record['isApiErrorMessage'] === true) return
    const message = recordOf(record['message'])
    if (message === undefined) return
    const role = message['role']
    if (role !== 'user' && role !== 'assistant') return
    const text = contentText(message['content'])
    const time = timeOf(record['timestamp'], updatedAt)
    cwd = stringOf(record['cwd']) ?? cwd
    if (role === 'assistant') model = stringOf(message['model']) ?? model
    createdAt = Math.min(createdAt, time)
    updatedAt = Math.max(updatedAt, time)
    pushMessage(messages, role, text, time, role === 'user')
  })
  return {
    key,
    source: 'claude',
    ...(title === undefined ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    createdAt,
    updatedAt,
    ...(model === undefined ? {} : { model }),
    messages,
  }
}

/** Claude Code store reader. */
export const claudeReader = {
  id: 'claude' as const,
  async scan(root: string): Promise<ScannedSource> {
    const sessions: ScannedSession[] = []
    const skipped: { key: string; reason: string }[] = []
    let projects
    try {
      projects = await readdir(root, { withFileTypes: true })
    } catch (error: unknown) {
      throw new Error(`${root}: ${messageOf(error)}`)
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const directory = join(root, project.name)
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const path = join(directory, entry.name)
        const key = keyOf(path)
        try {
          const scanned = await readClaudeMeta(path, key)
          if (scanned !== undefined) sessions.push(scanned)
          else skipped.push({ key, reason: 'no conversational records' })
        } catch (error: unknown) {
          skipped.push({ key, reason: messageOf(error) })
        }
      }
    }
    return { sessions, skipped }
  },
}
