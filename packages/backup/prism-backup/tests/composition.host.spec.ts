/** The shipped composition: Loader boots the row by bare package name and the halves line up. */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'
import * as Backup from '../src/index.ts'
import type { BackupResponse, BackupRunRecord } from '../src/types.ts'

const roots: string[] = []

afterEach(async () => {
  delete process.env.DSH_HOME
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/**
 * Boot the package through the Loader from a composition file, the way the web
 * profile does.
 * @param section - the row's config.
 * @returns the live context, its recorded routes, and the temp root.
 */
async function boot(section: Record<string, unknown>): Promise<{
  ctx: Context
  routes: Map<string, { fetch: (request: Request) => Promise<Response> }>
  root: string
  records: Map<string, unknown>
}> {
  const root = await mkdtemp(join(tmpdir(), 'prism-backup-composition-'))
  roots.push(root)
  // The row resolves the Harness home from the environment; never read the real one.
  process.env.DSH_HOME = root
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@prism/prism-backup'",
    '  config:',
    ...Object.entries(section).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`),
    '',
  ].join('\n'))

  const routes = new Map<string, { fetch: (request: Request) => Promise<Response> }>()
  const records = new Map<string, unknown>()
  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; fetch: (request: Request) => Promise<Response> }) => {
        routes.set(route.path, route)
        return () => {
          routes.delete(route.path)
          return Promise.resolve()
        }
      },
    },
  } as never)
  ctx.provide('storageDomain', {
    open: async () => ({
      table: () => ({
        entries: () => [...records.entries()][Symbol.iterator](),
        put: async (key: string, value: unknown) => { records.set(key, value) },
        delete: async (key: string) => records.delete(key),
      }),
    }),
  } as never)
  ctx.provide('credentials', { resolve: async () => undefined } as never)

  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier !== '@prism/prism-backup') throw new Error(`unexpected Loader import: ${specifier}`)
      return Backup
    },
  } as never
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, routes, root, records }
}

/**
 * POST one action to the composed route.
 * @param routes - the routes Loader recorded.
 * @param action - action name.
 * @returns the parsed envelope.
 */
async function call<T>(
  routes: Map<string, { fetch: (request: Request) => Promise<Response> }>,
  action: string,
): Promise<BackupResponse<T>> {
  const route = routes.get('/api/prism.backup')
  if (route === undefined) throw new Error('the composed plugin registered no route')
  const response = await route.fetch(new Request('http://host/api/prism.backup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  }))
  return await response.json() as BackupResponse<T>
}

describe('shipped composition', () => {
  it('boots the row from its bare package name and registers the route', async () => {
    const remote = await mkdtemp(join(tmpdir(), 'prism-backup-composition-remote-'))
    roots.push(remote)
    const { ctx, routes } = await boot({ targetType: 'smb', smbPath: remote, remoteDir: 'nested' })
    expect([...routes.keys()]).toEqual(['/api/prism.backup'])
    await ctx.fiber.dispose()
    expect(routes.size).toBe(0)
  })

  it('applies the schema defaults the row leaves out and archives through the composed route', async () => {
    const remote = await mkdtemp(join(tmpdir(), 'prism-backup-composition-remote-'))
    roots.push(remote)
    const { ctx, routes, records } = await boot({ targetType: 'smb', smbPath: remote })
    // `maxBackups` and `remoteDir` come from the schema, not the row.
    const started = await call<BackupRunRecord>(routes, 'run')
    expect(started).toMatchObject({ ok: true })
    const written = (started as { ok: true; value: BackupRunRecord }).value
    expect(written.objectKey).toMatch(/^prism-backup\/prism-backup-\d{8}-\d{6}\.zip$/u)
    expect(await readdir(join(remote, 'prism-backup'))).toEqual([String(written.archiveName)])
    expect(records.size).toBe(1)
    await ctx.fiber.dispose()
  })

  it('declares the browser half on the row the Loader mounts', async () => {
    const manifest = JSON.parse(await readFileFromPackage('package.json')) as {
      dsh?: { client?: { platform?: string } }
      exports?: Record<string, unknown>
    }
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.exports?.['./client']).toBeDefined()
  })
})

/**
 * Read one package file relative to this test.
 * @param name - file name inside the package root.
 * @returns the file contents.
 */
async function readFileFromPackage(name: string): Promise<string> {
  return await readFile(new URL(`../${name}`, import.meta.url), 'utf8')
}
