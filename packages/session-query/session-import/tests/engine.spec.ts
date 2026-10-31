import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { Session, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  ImportEngineError,
  SessionImportEngine,
  type ImportPersistence,
  type ImportSessionHandle,
  type ImportWorkspace,
  type ImportWorkspaces,
} from '../src/engine.ts'
import type { ImportSourceId } from '../src/types.ts'

const roots: string[] = []

async function rootOf(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-import-engine-${name}-`))
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

/** One Claude transcript with the given turns. */
async function claudeFixture(
  root: string,
  key: string,
  cwd: string,
  turns: readonly (readonly [string, string])[],
  title?: string,
): Promise<void> {
  const lines: string[] = []
  for (const [index, [user, assistant]] of turns.entries()) {
    lines.push(JSON.stringify({
      type: 'user', sessionId: key, cwd, timestamp: `2026-01-01T00:00:0${index}.000Z`, isSidechain: false,
      message: { role: 'user', content: user },
    }))
    lines.push(JSON.stringify({
      type: 'assistant', sessionId: key, cwd, timestamp: `2026-01-01T00:00:0${index}.500Z`, isSidechain: false,
      message: { id: `a${index}`, role: 'assistant', model: 'm', content: [{ type: 'text', text: assistant }] },
    }))
  }
  if (title !== undefined) lines.push(JSON.stringify({ type: 'ai-title', aiTitle: title }))
  await write(join(root, 'projects', 'p', `${key}.jsonl`), lines.join('\n'))
}

/** Recorded session writes plus project membership. */
function fakes(initialWorkspaces: string[] = []) {
  const stored = new Map<string, readonly SessionEvent[]>()
  const headers = new Map<string, SessionHeader>()
  const attached = new Map<string, string[]>()
  const workspaces = new Map<string, ImportWorkspace>()
  for (const path of initialWorkspaces) {
    workspaces.set(path, {
      id: `ws-${path}`,
      title: path,
      sessionIds: [],
      attachSession: async (id) => {
        const list = attached.get(path) ?? []
        list.unshift(String(id))
        attached.set(path, list)
      },
    })
  }
  const persistence: ImportPersistence = {
    stat: async id => stored.has(String(id)) ? {} : undefined,
    create: async (header): Promise<ImportSessionHandle> => {
      headers.set(String(header.id), header)
      return {
        append: async (events) => { stored.set(String(header.id), events) },
        flush: async () => {},
        close: async () => {},
      }
    },
  }
  const registry: ImportWorkspaces = {
    resolveByPath: async path => workspaces.get(path),
    create: async (path) => {
      let workspace = workspaces.get(path)
      if (workspace === undefined) {
        workspace = {
          id: `ws-${path}`,
          title: path,
          sessionIds: [],
          attachSession: async (id) => {
            const list = attached.get(path) ?? []
            list.unshift(String(id))
            attached.set(path, list)
          },
        }
        workspaces.set(path, workspace)
      }
      return workspace
    },
  }
  return { stored, headers, attached, persistence, registry }
}

describe('SessionImportEngine plan', () => {
  it('groups sessions by working folder and reports ungrouped ones', async () => {
    const root = await rootOf('plan')
    const first = join(root, 'first')
    const second = join(root, 'second')
    await mkdir(first)
    await mkdir(second)
    await claudeFixture(root, 'one', first, [['a', 'b']])
    await claudeFixture(root, 'two', first, [['c', 'd']])
    await claudeFixture(root, 'three', join(root, 'missing'), [['e', 'f']])
    const fakesValue = fakes()
    const engine = new SessionImportEngine({
      persistence: fakesValue.persistence,
      workspaces: fakesValue.registry,
      currentHome: join(root, '.prism'),
      roots: { claude: join(root, 'projects') },
      maxMessages: 2000,
      maxMessageTextBytes: 32768,
    })

    const plan = await engine.plan({ source: 'claude' })
    expect(plan.groups).toHaveLength(2)
    expect(plan.groups.find(group => group.path === first)?.sessions).toHaveLength(2)
    expect(plan.groups.find(group => group.path === undefined)?.sessions.map(session => session.key)).toEqual(['three'])
  })

  it('marks a folder whose project already exists as a merge', async () => {
    const root = await rootOf('merge')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    await claudeFixture(root, 'one', cwd, [['a', 'b']])
    const fakesValue = fakes([cwd])
    const engine = new SessionImportEngine({
      persistence: fakesValue.persistence,
      workspaces: fakesValue.registry,
      currentHome: join(root, '.prism'),
      roots: { claude: join(root, 'projects') },
      maxMessages: 2000,
      maxMessageTextBytes: 32768,
    })

    const plan = await engine.plan({ source: 'claude' })
    expect(plan.groups[0]).toMatchObject({ path: cwd, merge: true, existingWorkspace: { id: `ws-${cwd}` } })
  })
})

describe('SessionImportEngine apply', () => {
  it('writes decodable turns, registers the project, and is idempotent', async () => {
    const root = await rootOf('apply')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    await claudeFixture(root, 'one', cwd, [['first prompt', 'first reply'], ['second prompt', 'second reply']], 'A conversation')
    const fakesValue = fakes()
    const engine = new SessionImportEngine({
      persistence: fakesValue.persistence,
      workspaces: fakesValue.registry,
      currentHome: join(root, '.prism'),
      roots: { claude: join(root, 'projects') },
      maxMessages: 2000,
      maxMessageTextBytes: 32768,
    })

    const first = await engine.apply({ source: 'claude', sessionIds: ['one'] })
    expect(first.results[0]?.outcome).toBe('imported')
    expect(first.results[0]?.sessionId).toMatch(/^session-import-[0-9a-f]{32}$/)
    expect(first.workspaces).toEqual([{ path: cwd, workspaceId: `ws-${cwd}`, created: true, imported: 1 }])
    const events = [...fakesValue.stored.values()][0] ?? []
    expect(events.map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
      'session/title',
    ])
    expect(events.map(event => event.seq)).toEqual(events.map((_event, index) => index))
    const users = events.flatMap((event) => {
      if (event.type !== 'user/message') return []
      return event.data.role === 'user' ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []
    })
    expect(users).toEqual(['first prompt', 'second prompt'])
    expect(fakesValue.attached.get(cwd)).toHaveLength(1)

    const second = await engine.apply({ source: 'claude', sessionIds: ['one'] })
    expect(second.results[0]?.outcome).toBe('duplicate')
    expect(fakesValue.stored.size).toBe(1)
  })

  it('checkpoints each written log for the cold list', async () => {
    const root = await rootOf('checkpoint')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    await claudeFixture(root, 'one', cwd, [['prompt', 'reply']], 'A conversation')
    const fakesValue = fakes()
    const checkpoints: { header: SessionHeader; events: readonly SessionEvent[] }[] = []
    const engine = new SessionImportEngine({
      persistence: fakesValue.persistence,
      workspaces: fakesValue.registry,
      currentHome: join(root, '.prism'),
      roots: { claude: join(root, 'projects') },
      maxMessages: 2000,
      maxMessageTextBytes: 32768,
      projections: { checkpoint: async (header, events) => { checkpoints.push({ header, events }) } },
    })

    const result = await engine.apply({ source: 'claude', sessionIds: ['one'] })
    const id = String(result.results[0]?.sessionId)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]?.header.id).toBe(id)
    expect(checkpoints[0]?.events).toEqual(fakesValue.stored.get(id))

    await engine.apply({ source: 'claude', sessionIds: ['one'] })
    expect(checkpoints).toHaveLength(1)
  })

  it('keeps a session imported when the checkpoint fold fails', async () => {
    const root = await rootOf('checkpoint-failure')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    await claudeFixture(root, 'one', cwd, [['prompt', 'reply']])
    const fakesValue = fakes()
    const engine = new SessionImportEngine({
      persistence: fakesValue.persistence,
      workspaces: fakesValue.registry,
      currentHome: join(root, '.prism'),
      roots: { claude: join(root, 'projects') },
      maxMessages: 2000,
      maxMessageTextBytes: 32768,
      projections: { checkpoint: async () => { throw new Error('cache unavailable') } },
    })

    const result = await engine.apply({ source: 'claude', sessionIds: ['one'] })
    const imported = result.results[0]
    expect(imported?.outcome).toBe('imported')
    expect(imported?.reason).toContain('list title unavailable: cache unavailable')
    expect(fakesValue.stored.size).toBe(1)
    expect(fakesValue.attached.get(cwd)).toHaveLength(1)
  })

  it('refuses to merge into an existing project without confirmation', async () => {
    const root = await rootOf('confirm')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    await claudeFixture(root, 'one', cwd, [['a', 'b']])
    const fakesValue = fakes([cwd])
    const engine = new SessionImportEngine({
      persistence: fakesValue.persistence,
      workspaces: fakesValue.registry,
      currentHome: join(root, '.prism'),
      roots: { claude: join(root, 'projects') },
      maxMessages: 2000,
      maxMessageTextBytes: 32768,
    })

    await expect(engine.apply({ source: 'claude', sessionIds: ['one'] }))
      .rejects.toMatchObject({ code: 'merge-confirmation-required' })
    expect(fakesValue.stored.size).toBe(0)
    await expect(engine.apply({ source: 'claude', sessionIds: ['one'], confirmMerge: true }))
      .resolves.toMatchObject({ results: [{ outcome: 'imported' }] })
    expect(fakesValue.attached.get(cwd)).toHaveLength(1)
  })

  it('bounds retained messages and keeps a user-first conversation', async () => {
    const root = await rootOf('bounds')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    await claudeFixture(root, 'one', cwd, [
      ['one prompt', 'reply one'],
      ['two prompt', 'reply two'],
      ['three prompt', 'reply three'],
    ])
    const fakesValue = fakes()
    const engine = new SessionImportEngine({
      persistence: fakesValue.persistence,
      workspaces: fakesValue.registry,
      currentHome: join(root, '.prism'),
      roots: { claude: join(root, 'projects') },
      maxMessages: 3,
      maxMessageTextBytes: 8,
    })

    await engine.apply({ source: 'claude', sessionIds: ['one'] })
    const events = [...fakesValue.stored.values()][0] ?? []
    const userEvents = events.filter(event => event.type === 'user/message')
    expect(userEvents).toHaveLength(1)
    const texts = userEvents.flatMap(event => event.type === 'user/message'
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])
    expect(texts[0]).toContain('[truncated]')
    expect(texts.join(' ')).not.toContain('one prompt')
  })

  it('copies a DSH session natively, preserving tool events and attachments', async () => {
    const root = await rootOf('native')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const sourceHome = join(root, 'dsh')
    const id = 'source-native'
    const eventLines = [
      { type: 'turn/start', seq: 0, time: 1050, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 1050, data: { turn: 1, step: 1 } },
      { type: 'user/message', seq: 2, time: 1100, data: {
        id: 'u1', role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' },
      }, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 3, time: 1200, data: {
        turn: 1, step: 1, stream: [],
        message: {
          id: 'a1', role: 'assistant',
          content: [{ type: 'text', text: 'checking' }, { type: 'tool-call', id: 'c1', name: 'glob', arguments: '{}' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      }, surfaceOp: 'append' },
      { type: 'tool/call', seq: 4, time: 1300, data: { turn: 1, step: 1, callId: 'c1', name: 'glob', arguments: '{}' } },
      { type: 'tool/result', seq: 5, time: 1400, data: {
        turn: 1, step: 1,
        message: {
          id: 'r1', role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }],
        },
      }, surfaceOp: 'append' },
      { type: 'step/end', seq: 6, time: 1450, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 7, time: 1500, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const log = join(sourceHome, 'sessions', '--proj--', id, 'session.v4.jsonl')
    await write(log, JSON.stringify({
      type: 'session', version: 4, id, createdAt: 1000, cwd, isSeeded: false, delegationDepth: 0,
    }) + '\n' + eventLines.map(event => JSON.stringify(event)).join('\n'))
    await write(join(sourceHome, 'attachments', 'v1', 'objects', 'a.png'), 'png')

    const fakesValue = fakes()
    const engine = new SessionImportEngine({
      persistence: fakesValue.persistence,
      workspaces: fakesValue.registry,
      currentHome: join(root, 'prism'),
      roots: { dsh: join(sourceHome, 'sessions') },
      maxMessages: 2000,
      maxMessageTextBytes: 32768,
    })
    const result = await engine.apply({ source: 'dsh', sessionIds: [id] })
    expect(result.results[0]).toMatchObject({ key: id, outcome: 'imported', sessionId: id })
    expect(fakesValue.stored.get(id)?.map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'assistant/message',
      'tool/call', 'tool/result', 'step/end', 'turn/end',
    ])
    expect([...fakesValue.attached.values()].flat()).toContain(id)
    const copied = await stat(join(root, 'prism', 'attachments', 'v1', 'objects', 'a.png'))
    expect(copied.mode & 0o400).toBe(0o400)

    const header = fakesValue.headers.get(id)
    expect(header).toBeDefined()
    const resumed = Session.create(SessionId(id), [...(fakesValue.stored.get(id) ?? [])], header)
    const messages = resumed.deriveMessages()
    expect(messages).toHaveLength(3)
    expect(messages[2]?.content[0]?.type).toBe('tool-result')
    await expect(engine.apply({ source: 'dsh', sessionIds: [id] }))
      .resolves.toMatchObject({ results: [{ outcome: 'duplicate' }] })
  })

  it('refuses a foreign log whose required event type this harness cannot read back', async () => {
    const root = await rootOf('native-unknown')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const sourceHome = join(root, 'dsh')
    const id = 'source-unknown'
    await write(join(sourceHome, 'sessions', '--proj--', id, 'session.v4.jsonl'), JSON.stringify({
      type: 'session', version: 4, id, createdAt: 1000, cwd, isSeeded: false, delegationDepth: 0,
    }) + '\n' + JSON.stringify({ type: 'future/event', seq: 0, time: 1100, data: { value: 1 } }))
    const fakesValue = fakes()
    const engine = new SessionImportEngine({
      persistence: fakesValue.persistence,
      workspaces: fakesValue.registry,
      currentHome: join(root, 'prism'),
      roots: { dsh: join(sourceHome, 'sessions') },
      maxMessages: 2000,
      maxMessageTextBytes: 32768,
    })

    const result = await engine.apply({ source: 'dsh', sessionIds: [id] })
    expect(result.results[0]).toMatchObject({ key: id, outcome: 'failed' })
    expect(result.results[0]?.reason).toContain('future/event')
    // Nothing was written, so the refused log cannot brick a session or block a later retry.
    expect(fakesValue.stored.size).toBe(0)
  })

  it('refuses the retired request/header fallback the reader would reject', async () => {
    const root = await rootOf('native-retired')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const sourceHome = join(root, 'dsh')
    const id = 'source-retired'
    await write(join(sourceHome, 'sessions', '--proj--', id, 'session.v4.jsonl'), JSON.stringify({
      type: 'session', version: 4, id, createdAt: 1000, cwd, isSeeded: false, delegationDepth: 0,
    }) + '\n' + JSON.stringify({ type: 'request/header', seq: 0, time: 1100, data: { reason: 'fallback' } }))
    const fakesValue = fakes()
    const engine = new SessionImportEngine({
      persistence: fakesValue.persistence,
      workspaces: fakesValue.registry,
      currentHome: join(root, 'prism'),
      roots: { dsh: join(sourceHome, 'sessions') },
      maxMessages: 2000,
      maxMessageTextBytes: 32768,
    })

    const result = await engine.apply({ source: 'dsh', sessionIds: [id] })
    expect(result.results[0]).toMatchObject({ key: id, outcome: 'failed' })
    expect(result.results[0]?.reason).toContain('fallback')
    expect(fakesValue.stored.size).toBe(0)
  })

  it('imports a foreign log whose unknown event is explicitly ignorable', async () => {
    const root = await rootOf('native-ignorable')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    const sourceHome = join(root, 'dsh')
    const id = 'source-ignorable'
    await write(join(sourceHome, 'sessions', '--proj--', id, 'session.v4.jsonl'), JSON.stringify({
      type: 'session', version: 4, id, createdAt: 1000, cwd, isSeeded: false, delegationDepth: 0,
    }) + '\n' + JSON.stringify({ type: 'future/event', seq: 0, time: 1100, data: { value: 1 }, ignorable: true }))
    const fakesValue = fakes()
    const engine = new SessionImportEngine({
      persistence: fakesValue.persistence,
      workspaces: fakesValue.registry,
      currentHome: join(root, 'prism'),
      roots: { dsh: join(sourceHome, 'sessions') },
      maxMessages: 2000,
      maxMessageTextBytes: 32768,
    })

    const result = await engine.apply({ source: 'dsh', sessionIds: [id] })
    expect(result.results[0]).toMatchObject({ key: id, outcome: 'imported' })
    expect(fakesValue.stored.get(id)?.map(event => event.type)).toEqual(['future/event'])
  })

  it('writes a converted log the real JSONL backend can cold-read', async () => {
    const root = await rootOf('coldread')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    await claudeFixture(root, 'one', cwd, [['first', 'reply one'], ['second', 'reply two']])
    const store = new Context()
    const storageRoot = join(root, 'sessions')
    const fiber = await store.plugin(JsonlSessionPersistence, { root: storageRoot, compression: 'none' }).await()
    try {
      const engine = new SessionImportEngine({
        persistence: store.sessionPersistence,
        workspaces: fakes().registry,
        currentHome: join(root, '.prism'),
        roots: { claude: join(root, 'projects') },
        maxMessages: 2000,
        maxMessageTextBytes: 32768,
      })
      const result = await engine.apply({ source: 'claude', sessionIds: ['one'] })
      const id = result.results[0]?.sessionId
      if (id === undefined) throw new Error('import did not report a session id')

      const handle = await store.sessionPersistence.open(SessionId(id), 'read')
      const read = await handle.read()
      await handle.close()
      const types = read.events.map(event => event.type)
      expect(types[0]).toBe('turn/start')
      expect(types[1]).toBe('step/start')
      expect(types.at(-2)).toBe('step/end')
      expect(types.at(-1)).toBe('turn/end')
      expect(read.events.every((event, index) => event.seq === index)).toBe(true)
    } finally {
      await fiber.dispose()
    }
  })

  it('reports unknown sources and unknown session ids without writing', async () => {
    const root = await rootOf('errors')
    const cwd = join(root, 'project')
    await mkdir(cwd)
    await claudeFixture(root, 'one', cwd, [['a', 'b']])
    const fakesValue = fakes()
    const engine = new SessionImportEngine({
      persistence: fakesValue.persistence,
      workspaces: fakesValue.registry,
      currentHome: join(root, '.prism'),
      roots: { claude: join(root, 'projects') },
      maxMessages: 2000,
      maxMessageTextBytes: 32768,
    })

    await expect(engine.plan({ source: 'nope' as ImportSourceId })).rejects.toBeInstanceOf(ImportEngineError)
    const unavailable = new SessionImportEngine({
      persistence: fakesValue.persistence,
      workspaces: fakesValue.registry,
      currentHome: join(root, '.prism'),
      roots: { dsh: join(root, 'no-dsh') },
      maxMessages: 2000,
      maxMessageTextBytes: 32768,
    })
    await expect(unavailable.plan({ source: 'dsh' })).rejects.toMatchObject({ code: 'source-unavailable' })
    const result = await engine.apply({ source: 'claude', sessionIds: ['missing'] })
    expect(result.results).toEqual([{ key: 'missing', outcome: 'skipped', reason: 'session not found in source' }])
    expect(fakesValue.stored.size).toBe(0)
  })
})
