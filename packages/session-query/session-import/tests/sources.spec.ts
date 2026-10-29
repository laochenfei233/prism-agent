import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeReader } from '../src/sources/claude.ts'
import { codexReader } from '../src/sources/codex.ts'
import { dshReader } from '../src/sources/dsh.ts'
import { geminiReader } from '../src/sources/gemini.ts'
import { grokReader } from '../src/sources/grok.ts'
import { hermesReader } from '../src/sources/hermes.ts'
import { mimocodeReader } from '../src/sources/mimo.ts'
import { openclawReader } from '../src/sources/openclaw.ts'
import { opencodeReader } from '../src/sources/opencode.ts'
import { piReader } from '../src/sources/pi.ts'

const roots: string[] = []

async function rootOf(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-import-${name}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

describe('Claude Code reader', () => {
  it('keeps human prompts and assistant text while dropping tool records and sidechains', async () => {
    const root = await rootOf('claude')
    const cwd = join(root, 'work')
    await mkdir(cwd)
    const file = join(root, 'projects', 'encoded', 'session-a.jsonl')
    await write(file, [
      JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }),
      JSON.stringify({
        type: 'user', sessionId: 'session-a', cwd, timestamp: '2026-01-01T00:00:00.000Z', isSidechain: false,
        message: { role: 'user', content: 'build it' },
      }),
      JSON.stringify({
        type: 'assistant', sessionId: 'session-a', cwd, timestamp: '2026-01-01T00:00:01.000Z', isSidechain: false,
        message: { id: 'a1', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'working' }] },
      }),
      JSON.stringify({
        type: 'user', sessionId: 'session-a', cwd, timestamp: '2026-01-01T00:00:02.000Z', isSidechain: false,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      }),
      JSON.stringify({
        type: 'user', sessionId: 'session-a', cwd, timestamp: '2026-01-01T00:00:03.000Z', isSidechain: true,
        message: { role: 'user', content: 'internal' },
      }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Build the thing' }),
    ].join('\n'))

    const scan = await claudeReader.scan(join(root, 'projects'))
    expect(scan.sessions).toHaveLength(1)
    expect(scan.sessions[0]?.meta).toMatchObject({ key: 'session-a', cwd, createdAt: Date.parse('2026-01-01T00:00:00.000Z') })
    const loaded = await scan.sessions[0]?.load()
    expect(loaded?.title).toBe('Build the thing')
    expect(loaded?.messages.map(message => [message.role, message.text])).toEqual([
      ['user', 'build it'],
      ['assistant', 'working'],
    ])
  })
})

describe('Codex reader', () => {
  it('groups rollout segments by session id and reads response items', async () => {
    const root = await rootOf('codex')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const id = '01a0ec97-2535-7b81-a103-2ab1f352408d'
    const file = join(root, 'sessions', '2026', '01', '02', `rollout-2026-01-02T03-04-05-${id}.jsonl`)
    await write(file, [
      JSON.stringify({
        timestamp: '2026-01-02T03:04:05.000Z', type: 'session_meta',
        payload: { session_id: id, cwd, timestamp: '2026-01-02T03:04:05.000Z' },
      }),
      JSON.stringify({
        timestamp: '2026-01-02T03:04:06.000Z', type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'UserMessage', text: 'duplicate' } },
      }),
      JSON.stringify({
        timestamp: '2026-01-02T03:04:06.000Z', type: 'response_item',
        payload: { type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      }),
      JSON.stringify({
        timestamp: '2026-01-02T03:04:07.000Z', type: 'response_item',
        payload: { type: 'message', id: 'a1', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
      }),
    ].join('\n'))

    const scan = await codexReader.scan(root)
    expect(scan.sessions).toHaveLength(1)
    expect(scan.sessions[0]?.meta).toMatchObject({ key: id, cwd })
    const loaded = await scan.sessions[0]?.load()
    expect(loaded?.messages.map(message => message.text)).toEqual(['hello', 'hi'])
  })
})

