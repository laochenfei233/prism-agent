/**
 * Codex reader: `~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl[.zst]` plus
 * `archived_sessions/`.
 *
 * A thread is split across segment files that share a session id and continue
 * `ordinal`; the model-facing copy is the `response_item` record, while
 * `event_msg` repeats it. Only `response_item` messages of role `user` and
 * `assistant` are retained.
 *
 * @module @prism/prism-session-import/sources/codex
 */

import { basename, join } from 'node:path'
import type { ImportedMessage, ImportedSession, ScannedSession, ScannedSource } from '../types.ts'
import {
  collectFiles,
  contentText,
  forEachDecodedJsonLine,
  messageOf,
  pushMessage,
  readFirstDecodedJsonLine,
  recordOf,
  statSafe,
  stringOf,
  timeOf,
} from './shared.ts'

const ROLLOUT = /^rollout-[\dT-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/i

/** Extract the thread id from a rollout filename. */
function sessionKeyOf(path: string): string | undefined {
  return ROLLOUT.exec(basename(path))?.[1]
}

/** Files that belong to one thread, in segment order. */
interface ThreadFiles {
  readonly key: string
  readonly paths: string[]
  bytes: number
  updatedAt: number
}

/** Read the session title index once. */
async function readTitleIndex(root: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  const path = join(root, 'session_index.jsonl')
  if ((await statSafe(path)) === undefined) return titles
  try {
    await forEachDecodedJsonLine(path, (value) => {
      const record = recordOf(value)
      if (record === undefined) return
      const id = stringOf(record['id'])
      const title = stringOf(record['thread_name'])
      if (id !== undefined && title !== undefined) titles.set(id, title)
    })
  } catch {
    return titles
  }
  return titles
}

/** Collect thread files from the live and archived trees. */
async function collectThreads(root: string): Promise<Map<string, ThreadFiles>> {
  const files = await collectFiles(
    join(root, 'sessions'),
    (_relative, name) => ROLLOUT.test(name),
    6,
  ).catch(() => [])
  const archived = await collectFiles(
    join(root, 'archived_sessions'),
    (_relative, name) => ROLLOUT.test(name),
    1,
  ).catch(() => [])
  const threads = new Map<string, ThreadFiles>()
  for (const file of [...files, ...archived]) {
    const key = sessionKeyOf(file.path)
    if (key === undefined) continue
    const thread = threads.get(key) ?? { key, paths: [], bytes: 0, updatedAt: 0 }
    thread.paths.push(file.path)
    thread.bytes += file.bytes
    thread.paths.sort()
    threads.set(key, thread)
  }
  return threads
}

/** Read `session_meta` from the first segment. */
async function readThreadMeta(
  thread: ThreadFiles,
): Promise<{ cwd?: string; createdAt: number; model?: string } | undefined> {
  let cwd: string | undefined
  let createdAt: number | undefined
  let model: string | undefined
  try {
    for (const path of thread.paths) {
      const first = await readFirstDecodedJsonLine(path)
      const record = recordOf(first)
      if (record === undefined || record['type'] !== 'session_meta') continue
      const payload = recordOf(record['payload'])
      if (payload === undefined) continue
      cwd = stringOf(payload['cwd']) ?? cwd
      createdAt = timeOf(payload['timestamp'], 0) || undefined
      const base = recordOf(payload['base_instructions'])
      const provenance = recordOf(base?.['provenance'])
      model = stringOf(provenance?.['model']) ?? model
      break
    }
  } catch {
    return undefined
  }
  if (createdAt === undefined) return undefined
  return {
    ...(cwd === undefined ? {} : { cwd }),
    createdAt,
    ...(model === undefined ? {} : { model }),
  }
}

/** Build one scan entry for a thread. */
async function scanThread(
  thread: ThreadFiles,
  title: string | undefined,
): Promise<ScannedSession | undefined> {
  const meta = await readThreadMeta(thread)
  if (meta === undefined) return undefined
  for (const path of thread.paths) {
    const details = await statSafe(path)
    if (details !== undefined) thread.updatedAt = Math.max(thread.updatedAt, details.mtimeMs)
  }
  const scanned = {
    key: thread.key,
    ...(title === undefined ? {} : { title }),
    ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
    createdAt: meta.createdAt,
    updatedAt: Math.round(thread.updatedAt || meta.createdAt),
    bytes: thread.bytes,
  }
  return {
    meta: scanned,
    load: () => loadThread(thread, scanned),
  }
}

/** Read every segment of one thread into the normalized conversation. */
async function loadThread(
  thread: ThreadFiles,
  meta: { readonly key: string; readonly title?: string; readonly cwd?: string; readonly createdAt: number; readonly updatedAt: number },
): Promise<ImportedSession> {
  const messages: ImportedMessage[] = []
  const seen = new Set<string>()
  let cwd = meta.cwd
  let model: string | undefined
  let updatedAt = meta.updatedAt
  for (const path of thread.paths) {
    await forEachDecodedJsonLine(path, (value) => {
      const record = recordOf(value)
      if (record === undefined) return
      const time = timeOf(record['timestamp'], updatedAt)
      if (record['type'] === 'turn_context') {
        const payload = recordOf(record['payload'])
        cwd = stringOf(payload?.['cwd']) ?? cwd
        model = stringOf(payload?.['model']) ?? model
        return
      }
      if (record['type'] !== 'response_item') return
      const payload = recordOf(record['payload'])
      if (payload === undefined || payload['type'] !== 'message') return
      const role = payload['role']
      if (role !== 'user' && role !== 'assistant') return
      const id = stringOf(payload['id'])
      if (id !== undefined) {
        if (seen.has(id)) return
        seen.add(id)
      }
      const text = contentText(payload['content'])
      updatedAt = Math.max(updatedAt, time)
      pushMessage(messages, role, text, time, role === 'user')
    })
  }
  return {
    key: meta.key,
    source: 'codex',
    ...(meta.title === undefined ? {} : { title: meta.title }),
    ...(cwd === undefined ? {} : { cwd }),
    createdAt: meta.createdAt,
    updatedAt,
    ...(model === undefined ? {} : { model }),
    messages,
  }
}

/** Codex store reader. */
export const codexReader = {
  id: 'codex' as const,
  async scan(root: string): Promise<ScannedSource> {
    const sessions: ScannedSession[] = []
    const skipped: { key: string; reason: string }[] = []
    const titles = await readTitleIndex(root)
    const threads = await collectThreads(root)
    for (const thread of threads.values()) {
      try {
        const scanned = await scanThread(thread, titles.get(thread.key))
        if (scanned === undefined) skipped.push({ key: thread.key, reason: 'missing session metadata' })
        else sessions.push(scanned)
      } catch (error: unknown) {
        skipped.push({ key: thread.key, reason: messageOf(error) })
      }
    }
    return { sessions, skipped }
  },
}
