/**
 * Imported Sessions must reach the cold Session list with their titles. The
 * list serves a stored Session from its projection-cache checkpoint alone (it
 * never folds a log), and an import writes a log outside the live Session
 * lifecycle, so the import has to checkpoint each written Session through the
 * real cache. These cases run that composition end to end: real JSONL
 * persistence, the real projection cache, the shipped title unit, and the
 * plugin's Fetch routes.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageDomainApply, Config as storageDomainConfig,
  inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import {
  apply as storageJsonApply, Config as storageJsonConfig,
  inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { SESSION_IMPORT_CANDIDATES_PATH, SESSION_IMPORT_PATH } from '../src/routes.ts'
import * as SessionImport from '../src/index.ts'
import type { ImportWorkspace } from '../src/engine.ts'

interface Route {
  readonly fetch: (request: Request) => Promise<Response>
}

interface Harness {
  readonly context: Context
  readonly routes: Map<string, Route>
  readonly attached: Map<string, string[]>
  readonly cwd: string
}

const harnesses: Harness[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.context.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function rootOf(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `dsh-import-cache-${name}-`))
  roots.push(root)
  return root
}

/** Mount the shipped Session, projection, cache, and title services over one temporary home. */
async function boot(
  root: string,
  roots: NonNullable<SessionImport.Config['roots']>,
): Promise<Harness> {
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  const routes = new Map<string, Route>()
  const attached = new Map<string, string[]>()
  const workspaces = new Map<string, ImportWorkspace>()
  const context = new Context()
  await context.plugin(Storage)
  await context.plugin(
    { name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig },
    { root: join(root, 'storages') },
  )
  await context.plugin(
    { name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig },
    { backend: 'json' },
  )
  await context.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await context.plugin(SessionStore)
  await context.plugin(SessionProjectionRegistry)
  await context.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  await context.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  context.provide('dshHomePath', () => join(root, '.prism'))
  context.provide('connection', {
    fetch: {
      register: (route: Route & { path: string }) => {
        routes.set(route.path, route)
        return () => {
          routes.delete(route.path)
          return Promise.resolve()
        }
      },
    },
  } as never)
  context.provide('workspaceRegistry', {
    resolveByPath: async (path: string) => workspaces.get(path),
    create: async (path: string) => {
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
  } as never)
  SessionImport.apply(context, { roots })
  const harness = { context, routes, attached, cwd }
  harnesses.push(harness)
  return harness
}

interface ApplyResult {
  results: { outcome: string; sessionId?: string }[]
}

async function apply(harness: Harness, source: string, sessionIds: string[]): Promise<ApplyResult> {
  const route = harness.routes.get(SESSION_IMPORT_PATH)
  if (route === undefined) throw new Error(`route not registered: ${SESSION_IMPORT_PATH}`)
  const response = await route.fetch(new Request(`http://localhost${SESSION_IMPORT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'apply', source, sessionIds }),
  }))
  expect(response.status).toBe(200)
  return await response.json() as ApplyResult
}

/** The stored header a cold list would be handed for one session. */
async function storedHeader(harness: Harness, id: string): Promise<SessionHeader> {
  const snapshot = await harness.context.sessionPersistence.stat(id as never)
  if (snapshot === undefined) throw new Error(`session "${id}" was not stored`)
  return snapshot.header
}

describe('session-import projection checkpoint', () => {
  it('lists a converted conversation under its imported title', async () => {
    const root = await rootOf('converted')
    const claudeRoot = join(root, 'claude-projects')
    await mkdir(join(claudeRoot, 'p'), { recursive: true })
    await writeFile(join(claudeRoot, 'p', 'one.jsonl'), [
      JSON.stringify({
        type: 'user', sessionId: 'one', cwd: join(root, 'project'), timestamp: '2026-01-01T00:00:00.000Z',
        isSidechain: false, message: { role: 'user', content: 'port the importer' },
      }),
      JSON.stringify({
        type: 'assistant', sessionId: 'one', cwd: join(root, 'project'), timestamp: '2026-01-01T00:00:01.000Z',
        isSidechain: false, message: { id: 'a', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'done' }] },
      }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Importer work' }),
    ].join('\n'))
    const harness = await boot(root, { claude: claudeRoot })
    expect(harness.routes.has(SESSION_IMPORT_CANDIDATES_PATH)).toBe(true)

    const result = await apply(harness, 'claude', ['one'])
    const id = result.results[0]?.sessionId
    expect(id).toBeDefined()
    expect(harness.attached.get(harness.cwd)).toHaveLength(1)

    const cached = harness.context.sessionProjectionCache.cachedSnapshot(await storedHeader(harness, String(id)))
    expect(cached?.values['title']).toBe('Importer work')
  })

  it('lists a natively copied conversation under its logged title', async () => {
    const root = await rootOf('native')
    const source = join(root, 'dsh', 'sessions', '--proj--', 'native-1', 'session.v4.jsonl')
    await mkdir(join(source, '..'), { recursive: true })
    const events = [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 1000, data: { turn: 1, step: 1 } },
      {
        type: 'user/message', seq: 2, time: 1000, surfaceOp: 'append',
        data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'resume this' }], source: { kind: 'user' } },
      },
      { type: 'step/end', seq: 3, time: 1100, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 4, time: 1100, data: { turn: 1, reason: { kind: 'completed' } } },
      {
        type: 'session/title', seq: 5, time: 1100,
        data: { title: 'Resumed session', messageSeqs: [2], source: { kind: 'fallback' } },
      },
    ]
    await writeFile(source, JSON.stringify({
      type: 'session', version: 4, id: 'native-1', createdAt: 1000,
      cwd: join(root, 'project'), isSeeded: false, delegationDepth: 0,
    }) + '\n' + events.map(event => JSON.stringify(event)).join('\n'))
    const harness = await boot(root, { dsh: join(root, 'dsh', 'sessions') })

    const result = await apply(harness, 'dsh', ['native-1'])
    expect(result.results[0]).toMatchObject({ outcome: 'imported', sessionId: 'native-1' })

    const cached = harness.context.sessionProjectionCache.cachedSnapshot(await storedHeader(harness, 'native-1'))
    expect(cached?.values['title']).toBe('Resumed session')
  })
})
