import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import { apply } from '../src/index.ts'
import { TRANSFER_EXPORT_PATH, TRANSFER_IMPORT_PATH, TRANSFER_JOB_PATH, TRANSFER_SETTINGS_PATH } from '../src/routes.ts'

const tempRoot = await mkdtemp(join(tmpdir(), 'prism-transfer-route-'))

/** A recorded route registry standing in for the connection service. */
function fakeConnection() {
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  return {
    routes,
    connection: {
      fetch: {
        register: (route: { readonly path: string; readonly fetch: (request: Request) => Promise<Response> }) => {
          routes.set(route.path, route.fetch)
          return Promise.resolve(() => Promise.resolve())
        },
      },
    },
  }
}

/** Fake settings surface with one live namespace. */
function fakeSettings() {
  return {
    describe: () => [{
      ns: 'web',
      autoGenerate: true,
      schema: { type: 'object', dict: { endpoint: { type: 'string' } } },
      value: { endpoint: '/x' },
      revision: 0,
      applies: 'live',
    } as never],
    update: async () => {},
  }
}

/** Fake persistence and workspace registry for the import path. */
function fakeStores(projectRoot: string) {
  return {
    sessionPersistence: {
      stat: async () => undefined,
      create: async () => ({ append: async () => {}, flush: async () => {}, close: async () => {} }),
    } as never,
    workspaceRegistry: {
      get: (id: string) => id === 'w1'
        ? {
          id,
          path: projectRoot,
          title: 'Project',
          createdAt: '',
          updatedAt: '',
          sessionIds: [],
          setTitle: () => {},
          attachSession: async () => {},
        } as never
        : undefined,
      create: async () => ({ id: 'ws', attachSession: async () => {} }) as never,
    } as never,
  }
}

/** Compose the plugin against fakes and return the route handlers. */
async function buildPlugin() {
  const home = join(tempRoot, `home-${randomUUID()}`)
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot, { recursive: true })
  await writeFile(join(projectRoot, 'f.txt'), 'content')
  const ctx = new Context()
  const connection = fakeConnection()
  const stores = fakeStores(projectRoot)
  ctx.provide('connection', connection.connection as never)
  ctx.provide('sessionQuery', {
    traceSession: async () => ({ descendants: [] }),
  } as never)
  ctx.provide('sessionPersistence', stores.sessionPersistence)
  ctx.provide('workspaceRegistry', stores.workspaceRegistry)
  ctx.provide('attachments', {
    imageLimits: { maxImageBytes: 8 * 2 ** 20 },
    saveImage: async () => {
      throw new Error('not used')
    },
    saveFileStream: async () => {
      throw new Error('not used')
    },
  } as never)
  ctx.provide('settings', fakeSettings() as never)
  Reflect.set(ctx, 'dshHomePath', () => home)
  apply(ctx)
  return { routes: connection.routes, home, projectRoot }
}

/** Poll one job id to a terminal state. */
async function awaitDone(routes: Map<string, (request: Request) => Promise<Response>>, jobId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await (await routes.get(TRANSFER_JOB_PATH)!(
      new Request(`http://host${TRANSFER_JOB_PATH}?jobId=${encodeURIComponent(jobId)}`),
    )).json() as Record<string, unknown>
    if (snapshot['state'] !== 'running') return snapshot
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('import job did not finish')
}