describe('Grok reader', () => {
  it('reads summary metadata and unwraps user queries', async () => {
    const root = await rootOf('grok')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const directory = join(root, 'sessions', 'bucket', 'grok-1')
    await write(join(directory, 'summary.json'), JSON.stringify({
      info: { id: 'grok-1', cwd },
      session_summary: 'A grok chat',
      created_at: '2026-02-01T00:00:00.000Z',
      updated_at: '2026-02-01T00:10:00.000Z',
      current_model_id: 'grok-4',
    }))
    await write(join(directory, 'chat_history.jsonl'), [
      JSON.stringify({ type: 'user', content: [{ type: 'text', text: '<user_query>\nfix it\n</user_query>' }], prompt_index: 1 }),
      JSON.stringify({ type: 'assistant', content: 'fixed', tool_calls: [], model_id: 'grok-4' }),
      JSON.stringify({ type: 'tool_result', tool_call_id: 't', content: 'ok' }),
    ].join('\n'))

    const scan = await grokReader.scan(join(root, 'sessions'))
    expect(scan.sessions[0]?.meta).toMatchObject({ key: 'grok-1', cwd, title: 'A grok chat' })
    const loaded = await scan.sessions[0]?.load()
    expect(loaded?.model).toBe('grok-4')
    expect(loaded?.messages.map(message => message.text)).toEqual(['fix it', 'fixed'])
  })
})

