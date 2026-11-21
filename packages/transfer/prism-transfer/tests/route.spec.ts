// @vitest-environment jsdom
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { waitFor } from '@testing-library/react'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'
import { SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLineageNode } from '@deepseek-ai/dsh-session-query'
import { zipSync } from 'fflate'
import { apply } from '../src/index.ts'
import { TRANSFER_EXPORT_PATH, TRANSFER_IMPORT_PATH, TRANSFER_JOB_PATH, TRANSFER_SETTINGS_PATH } from '../src/routes.ts'

const tempRoot = await mkdtemp(join(tmpdir(), 'prism-transfer-route-'))
const text = (value: string): Uint8Array => new TextEncoder().encode(value)

/**
 * A Request body from node bytes: undici's BodyInit accepts only
 * ArrayBuffer-backed views, so node's pool-backed Buffers copy across.
 */
function requestBody(bytes: Uint8Array): BodyInit {
  return new Uint8Array(bytes)
}

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



/** Build a single-session archive, upload it through the import route, and return the job id. */
async function postArchive(
  connection: ReturnType<typeof fakeConnection>,
  home: string,
  title: string,
  sessionId: string,
): Promise<{ jobId: string; routes: ReturnType<typeof fakeConnection>['routes'] }> {
  const archive = join(tempRoot, `${String(randomUUID())}.zip`)
  const { zipSync } = await import('fflate')
  const encoder = new TextEncoder()
  await writeFile(archive, zipSync({
    '.prism-project.json': encoder.encode(`${JSON.stringify({
      format: 'prism-project', version: 1, title, exportedAt: 't',
      sessions: 1, hasProjectFolder: false,
    })}
`),
    [`sessions/${sessionId}/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]: encoder.encode(
      `${JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1000, isSeeded: false, delegationDepth: 0 })}
`
      + `${JSON.stringify({ type: 'turn/start', seq: 0, time: 2000, data: { turn: 1 } })}
`,
    ),
  }, { level: 6 }))
  const body = await readFile(archive)
  await rm(archive)
  const response = await routeHandler(connection.routes, TRANSFER_IMPORT_PATH)(
    new Request(`http://host${TRANSFER_IMPORT_PATH}?dest=${encodeURIComponent(home)}`, {
      method: 'POST',
      body: requestBody(body),
      headers: { 'content-type': 'application/octet-stream' },
    }),
  )
  const { jobId } = await response.json() as { jobId: string }
  return { jobId, routes: connection.routes }
}

/** Fetch one registered handler, failing the test when the route is absent. */
function routeHandler(routes: Map<string, (request: Request) => Promise<Response>>, path: string): (request: Request) => Promise<Response> {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`route ${path} was not registered`)
  return handler
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

/** One stored session the fake persistence can serve to the exporter. */
const routeLog = {
  header: {
    version: SESSION_FORMAT_VERSION,
    id: 'route-session-1' as SessionId,
    createdAt: 1000,
    isSeeded: false,
    cwd: '/proj',
    delegationDepth: 0,
  },
  events: [{ type: 'turn/start', seq: 0, time: 2000, data: { turn: 1 } } as SessionEvent],
}

/** Fake persistence and workspace registry for the import and export paths. */
function fakeStores(projectRoot: string, title: string) {
  const parkCreate: { current: Promise<void> | undefined } = { current: undefined }
  return {
    parkCreate,
    sessionPersistence: {
      stat: async () => undefined,
      create: async (header: SessionHeader) => {
        void header
        if (parkCreate.current !== undefined) await parkCreate.current
        return { append: async () => {}, flush: async () => {}, close: async () => {} }
      },
      open: async (id: SessionId) => {
        if (String(id) !== 'route-session-1') throw new Error(`missing log ${String(id)}`)
        return {
          id,
          header: routeLog.header,
          access: 'read',
          inheritedEventCount: 0,
          read: async () => ({ eventState: 'detached', events: structuredClone(routeLog.events) }),
          close: async () => {},
        } as never
      },
    } as never,
    workspaceRegistry: {
      get: (id: string) => id === 'w1'
        ? {
          id,
          path: projectRoot,
          title,
          createdAt: '',
          updatedAt: '',
          sessionIds: ['route-session-1'],
          setTitle: () => {},
          attachSession: async () => {},
        } as never
        : undefined,
      create: async () => ({ id: 'ws', attachSession: async () => {} }) as never,
    } as never,
  }
}

