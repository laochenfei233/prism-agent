/**
 * DeepSeek Harness reader: `~/.dsh/sessions/<projectKey>/<sessionDir>/`.
 *
 * The highest committed generation is authoritative. Subagent sessions are
 * skipped because they are internal delegation, not conversations the user
 * opened. Logs may be plain JSONL or a concatenated Zstandard container.
 *
 * @module @prism/prism-session-import/sources/dsh
 */

import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import type {
  ImportedMessage,
  ImportedSession,
  NativeSessionLog,
  ScannedSession,
  ScannedSource,
} from '../types.ts'
import {
  contentText,
  forEachDecodedJsonLine,
  messageOf,
  numberOf,
  pushMessage,
  readFirstStoredJsonLine,
  recordOf,
  statSafe,
  stringOf,
  timeOf,
} from './shared.ts'

const LOG = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd|\.zst)?$/

/** Generation rank of a log filename; the header-only `session.jsonl` is v0. */
function generationOf(name: string): number | undefined {
  const match = LOG.exec(name)
  return match === null ? undefined : Number(match[1] ?? 0)
}

/** Choose the highest committed generation in a session directory. */
async function chooseLog(directory: string): Promise<{ path: string; generation: number } | undefined> {
  const entries = await readdir(directory, { withFileTypes: true })
  let best: { path: string; generation: number } | undefined
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const generation = generationOf(entry.name)
    if (generation === undefined) continue
    if (best === undefined || generation > best.generation) {
      best = { path: join(directory, entry.name), generation }
    }
  }
  return best
}

/** Session header fields needed by the scan. */
interface DshHeader {
  readonly id: string
  readonly version: number
  readonly cwd?: string
  readonly createdAt: number
  readonly topLevel: boolean
}

/** Parse and validate the first line of a session log. */
async function readHeader(path: string): Promise<DshHeader | undefined> {
  const first = recordOf(await readFirstStoredJsonLine(path))
  if (first === undefined || first['type'] !== 'session') return undefined
  const id = stringOf(first['id'])
  if (id === undefined) return undefined
  const depth = typeof first['delegationDepth'] === 'number' ? first['delegationDepth'] : 0
  const topLevel = first['origin'] !== 'subagent' && first['parentSession'] === undefined && depth <= 0
  const cwd = stringOf(first['cwd'])
  return {
    id,
    version: numberOf(first['version']) ?? 0,
    ...(cwd === undefined ? {} : { cwd }),
    createdAt: timeOf(first['createdAt'], 0),
    topLevel,
  }
}

/** Scan one project directory's session directories. */
async function scanProject(
  directory: string,
): Promise<{ sessions: ScannedSession[]; skipped: { key: string; reason: string }[] }> {
  const sessions: ScannedSession[] = []
  const skipped: { key: string; reason: string }[] = []
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return { sessions, skipped }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sessionDirectory = join(directory, entry.name)
    try {
      const log = await chooseLog(sessionDirectory)
      if (log === undefined) continue
      const header = await readHeader(log.path)
      if (header === undefined) {
        skipped.push({ key: entry.name, reason: 'unreadable session header' })
        continue
      }
      if (!header.topLevel) {
        skipped.push({ key: header.id, reason: 'subagent session' })
        continue
      }
      const details = await statSafe(log.path)
      sessions.push({
        meta: {
          key: header.id,
          ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
          createdAt: header.createdAt,
          updatedAt: Math.round(details?.mtimeMs ?? header.createdAt),
          ...(details === undefined ? {} : { bytes: details.size }),
        },
        load: () => loadDsh(log.path, header),
        loadNative: () => loadNativeDsh(log.path, header),
      })
    } catch (error: unknown) {
      skipped.push({ key: entry.name, reason: messageOf(error) })
    }
  }
  return { sessions, skipped }
}

/** Read the complete original log for a native copy. */
async function loadNativeDsh(path: string, header: DshHeader): Promise<NativeSessionLog> {
  if (header.version !== SESSION_FORMAT_VERSION) {
    throw new Error(`session format version ${header.version} is not supported for native import`)
  }
  const events: SessionEvent[] = []
  let first = true
  await forEachDecodedJsonLine(path, (value) => {
    const record = recordOf(value)
    if (record === undefined) throw new Error('malformed session record')
    if (first) {
      first = false
      if (record['type'] === 'session') return
    }
    if (stringOf(record['type']) === undefined
      || numberOf(record['seq']) === undefined
      || numberOf(record['time']) === undefined
      || record['data'] === undefined) {
      throw new Error('malformed session event envelope')
    }
    events.push(value as SessionEvent)
  })
  if (events.length === 0) throw new Error('session log has no events')
  const nativeHeader: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: brandString<SessionId>(header.id),
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    isSeeded: false,
    delegationDepth: 0,
  }
  return { header: nativeHeader, events }
}

/** Read one DSH session log. */
async function loadDsh(path: string, header: DshHeader): Promise<ImportedSession> {
  const messages: ImportedMessage[] = []
  let cwd = header.cwd
  let title: string | undefined
  let model: string | undefined
  let updatedAt = header.createdAt
  let index = 0
  await forEachDecodedJsonLine(path, (value) => {
    const event = recordOf(value)
    if (event === undefined) return
    const kind = event['type']
    const time = timeOf(event['time'], header.createdAt + index)
    index += 1
    if (kind === 'session') {
      cwd = stringOf(event['cwd']) ?? cwd
      return
    }
    if (kind === 'session/title') {
      const data = recordOf(event['data'])
      title = stringOf(data?.['title']) ?? title
      return
    }
    if (kind === 'user/message') {
      const data = recordOf(event['data'])
      const source = recordOf(data?.['source'])
      if (source?.['kind'] !== 'user') return
      updatedAt = Math.max(updatedAt, time)
      pushMessage(messages, 'user', contentText(data?.['content']), time, true)
      return
    }
    if (kind !== 'assistant/message') return
    const data = recordOf(event['data'])
    const message = recordOf(data?.['message'])
    if (message === undefined) return
    const source = recordOf(message['source'])
    model = stringOf(source?.['model']) ?? model
    updatedAt = Math.max(updatedAt, time)
    pushMessage(messages, 'assistant', contentText(message['content']), time)
  })
  return {
    key: header.id,
    source: 'dsh',
    ...(title === undefined ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    createdAt: header.createdAt,
    updatedAt,
    ...(model === undefined ? {} : { model }),
    messages,
  }
}

/** DeepSeek Harness store reader. */
export const dshReader = {
  id: 'dsh' as const,
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
      const scanned = await scanProject(join(root, project.name))
      sessions.push(...scanned.sessions)
      skipped.push(...scanned.skipped)
    }
    return { sessions, skipped }
  },
}