describe('DeepSeek Harness reader', () => {
  it('reads the highest generation from a concatenated Zstandard log and skips subagents', async () => {
    const root = await rootOf('dsh')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const id = 'session-import-dsh'
    const header = JSON.stringify({ type: 'session', version: 4, id, createdAt: 1000, cwd, isSeeded: false, delegationDepth: 0 })
    const user = JSON.stringify({
      type: 'user/message', seq: 0, time: 1100,
      data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } },
      surfaceOp: 'append',
    })
    const assistant = JSON.stringify({
      type: 'assistant/message', seq: 1, time: 1200,
      data: {
        turn: 1, step: 1, stream: [],
        message: {
          id: 'a', role: 'assistant', content: [{ type: 'text', text: 'done' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    })
    const log = join(root, 'sessions', '--proj--', id, 'session.v4.jsonl.zstd')
    await mkdir(join(log, '..'), { recursive: true })
    await writeFile(log, Buffer.concat([
      zstdCompressSync(`${header}\n${user}\n`),
      zstdCompressSync(`${assistant}\n`),
    ]))
    const child = join(root, 'sessions', '--proj--', 'child', 'session.v4.jsonl')
    await write(child, JSON.stringify({
      type: 'session', version: 4, id: 'child', createdAt: 1000, cwd, isSeeded: false,
      parentSession: id, origin: 'subagent', delegationDepth: 1,
    }))

    const scan = await dshReader.scan(join(root, 'sessions'))
    expect(scan.sessions.map(session => session.meta.key)).toEqual([id])
    expect(scan.skipped?.map(entry => entry.key)).toContain('child')
    const loaded = await scan.sessions[0]?.load()
    expect(loaded?.messages.map(message => message.text)).toEqual(['continue', 'done'])
  })
})

describe('MiMo Code reader', () => {
  it('reads messages and text parts from the chat database', async () => {
    const root = await rootOf('mimo')
    const database = new DatabaseSync(join(root, 'mimocode.db'))
    database.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
        time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `)
    database.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('ses-1', 'p', null, root, 'MiMo chat', 1000, 2000, null)
    database.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      .run('m1', 'ses-1', 1100, JSON.stringify({ role: 'user' }))
    database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
      .run('p1', 'm1', 'ses-1', 1100, JSON.stringify({ type: 'text', text: 'hello mimo' }))
    database.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      .run('m2', 'ses-1', 1200, JSON.stringify({ role: 'assistant' }))
    database.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
      .run('p2', 'm2', 'ses-1', 1200, JSON.stringify({ type: 'text', text: 'hi there' }))
    database.close()

    const scan = await mimocodeReader.scan(root)
    expect(scan.sessions[0]?.meta).toMatchObject({ key: 'ses-1', cwd: root, title: 'MiMo chat', messageCount: 2 })
    const loaded = await scan.sessions[0]?.load()
    expect(loaded?.messages.map(message => message.text)).toEqual(['hello mimo', 'hi there'])
  })
})

describe('OpenCode reader', () => {
  it('reads the legacy per-record storage layout', async () => {
    const root = await rootOf('opencode')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    await write(join(root, 'storage', 'session', 'p', 'op-1.json'), JSON.stringify({
      id: 'op-1', title: 'OpenCode chat', directory: cwd, time: { created: 1000, updated: 2000 },
    }))
    await write(join(root, 'storage', 'message', 'op-1', 'm1.json'), JSON.stringify({
      id: 'm1', role: 'user', time: { created: 1100 },
    }))
    await write(join(root, 'storage', 'part', 'm1', 'p1.json'), JSON.stringify({ type: 'text', text: 'hello opencode' }))
    await write(join(root, 'storage', 'message', 'op-1', 'm2.json'), JSON.stringify({
      id: 'm2', role: 'assistant', time: { created: 1200 },
    }))
    await write(join(root, 'storage', 'part', 'm2', 'p2.json'), JSON.stringify({ type: 'text', text: 'hi' }))

    const scan = await opencodeReader.scan(root)
    expect(scan.sessions[0]?.meta).toMatchObject({ key: 'op-1', cwd, title: 'OpenCode chat' })
    const loaded = await scan.sessions[0]?.load()
    expect(loaded?.messages.map(message => message.text)).toEqual(['hello opencode', 'hi'])
  })
})

describe('OpenClaw reader', () => {
  it('reads transcript events from the per-agent database', async () => {
    const root = await rootOf('openclaw')
    const directory = join(root, 'agents', 'main', 'agent')
    await mkdir(directory, { recursive: true })
    const database = new DatabaseSync(join(directory, 'openclaw-agent.sqlite'))
    database.exec(`
      CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, title TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT);
    `)
    database.prepare('INSERT INTO session_windows VALUES (?, ?, ?, ?, ?)')
      .run('oc-1', 'OpenClaw chat', root, 1000, 2000)
    database.prepare('INSERT INTO transcript_events VALUES (?, ?, ?)')
      .run('oc-1', 0, JSON.stringify({ type: 'message', role: 'user', content: 'hello claw' }))
    database.prepare('INSERT INTO transcript_events VALUES (?, ?, ?)')
      .run('oc-1', 1, JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }))
    database.close()

    const scan = await openclawReader.scan(root)
    expect(scan.sessions[0]?.meta).toMatchObject({ key: 'oc-1', cwd: root, title: 'OpenClaw chat' })
    const loaded = await scan.sessions[0]?.load()
    expect(loaded?.messages.map(message => message.text)).toEqual(['hello claw', 'hi'])
  })
})

describe('Hermes reader', () => {
  it('reads exported session snapshots', async () => {
    const root = await rootOf('hermes')
    await write(join(root, 'sessions', 'session_h1.json'), JSON.stringify({
      session_id: 'h1',
      title: 'Hermes chat',
      workspace: root,
      created_at: 1000,
      messages: [
        { role: 'user', content: 'hello hermes', timestamp: 1100 },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 1200 },
      ],
    }))

    const scan = await hermesReader.scan(root)
    expect(scan.sessions[0]?.meta).toMatchObject({ key: 'h1', cwd: root, title: 'Hermes chat' })
    const loaded = await scan.sessions[0]?.load()
    expect(loaded?.messages.map(message => message.text)).toEqual(['hello hermes', 'hi'])
  })
})

describe('Pi reader', () => {
  it('follows the parent chain from the newest record', async () => {
    const root = await rootOf('pi')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const header = JSON.stringify({ type: 'session', version: 3, id: 'pi-1', timestamp: '2026-03-01T00:00:00.000Z', cwd })
    const user = JSON.stringify({
      type: 'message', id: 'm1', parentId: null, timestamp: '2026-03-01T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello pi' }] },
    })
    const assistant = JSON.stringify({
      type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-03-01T00:00:02.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    })
    await write(join(root, '--project--', '2026-03-01_pi-1.jsonl'), [header, user, assistant].join('\n'))

    const scan = await piReader.scan(root)
    expect(scan.sessions[0]?.meta).toMatchObject({ key: 'pi-1', cwd })
    const loaded = await scan.sessions[0]?.load()
    expect(loaded?.messages.map(message => message.text)).toEqual(['hello pi', 'hi'])
  })
})

describe('Gemini CLI reader', () => {
  it('reads JSONL chats and keeps the last copy of a re-serialized message', async () => {
    const root = await rootOf('gemini')
    const file = join(root, 'project', 'chats', 'session-1.jsonl')
    await write(file, [
      JSON.stringify({ sessionId: 'g1', startTime: '2026-04-01T00:00:00.000Z', lastUpdated: '2026-04-01T00:01:00.000Z' }),
      JSON.stringify({ id: 'u1', timestamp: '2026-04-01T00:00:01.000Z', type: 'user', content: 'hello gemini' }),
      JSON.stringify({ id: 'a1', timestamp: '2026-04-01T00:00:02.000Z', type: 'gemini', content: 'partial' }),
      JSON.stringify({ id: 'a1', timestamp: '2026-04-01T00:00:03.000Z', type: 'gemini', content: 'complete' }),
    ].join('\n'))

    const scan = await geminiReader.scan(root)
    expect(scan.sessions[0]?.meta).toMatchObject({ key: 'g1' })
    const loaded = await scan.sessions[0]?.load()
    expect(loaded?.messages.map(message => message.text)).toEqual(['hello gemini', 'complete'])
  })
})