/** Compose the plugin against fakes and return the route handlers. */
async function buildPlugin(options: { spoolFiles?: string[]; title?: string } = {}) {
  const home = join(tempRoot, `home-${randomUUID()}`)
  const projectRoot = join(home, 'project')
  await mkdir(projectRoot, { recursive: true })
  await writeFile(join(projectRoot, 'f.txt'), 'content')
  if (options.spoolFiles !== undefined) {
    const cacheRoot = join(home, 'cache', 'prism-transfer')
    await mkdir(cacheRoot, { recursive: true })
    for (const name of options.spoolFiles) await writeFile(join(cacheRoot, name), 'zip bytes')
  }
  const ctx = new Context()
  const connection = fakeConnection()
  const stores = fakeStores(projectRoot, options.title ?? 'Project')
  ctx.provide('connection', connection.connection as never)
  ctx.provide('sessionQuery', {
    traceSession: async (): Promise<{ descendants: readonly SessionLineageNode[] }> => ({ descendants: [] }),
  } as never)
  ctx.provide('sessionPersistence', stores.sessionPersistence)
  ctx.provide('workspaceRegistry', stores.workspaceRegistry)
  ctx.provide('attachments', {
    imageLimits: { maxImageBytes: 8 * 2 ** 20 },
    readImage: async () => {
      throw new Error('fixture logs reference no images')
    },
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
  return { routes: connection.routes, home, projectRoot, stores }
}

/** The spool directory of one composed plugin home. */
function spoolRoot(home: string): string {
  return join(home, 'cache', 'prism-transfer')
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
        body: requestBody(body),
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
    const response = await routeHandler(routes, TRANSFER_JOB_PATH)(
      new Request(`http://host${TRANSFER_JOB_PATH}?jobId=missing`),
    )
    expect(await response.json()).toEqual({ state: 'idle' })
    const noId = await routeHandler(routes, TRANSFER_JOB_PATH)(
      new Request(`http://host${TRANSFER_JOB_PATH}`),
    )
    expect(await noId.json()).toEqual({ state: 'idle' })
  })

  it('answers the validation pass with the skip counts before any download', async () => {
    const { routes } = await buildPlugin()
    const response = await routeHandler(routes, TRANSFER_EXPORT_PATH)(
      new Request(`http://host${TRANSFER_EXPORT_PATH}?projects=w1&settings=1&secrets=0&validate=1`),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ skippedLinks: 0, skippedUnreadable: 0, skippedSecrets: 0 })
  })

  it('hands the settings-only export the skipped-secrets header', async () => {
    const { routes } = await buildPlugin()
    const response = await routeHandler(routes, TRANSFER_EXPORT_PATH)(
      new Request(`http://host${TRANSFER_EXPORT_PATH}?projects=&settings=1&secrets=0`),
    )
    expect(response.headers.get('x-prism-transfer-skipped-secrets')).toBe('0')
  })

  it('answers a projects-carrying validation pass and removes the spool on a busy refusal', async () => {
    const { routes, home } = await buildPlugin()
    const checked = await routeHandler(routes, TRANSFER_EXPORT_PATH)(
      new Request(`http://host${TRANSFER_EXPORT_PATH}?projects=w1&validate=1`),
    )
    expect(await checked.json()).toEqual({ skippedLinks: 0, skippedUnreadable: 0, skippedSecrets: 0 })
    // Busy refusal: park the persistence create so the job never finishes,
    // then confirm the refused upload's spool file is removed.
    const cacheDir = join(home, 'cache', 'prism-transfer')
    const archive = join(tempRoot, `${randomUUID()}.zip`)
    const { zipSync } = await import('fflate')
    const encoder = new TextEncoder()
    await writeFile(archive, zipSync({
      '.prism-project.json': encoder.encode(`${JSON.stringify({
        format: 'prism-project', version: 1, title: 'Busy', exportedAt: 't',
        sessions: 0, hasProjectFolder: false,
      })}\n`),
    }, { level: 6 }))
    const bytes = await readFile(archive)
    await rm(archive)
    const first = await routeHandler(routes, TRANSFER_IMPORT_PATH)(
      new Request(`http://host${TRANSFER_IMPORT_PATH}?dest=${encodeURIComponent(home)}`, {
        method: 'POST',
        body: requestBody(bytes),
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )
    expect(first.status).toBe(200)
    const second = await routeHandler(routes, TRANSFER_IMPORT_PATH)(
      new Request(`http://host${TRANSFER_IMPORT_PATH}?dest=${encodeURIComponent(home)}`, {
        method: 'POST',
        body: requestBody(bytes),
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )
    expect(second.status).toBe(409)
    await waitFor(() => {
      expect(readdir(cacheDir)).resolves.toEqual([])
    })
  })

  it('checkpoints restored sessions into the projection cache through the shipped route', async () => {
    const { home } = await buildPlugin()
    const checkpoints: string[] = []
    // Re-apply over a context that carries the cache, then drive one import
    // through the real route and watch the checkpoint fold land.
    const ctx = new Context()
    const connection = fakeConnection()
    const stores = fakeStores(join(home, 'project'), 'Cached')
    ctx.provide('connection', connection.connection as never)
    ctx.provide('sessionQuery', { traceSession: async () => ({ descendants: [] }) } as never)
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
    ctx.provide('sessionProjectionCache', {
      coldSnapshot: (header: { id: string }) => {
        checkpoints.push(header.id)
        return { values: { title: 'x' } }
      },
      cachedSnapshot: (header: { id: string }) => (checkpoints.includes(header.id) ? { values: {} } : undefined),
    } as never)
    Reflect.set(ctx, 'dshHomePath', () => home)
    apply(ctx)
    const { jobId, routes: importRoutes } = await postArchive(connection, home, 'Cached', 'c-9')
    const snapshot = await awaitDone(importRoutes, jobId)
    expect(snapshot['state']).toBe('done')
    expect(checkpoints).toContain('c-9')
    await ctx.fiber.dispose()
  })

  it('skips the checkpoint drain when the cache holds no client view and when it never becomes readable', async () => {
    const { home } = await buildPlugin()
    const ctx = new Context()
    const connection = fakeConnection()
    const stores = fakeStores(join(home, 'project'), 'Cached')
    ctx.provide('connection', connection.connection as never)
    ctx.provide('sessionQuery', { traceSession: async () => ({ descendants: [] }) } as never)
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
    // No served value: coldSnapshot returns an empty record, so the fold
    // returns before waiting.
    ctx.provide('sessionProjectionCache', {
      coldSnapshot: () => ({ values: {} }),
      cachedSnapshot: () => undefined,
    } as never)
    Reflect.set(ctx, 'dshHomePath', () => home)
    apply(ctx)
    const first = await postArchive(connection, home, 'Cold', 'cold-1')
    const coldSnapshot = await awaitDone(connection.routes, first.jobId)
    expect(coldSnapshot['state']).toBe('done')
    await ctx.fiber.dispose()

    // Never readable: the drain polls until its deadline and gives up, still
    // finishing the import. The deadline is the fixed two-second bound.
    const never = new Context()
    const neverConnection = fakeConnection()
    const neverStores = fakeStores(join(home, 'project'), 'Never')
    never.provide('connection', neverConnection.connection as never)
    never.provide('sessionQuery', { traceSession: async () => ({ descendants: [] }) } as never)
    never.provide('sessionPersistence', neverStores.sessionPersistence)
    never.provide('workspaceRegistry', neverStores.workspaceRegistry)
    never.provide('attachments', {
      imageLimits: { maxImageBytes: 8 * 2 ** 20 },
      saveImage: async () => {
        throw new Error('not used')
      },
      saveFileStream: async () => {
        throw new Error('not used')
      },
    } as never)
    never.provide('settings', fakeSettings() as never)
    never.provide('sessionProjectionCache', {
      coldSnapshot: () => ({ values: { title: 'x' } }),
      cachedSnapshot: () => undefined,
    } as never)
    Reflect.set(never, 'dshHomePath', () => home)
    apply(never)
    const second = await postArchive(neverConnection, home, 'Never', 'never-1')
    const neverSnapshot = await awaitDone(neverConnection.routes, second.jobId)
    expect(neverSnapshot['state']).toBe('done')
    await never.fiber.dispose()
  })

  it('refuses to compose without a working dshHomePath service', () => {
    const missing = new Context()
    expect(() => apply(missing)).toThrow('the dshHomePath service is required')
    const broken = new Context()
    Reflect.set(broken, 'dshHomePath', () => 42)
    expect(() => apply(broken)).toThrow('dshHomePath returned a non-string path')
  })

  it('sweeps spooled archives past their retention and keeps fresh ones', async () => {
    const { home } = await buildPlugin({ spoolFiles: ['import-stale.zip', 'import-fresh.zip', 'notes.txt'] })
    const cacheRoot = spoolRoot(home)
    const stale = join(cacheRoot, 'import-stale.zip')
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000)
    await utimes(stale, old, old)
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const remaining = await readdir(cacheRoot)
      if (!remaining.includes('import-stale.zip')) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await expect(stat(stale)).rejects.toThrow()
    await expect(stat(join(cacheRoot, 'import-fresh.zip'))).resolves.toBeDefined()
    await expect(stat(join(cacheRoot, 'notes.txt'))).resolves.toBeDefined()
  })

  it('names non-ASCII downloads with an RFC 5987 filename and an ASCII fallback', async () => {
    const { routes } = await buildPlugin({ title: '项目:测试' })
    const response = await routeHandler(routes, TRANSFER_EXPORT_PATH)(
      new Request(`http://host${TRANSFER_EXPORT_PATH}?projects=w1`),
    )
    expect(response.status).toBe(200)
    const disposition = response.headers.get('content-disposition') ?? ''
    expect(disposition).toContain("filename*=UTF-8''")
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1] ?? '')).toContain('项目 测试.zip')
    // The classic parameter keeps an ASCII fallback for older agents.
    expect(disposition).toMatch(/filename="[A-Za-z0-9_. -]+\.zip"/)
  })

  it('answers settings-only exports carrying real secret values when asked', async () => {
    const { routes } = await buildPlugin()
    const response = await routeHandler(routes, TRANSFER_EXPORT_PATH)(
      new Request(`http://host${TRANSFER_EXPORT_PATH}?projects=&settings=1&secrets=1`),
    )
    expect(response.status).toBe(200)
    const document = await response.json() as Record<string, unknown>
    expect(document['includeSecrets']).toBe(true)
    expect((document['namespaces'] as Record<string, unknown>)['web']).toEqual({ endpoint: '/x' })
  })

  it('defaults the destination, the display name, and the job id', async () => {
    const { routes, home } = await buildPlugin()
    const archive = await spoolImportArchive()
    const response = await routeHandler(routes, TRANSFER_IMPORT_PATH)(
      new Request(`http://host${TRANSFER_IMPORT_PATH}`, {
        method: 'POST',
        body: requestBody(archive),
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )
    expect(response.status).toBe(200)
    const { jobId } = await response.json() as { jobId: string }
    const snapshot = await awaitDone(routes, jobId)
    expect(snapshot['state']).toBe('done')
    expect(snapshot['name']).toBe('archive.zip')
    const result = snapshot['result'] as { projects: { path: string }[] }
    expect(result.projects[0]?.path.startsWith(join(home, 'projects'))).toBe(true)
  })

  it('reduces a control-character-only display name to the default', async () => {
    const { routes } = await buildPlugin()
    const archive = await spoolImportArchive()
    const response = await routeHandler(routes, TRANSFER_IMPORT_PATH)(
      new Request(`http://host${TRANSFER_IMPORT_PATH}?name=${encodeURIComponent('\t \u0007')}`, {
        method: 'POST',
        body: requestBody(archive),
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )
    expect(response.status).toBe(200)
    const { jobId } = await response.json() as { jobId: string }
    const snapshot = await awaitDone(routes, jobId)
    expect(snapshot['name']).toBe('archive.zip')
  })

  it('applies backpressure while spooling a large upload', async () => {
    const { routes } = await buildPlugin()
    const big = new Uint8Array(2 ** 20)
    const response = await routeHandler(routes, TRANSFER_IMPORT_PATH)(
      new Request(`http://host${TRANSFER_IMPORT_PATH}?name=big.bin`, {
        method: 'POST',
        body: requestBody(big),
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )
    expect(response.status).toBe(200)
    const { jobId } = await response.json() as { jobId: string }
    expect((await awaitDone(routes, jobId))['state']).toBe('failed')
  })

  it('fails uploads whose body errors mid-flight', async () => {
    const { routes } = await buildPlugin()
    const response = await routeHandler(routes, TRANSFER_IMPORT_PATH)(
      erroringBodyRequest(`http://host${TRANSFER_IMPORT_PATH}`, null),
    )
    expect(response.status).toBe(500)
    expect((await response.json())['code']).toBe('transfer-failed')
  })

  it('answers 499 when the upload is cancelled mid-body', async () => {
    const { routes } = await buildPlugin()
    const response = await routeHandler(routes, TRANSFER_IMPORT_PATH)(
      erroringBodyRequest(`http://host${TRANSFER_IMPORT_PATH}`, new AbortController()),
    )
    expect(response.status).toBe(499)
  })

  it('answers busy for a second upload while one import runs', async () => {
    const { routes, stores } = await buildPlugin()
    // Park the first import inside persistence.create.
    let release: (() => void) | undefined
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    stores.parkCreate.current = parked
    const firstArchive = await importArchiveBytes('Parked', false)
    const first = await routeHandler(routes, TRANSFER_IMPORT_PATH)(
      new Request(`http://host${TRANSFER_IMPORT_PATH}?name=first.zip`, {
        method: 'POST',
        body: requestBody(firstArchive),
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )
    expect(first.status).toBe(200)
    const { jobId } = await first.json() as { jobId: string }
    await waitForJobPhase(routes, jobId, 'restoring')
    const second = await routeHandler(routes, TRANSFER_IMPORT_PATH)(
      new Request(`http://host${TRANSFER_IMPORT_PATH}`, {
        method: 'POST',
        body: requestBody(firstArchive),
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )
    expect(second.status).toBe(409)
    expect((await second.json())['code']).toBe('busy')
    release?.()
    const snapshot = await awaitDone(routes, jobId)
    expect(snapshot['state']).toBe('done')
  })

  it('reports a failed import through the poll route with the typed code', async () => {
    const { routes } = await buildPlugin()
    const bad = zipSync({ 'plain.txt': text('x') }, { level: 6 })
    const response = await routeHandler(routes, TRANSFER_IMPORT_PATH)(
      new Request(`http://host${TRANSFER_IMPORT_PATH}?name=bad.zip`, {
        method: 'POST',
        body: requestBody(Buffer.from(bad)),
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )
    expect(response.status).toBe(200)
    const { jobId } = await response.json() as { jobId: string }
    const snapshot = await awaitDone(routes, jobId)
    expect(snapshot['state']).toBe('failed')
    expect(snapshot['error']).toMatchObject({ code: 'bad-manifest' })
  })

  it('starts and fails a job for an empty upload body', async () => {
    const { routes } = await buildPlugin()
    const response = await routeHandler(routes, TRANSFER_IMPORT_PATH)(
      new Request(`http://host${TRANSFER_IMPORT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )
    expect(response.status).toBe(200)
    const { jobId } = await response.json() as { jobId: string }
    const snapshot = await awaitDone(routes, jobId)
    expect(snapshot['state']).toBe('failed')
    expect(snapshot['error']).toMatchObject({ code: 'bad-archive' })
  })

  it('answers settings uploads whose body cannot be read', async () => {
    const { routes } = await buildPlugin()
    const response = await routeHandler(routes, TRANSFER_SETTINGS_PATH)(
      erroringBodyRequest(`http://host${TRANSFER_SETTINGS_PATH}`, null),
    )
    expect(response.status).toBe(400)
    expect((await response.json())['code']).toBe('settings-format')
  })

  it('finishes a combined import with its settings outcomes on the snapshot', async () => {
    const { routes, home } = await buildPlugin()
    const archive = zipSync({
      '.prism-transfer.json': text(`${JSON.stringify({
        format: 'prism-transfer', version: 1, exportedAt: 't', settings: true,
        projects: [{ dir: '1-Alpha', title: 'Alpha', sessions: 0 }],
      })}\n`),
      'projects/1-Alpha/.prism-project.json': text(`${JSON.stringify({
        format: 'prism-project', version: 1, title: 'Alpha', exportedAt: 't', sessions: 0, hasProjectFolder: false,
      })}\n`),
      'settings.json': text(`${JSON.stringify({
        format: 'prism-settings', version: 1, exportedAt: 't', includeSecrets: false,
        namespaces: { web: { endpoint: '/restored' } },
      })}\n`),
    }, { level: 6 })
    const response = await routeHandler(routes, TRANSFER_IMPORT_PATH)(
      new Request(`http://host${TRANSFER_IMPORT_PATH}?dest=${encodeURIComponent(home)}&name=combined.zip`, {
        method: 'POST',
        body: requestBody(Buffer.from(archive)),
        headers: { 'content-type': 'application/octet-stream' },
      }),
    )
    expect(response.status).toBe(200)
    const { jobId } = await response.json() as { jobId: string }
    const snapshot = await awaitDone(routes, jobId)
    const result = snapshot['result'] as { settings?: unknown[] }
    expect(result.settings).toEqual([{ ns: 'web', outcome: 'applied' }])
  })
})

/** Build one minimal valid single-project archive with a project folder. */
function spoolImportArchive(): Uint8Array {
  return importArchiveBytes('Route Import', true)
}

/** Build one minimal valid single-project archive, with or without a folder. */
function importArchiveBytes(title: string, withFolder: boolean): Uint8Array {
  return zipSync({
    '.prism-project.json': text(`${JSON.stringify({
      format: 'prism-project', version: 1, title, exportedAt: 't',
      sessions: 0, hasProjectFolder: withFolder,
    })}\n`),
    ...(withFolder ? { 'project/data.txt': text('data') } : {}),
    // One restorable session so the import reaches the stored-write step.
    [`sessions/park-1/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]: text(`${JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: 'park-1', createdAt: 1000, isSeeded: false, delegationDepth: 0,
    })}\n${JSON.stringify({ type: 'turn/start', seq: 0, time: 2000, data: { turn: 1 } })}\n`),
  }, { level: 6 })
}

/** A POST whose body stream errors partway, optionally on an aborted signal. */
function erroringBodyRequest(url: string, controller: AbortController | null): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(pull) {
      pull.enqueue(new Uint8Array([1, 2, 3]))
      queueMicrotask(() => {
        if (controller !== null) controller.abort()
        pull.error(new Error('wire failed'))
      })
    },
  })
  return new Request(url, {
    method: 'POST',
    body: stream,
    ...(controller !== null ? { signal: controller.signal } : {}),
    headers: { 'content-type': 'application/octet-stream' },
    duplex: 'half',
  } as RequestInit)
}

/** Poll one job until it reaches the given phase. */
async function waitForJobPhase(
  routes: Map<string, (request: Request) => Promise<Response>>,
  jobId: string,
  phase: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = await (await routeHandler(routes, TRANSFER_JOB_PATH)(
      new Request(`http://host${TRANSFER_JOB_PATH}?jobId=${encodeURIComponent(jobId)}`),
    )).json() as Record<string, unknown>
    if (snapshot['phase'] === phase || snapshot['state'] !== 'running') return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`import job never reached ${phase}`)
}