describe('transfer routes', () => {
  it('registers the four routes', async () => {
    const { routes } = await buildPlugin()
    expect([...routes.keys()].sort()).toEqual([
      TRANSFER_EXPORT_PATH,
      TRANSFER_IMPORT_PATH,
      TRANSFER_JOB_PATH,
      TRANSFER_SETTINGS_PATH,
    ].sort())
  })

  it('streams a single-project zip with a typed download name', async () => {
    const { routes } = await buildPlugin()
    const response = await routes.get(TRANSFER_EXPORT_PATH)!(
      new Request(`http://host${TRANSFER_EXPORT_PATH}?projects=w1`),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toContain('Project.zip')
    const body = await response.arrayBuffer()
    expect(body.byteLength).toBeGreaterThan(0)
  })

  it('answers settings-only exports as a JSON attachment', async () => {
    const { routes } = await buildPlugin()
    const response = await routes.get(TRANSFER_EXPORT_PATH)!(
      new Request(`http://host${TRANSFER_EXPORT_PATH}?settings=1`),
    )
    expect(response.headers.get('content-type')).toContain('application/json')
    const document = await response.json() as Record<string, unknown>
    expect(document['format']).toBe('prism-settings')
  })

  it('refuses unknown workspaces and empty selections', async () => {
    const { routes } = await buildPlugin()
    const unknown = await routes.get(TRANSFER_EXPORT_PATH)!(
      new Request(`http://host${TRANSFER_EXPORT_PATH}?projects=ghost`),
    )
    expect(unknown.status).toBe(404)
    const empty = await routes.get(TRANSFER_EXPORT_PATH)!(
      new Request(`http://host${TRANSFER_EXPORT_PATH}`),
    )
    expect(empty.status).toBe(400)
  })

  it('rejects non-binary import uploads and relative destinations', async () => {
    const { routes } = await buildPlugin()
    const media = await routes.get(TRANSFER_IMPORT_PATH)!(
      new Request(`http://host${TRANSFER_IMPORT_PATH}`, { method: 'POST', body: '{}' }),
    )
    expect(media.status).toBe(415)
    const dest = await routes.get(TRANSFER_IMPORT_PATH)!(
      new Request(`http://host${TRANSFER_IMPORT_PATH}?dest=relative/path`, {
        method: 'POST',
        body: 'bytes',
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )
    expect(dest.status).toBe(400)
  })

  it('runs an import job to done and reports it through the poll route', async () => {
    const { routes, home } = await buildPlugin()
    const archive = join(tempRoot, `${randomUUID()}.zip`)
    const { zipSync } = await import('fflate')
    const encoder = new TextEncoder()
    await writeFile(archive, zipSync({
      '.prism-project.json': encoder.encode(`${JSON.stringify({
        format: 'prism-project', version: 1, title: 'Imported', exportedAt: 't',
        sessions: 0, hasProjectFolder: true,
      })}\n`),
      'project/data.txt': encoder.encode('data'),
    }, { level: 6 }))
    const body = await readFile(archive)
    await rm(archive)
    const response = await routes.get(TRANSFER_IMPORT_PATH)!(
      new Request(`http://host${TRANSFER_IMPORT_PATH}?dest=${encodeURIComponent(home)}&name=imported.zip`, {
        method: 'POST',
        body: body as unknown as BodyInit,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )
    expect(response.status).toBe(200)
    const { jobId } = await response.json() as { jobId: string }
    const snapshot = await awaitDone(routes, jobId)
    expect(snapshot['state']).toBe('done')
    expect(snapshot['name']).toBe('imported.zip')
    const result = snapshot['result'] as { projects: { name: string; path: string }[] }
    expect(result.projects[0]?.name).toBe('Imported')
    await expect(readFile(join(result.projects[0]!.path, 'data.txt'), 'utf8')).resolves.toBe('data')
  })

  it('applies an uploaded settings document and reports per-namespace outcomes', async () => {
    const { routes } = await buildPlugin()
    const good = await routes.get(TRANSFER_SETTINGS_PATH)!(
      new Request(`http://host${TRANSFER_SETTINGS_PATH}`, {
        method: 'POST',
        body: JSON.stringify({
          format: 'prism-settings', version: 1, exportedAt: 't', includeSecrets: false,
          namespaces: { web: { endpoint: '/restored' } },
        }),
      }),
    )
    expect(await good.json()).toEqual({ results: [{ ns: 'web', outcome: 'applied' }] })
    const bad = await routes.get(TRANSFER_SETTINGS_PATH)!(
      new Request(`http://host${TRANSFER_SETTINGS_PATH}`, { method: 'POST', body: '{"format":"other"}' }),
    )
    expect(bad.status).toBe(400)
  })

  it('answers job polls for unknown ids with idle', async () => {
    const { routes } = await buildPlugin()
    const response = await routes.get(TRANSFER_JOB_PATH)!(
      new Request(`http://host${TRANSFER_JOB_PATH}?jobId=missing`),
    )
    expect(await response.json()).toEqual({ state: 'idle' })
  })
})
