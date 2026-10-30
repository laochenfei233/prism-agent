/** The mounted Host plugin: route registration, lazy history, and a real run end to end. */

import { readdir, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { apply, BACKUP_ROUTE_PATH, Config } from '../src/index.ts'
import type { BackupResponse, BackupRunRecord, BackupState } from '../src/types.ts'

const roots: string[] = []

/**
 * Build one throwaway Harness home with a memory record.
 * @returns the home path.
 */
async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'prism-backup-plugin-'))
  roots.push(home)
  await mkdir(join(home, 'storages', 'prism_memory', 'records'), { recursive: true })
  await writeFile(join(home, 'storages', 'prism_memory', 'records', 'mem_1.json'), '{}', 'utf8')
  return home
}

/** A storage domain double keeping records in a map. */
function domainDouble(): { records: Map<string, unknown>; open: () => Promise<unknown> } {
  const records = new Map<string, unknown>()
  return {
    records,
    open: async () => ({
      table: () => ({
        entries: () => [...records.entries()][Symbol.iterator](),
        put: async (key: string, value: unknown) => { records.set(key, value) },
        delete: async (key: string) => records.delete(key),
      }),
    }),
  }
}

/**
 * Mount the plugin over doubles.
 * @param options - home, target overrides, and the stored password.
 * @returns the registered route, the domain double, and the mount context.
 */
async function mount(options: {
  home: string
  section?: Record<string, unknown>
  password?: string
  profilePatch?: string
}): Promise<{ route: ConnectionFetchRoute; domain: ReturnType<typeof domainDouble>; ctx: Context }> {
  const ctx = new Context()
  let route: ConnectionFetchRoute | undefined
  ctx.provide('connection', {
    fetch: {
      register: (registered: ConnectionFetchRoute) => {
        route = registered
        return async () => {}
      },
    },
  })
  const domain = domainDouble()
  ctx.provide('storageDomain', { open: domain.open })
  ctx.provide('credentials', {
    resolve: async () => options.password === undefined ? undefined : { value: options.password, source: 'file' },
  })
  if (options.profilePatch !== undefined) {
    ctx.provide('profileContext', { name: 'web', dir: options.home, patchPath: options.profilePatch, home: options.home })
  }
  apply(ctx, Config({
    targetType: 'smb',
    smbPath: join(options.home, 'remote'),
    ...options.section,
  }))
  if (route === undefined) throw new Error('the plugin registered no route')
  return { route, domain, ctx }
}

/**
 * POST one action to the mounted route.
 * @param route - the registered route.
 * @param action - action name.
 * @returns the parsed envelope and status.
 */
async function call<T>(route: ConnectionFetchRoute, action: string): Promise<{ value: BackupResponse<T>; status: number }> {
  const response = await route.fetch(new Request(`http://host${BACKUP_ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  }))
  return { value: await response.json() as BackupResponse<T>, status: response.status }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  delete process.env.DSH_HOME
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('mounted backup plugin', () => {
  it('registers one POST route with the expected shape', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    const { route, ctx } = await mount({ home })
    expect(route.path).toBe(BACKUP_ROUTE_PATH)
    expect(route.methods).toEqual(['POST'])
    expect(route.requestBody).toBe('buffered')
    await ctx.fiber.dispose()
  })

  it('runs an SMB backup through the mounted route and keeps the record', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    const { route, domain, ctx } = await mount({ home, section: { maxBackups: 5 } })

    const started = await call<BackupRunRecord>(route, 'run')
    expect(started.status).toBe(200)
    const record = (started.value as { value: BackupRunRecord }).value
    expect(record.status).toBe('success')
    expect(record.counts.memoryFiles).toBe(1)
    const remote = join(home, 'remote', 'prism-backup')
    expect(await readdir(remote)).toEqual([record.archiveName])
    expect(domain.records.size).toBe(1)

    const state = await call<BackupState>(route, 'state')
    expect((state.value as { value: BackupState }).value.history).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('answers a WebDAV run with the stored credential and cleans the staging file', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
      return new Response(null, { status: 200 })
    })
    const { route, ctx } = await mount({
      home,
      password: 'pw',
      section: { targetType: 'webdav', webdavUrl: 'https://dav.example.com/base' },
    })
    const started = await call<BackupRunRecord>(route, 'run')
    expect(started.status).toBe(200)
    expect(calls[0]).toMatch(/^PUT https:\/\/dav\.example\.com\/base\/prism-backup\/prism-backup-/u)
    const staging = join(home, 'cache', 'backups')
    expect(await readdir(staging)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('archives the active profile patch when the launcher supplied one', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(patch, 'row: 1')
    const { route, ctx } = await mount({ home, profilePatch: patch })
    const started = await call<BackupRunRecord>(route, 'run')
    expect((started.value as { value: BackupRunRecord }).value.counts.settings).toBe(1)
    await ctx.fiber.dispose()
  })

  it('records a failure that happens before the archive exists', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    // The staging directory lives under `cache`; a file there makes its creation fail.
    await writeFile(join(home, 'cache'), 'not a directory')
    const { route, ctx } = await mount({ home })
    const failed = await call<BackupRunRecord>(route, 'run')
    expect(failed.status).toBe(502)
    expect(failed.value).toMatchObject({ ok: false, error: { code: 'prism-backup/failed' } })
    const state = await call<BackupState>(route, 'state')
    expect((state.value as { value: BackupState }).value.history[0]).toMatchObject({
      status: 'failed',
      counts: { settings: 0, memoryFiles: 0, projects: 0, projectFiles: 0 },
    })
    await ctx.fiber.dispose()
  })

  it('mounts even when the history store cannot open', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    const ctx = new Context()
    let route: ConnectionFetchRoute | undefined
    ctx.provide('connection', {
      fetch: {
        register: (registered: ConnectionFetchRoute) => {
          route = registered
          return async () => {}
        },
      },
    })
    ctx.provide('storageDomain', { open: async () => { throw 'corrupt history' } })
    ctx.provide('credentials', { resolve: async () => undefined })
    apply(ctx, Config({ targetType: 'smb', smbPath: home }))
    expect(route).toBeDefined()
    const state = await call<BackupState>(route as ConnectionFetchRoute, 'state')
    expect(state.value).toMatchObject({ ok: true, value: { running: false, history: [] } })
    await ctx.fiber.dispose()

    const errorCtx = new Context()
    errorCtx.provide('connection', { fetch: { register: () => async () => {} } })
    errorCtx.provide('storageDomain', { open: async () => { throw new Error('corrupt history') } })
    errorCtx.provide('credentials', { resolve: async () => undefined })
    apply(errorCtx, Config({ targetType: 'smb', smbPath: home }))
    await Promise.resolve()
    await errorCtx.fiber.dispose()
  })

  it('answers the connection probe through the mounted route', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    const { route, ctx } = await mount({ home, section: { smbPath: home } })
    const probe = await call<{ message: string }>(route, 'test')
    expect(probe.status).toBe(200)
    expect((probe.value as { value: { message: string } }).value.message).toMatch(/is writable/u)
    await ctx.fiber.dispose()
  })

  it('reports a half-configured target as a 502 with the not-configured code', async () => {
    const home = await tempHome()
    process.env.DSH_HOME = home
    const { route, ctx } = await mount({ home, section: { targetType: 'webdav', webdavUrl: '' } })
    const failed = await call<BackupRunRecord>(route, 'run')
    expect(failed.status).toBe(502)
    expect(failed.value).toMatchObject({ ok: false, error: { code: 'prism-backup/not-configured' } })
    await ctx.fiber.dispose()
  })
})
