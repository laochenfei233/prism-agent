/**
 * Grok reader: `~/.grok/sessions/<encoded-cwd>/<session>/`.
 *
 * `chat_history.jsonl` is the model transcript; `summary.json` carries the
 * session id, cwd, and timestamps. Harness-injected user turns are marked with
 * `synthetic_reason` and skipped.
 *
 * @module @deepseek-ai/dsh-session-import/sources/grok
 */

import { basename, dirname, join } from 'node:path'
import { readdir } from 'node:fs/promises'
import type { ImportedMessage, ImportedSession, ScannedSession, ScannedSource } from '../types.ts'
import {
  contentText,
  forEachJsonLine,
  messageOf,
  pushMessage,
  readJsonObject,
  recordOf,
  statSafe,
  stringOf,
  timeOf,
} from './shared.ts'

/** Remove the `<user_query>` wrapper Grok adds around real prompts. */
function unwrapQuery(text: string): string {
  const start = text.indexOf('<user_query>')
  const end = text.lastIndexOf('</user_query>')
  if (start < 0 || end < start) return text
  return text.slice(start + '<user_query>'.length, end)
}

/** Metadata read from a Grok summary, or synthesized when it is missing. */
interface GrokMeta {
  readonly key: string
  readonly cwd?: string
  readonly title?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly model?: string
}

/** Read the summary metadata for one session directory. */
async function readSummary(directory: string): Promise<GrokMeta | undefined> {
  const path = join(directory, 'summary.json')
  const details = await statSafe(path)
  if (details === undefined) return undefined
  let summary
  try {
    summary = await readJsonObject(path)
  } catch {
    return undefined
  }
  const info = recordOf(summary['info'])
  const key = stringOf(info?.['id']) ?? basename(directory)
  const cwd = stringOf(info?.['cwd'])
  const createdAt = timeOf(summary['created_at'], Math.round(details.mtimeMs))
  const updatedAt = timeOf(summary['updated_at'], createdAt)
  const title = stringOf(summary['session_summary'])
  const model = stringOf(summary['current_model_id'])
  return {
    key,
    ...(cwd === undefined ? {} : { cwd }),
    ...(title === undefined ? {} : { title }),
    createdAt,
    updatedAt,
    ...(model === undefined ? {} : { model }),
  }
}

/** Build one scan entry for a Grok session directory. */
async function scanSession(directory: string): Promise<ScannedSession | undefined> {
  const history = join(directory, 'chat_history.jsonl')
  const details = await statSafe(history)
  if (details === undefined) return undefined
  const summary = await readSummary(directory)
  const meta = summary ?? {
    key: basename(directory),
    cwd: decodeURIComponent(basename(dirname(directory))),
    createdAt: Math.round(details.mtimeMs),
    updatedAt: Math.round(details.mtimeMs),
  }
  return {
    meta: {
      key: meta.key,
      ...(meta.title === undefined ? {} : { title: meta.title }),
      ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      bytes: details.size,
    },
    load: () => loadGrok(history, meta),
  }
}

/** Read one Grok transcript. */
async function loadGrok(
  path: string,
  meta: GrokMeta,
): Promise<ImportedSession> {
  const messages: ImportedMessage[] = []
  let model = meta.model
  let index = 0
  await forEachJsonLine(path, (value) => {
    const record = recordOf(value)
    if (record === undefined) return
    const kind = record['type']
    const time = meta.createdAt + index
    index += 1
    if (kind === 'user') {
      if (record['synthetic_reason'] !== undefined) return
      pushMessage(messages, 'user', unwrapQuery(contentText(record['content'])), time, true)
      return
    }
    if (kind !== 'assistant') return
    model = stringOf(record['model_id']) ?? model
    pushMessage(messages, 'assistant', contentText(record['content']), time)
  })
  return {
    key: meta.key,
    source: 'grok',
    ...(meta.title === undefined ? {} : { title: meta.title }),
    ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(model === undefined ? {} : { model }),
    messages,
  }
}

/** Grok store reader. */
export const grokReader = {
  id: 'grok' as const,
  async scan(root: string): Promise<ScannedSource> {
    const sessions: ScannedSession[] = []
    const skipped: { key: string; reason: string }[] = []
    let buckets
    try {
      buckets = await readdir(root, { withFileTypes: true })
    } catch (error: unknown) {
      throw new Error(`${root}: ${messageOf(error)}`)
    }
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue
      let entries
      try {
        entries = await readdir(join(root, bucket.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const directory = join(root, bucket.name, entry.name)
        try {
          const scanned = await scanSession(directory)
          if (scanned === undefined) skipped.push({ key: entry.name, reason: 'missing chat_history.jsonl' })
          else sessions.push(scanned)
        } catch (error: unknown) {
          skipped.push({ key: entry.name, reason: messageOf(error) })
        }
      }
    }
    return { sessions, skipped }
  },
}
