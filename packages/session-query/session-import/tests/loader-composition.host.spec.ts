import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ImportWorkspace } from '../src/engine.ts'
import { IMPORT_SOURCE_IDS } from '../src/source-ids.ts'
import * as SessionImport from '../src/index.ts'

interface Route {
  readonly fetch: (request: Request) => Promise<Response>
}

interface Harness {
  readonly context: Context
  readonly routes: Map<string, Route>
  readonly stored: Map<string, readonly SessionEvent[]>
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
  const root = await mkdtemp(join(tmpdir(), `dsh-import-loader-${name}-`))
  roots.push(root)
  return root
}

async function boot(root: string, seedWorkspace = false): Promise<Harness> {
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  const canonicalCwd = await realpath(cwd)
  const claudeRoot = join(root, 'claude-projects')
  await mkdir(join(claudeRoot, 'p'), { recursive: true })
  await writeFile(join(claudeRoot, 'p', 'one.jsonl'), [
    JSON.stringify({
      type: 'user', cwd, timestamp: '2026-01-01T00:00:00.000Z', isSidechain: false,
      message: { role: 'user', content: 'hello loader' },
    }),
    JSON.stringify({
      type: 'assistant', cwd, timestamp: '2026-01-01T00:00:01.000Z', isSidechain: false,
      message: { id: 'a', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'hi' }] },
    }),
  ].join('\n'))

  const missing = join(root, 'missing')
  const config = {
    roots: Object.fromEntries(IMPORT_SOURCE_IDS.map(id => [id, id === 'claude' ? claudeRoot : join(missing, id)])),
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session-import'",
    `  config: ${JSON.stringify(config)}`,
    '',
  ].join('\n'))

  const routes = new Map<string, Route>()
  const stored = new Map<string, readonly SessionEvent[]>()
  const attached = new Map<string, string[]>()
  const workspaces = new Map<string, ImportWorkspace>()
  if (seedWorkspace) {
    workspaces.set(canonicalCwd, {
      id: `ws-${canonicalCwd}`,
      title: canonicalCwd,
      sessionIds: [],
      attachSession: async (id) => {
        const list = attached.get(canonicalCwd) ?? []
        list.unshift(String(id))
        attached.set(canonicalCwd, list)
      },
    })
  }
  const context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
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
  context.provide('sessionPersistence', {
    stat: async (id: string) => stored.has(id) ? {} : undefined,
    create: async (header: SessionHeader) => ({
      append: async (events: readonly SessionEvent[]) => { stored.set(String(header.id), events) },
      flush: async () => {},
      close: async () => {},
    }),
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

  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier !== '@deepseek-ai/dsh-session-import') throw new Error(`unexpected Loader import: ${specifier}`)
      return SessionImport
    },
  } as never
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  const harness = { context, routes, stored, attached, cwd: canonicalCwd }
  harnesses.push(harness)
  return harness
}

async function call(harness: Harness, path: string, body?: object): Promise<Response> {
  const route = harness.routes.get(path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  return route.fetch(new Request(`http://localhost${path}`, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('session-import Loader composition', () => {
  it('discovers sources, plans, imports, and stays idempotent through real route registration', async () => {
    const root = await rootOf('apply')
    const harness = await boot(root)
    expect([...harness.routes.keys()].sort()).toEqual(['/api/session.import', '/api/session.import.candidates'])

    const candidates = await (await call(harness, '/api/session.import.candidates')).json() as {
      id: string
      available: boolean
      sessionCount: number
      reason?: string
    }[]
    expect(candidates.find(candidate => candidate.id === 'claude')).toMatchObject({ available: true, sessionCount: 1 })
    expect(candidates.find(candidate => candidate.id === 'codex')).toMatchObject({ available: false, reason: 'not-found' })

    const planned = await call(harness, '/api/session.import', { op: 'plan', source: 'claude' })
    expect(planned.status).toBe(200)
    const plan = await planned.json() as { groups: { path: string; sessions: { key: string }[]; merge: boolean }[] }
    expect(plan.groups[0]?.path).toBe(harness.cwd)
    expect(plan.groups[0]?.merge).toBe(false)

    const applied = await call(harness, '/api/session.import', { op: 'apply', source: 'claude', sessionIds: ['one'] })
    expect(applied.status).toBe(200)
    const result = await applied.json() as { results: { outcome: string; sessionId?: string }[] }
    expect(result.results[0]?.outcome).toBe('imported')
    expect(harness.stored.size).toBe(1)
    expect(harness.attached.get(harness.cwd)).toHaveLength(1)

    const repeated = await call(harness, '/api/session.import', { op: 'apply', source: 'claude', sessionIds: ['one'] })
    expect(repeated.status).toBe(200)
    expect(await repeated.json()).toMatchObject({ results: [{ outcome: 'duplicate' }] })

    await harness.context.fiber.dispose()
    expect(harness.routes.size).toBe(0)
  })

  it('refuses a merge until the request carries confirmation', async () => {
    const root = await rootOf('merge')
    const harness = await boot(root, true)

    const rejected = await call(harness, '/api/session.import', { op: 'apply', source: 'claude', sessionIds: ['one'] })
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ code: 'merge-confirmation-required' })

    const accepted = await call(harness, '/api/session.import', {
      op: 'apply', source: 'claude', sessionIds: ['one'], confirmMerge: true,
    })
    expect(accepted.status).toBe(200)
    expect(harness.attached.get(harness.cwd)).toHaveLength(1)
  })
})
