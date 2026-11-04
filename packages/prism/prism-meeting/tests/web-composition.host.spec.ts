/**
 * Real Loader composition for the browser row: `prism-meeting-web` must
 * activate over a real WebServer and the real Connection service, and must
 * stay PENDING — never fail — in a profile that composes neither.
 *
 * Hand-mounted contexts cannot cover this: they supply `inject` themselves,
 * so they never exercise how the Loader builds the entry's fiber or how a
 * service getter resolves against the caller's context.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as web from '../src/web.ts'

/** The entry id every case loads. */
const ENTRY = '@prism-ai/prism-meeting/web'

/**
 * `FiberState` values from `vendor/cordis/src/fiber.ts`. It is a `const enum`,
 * so it has no runtime export to import.
 */
const FIBER_PENDING = 0
const FIBER_ACTIVE = 2

/** A credentials provider holding records in memory, enough for BrowserAuth. */
function credentialsStub(): unknown {
  const records = new Map<string, unknown>()
  return {
    modifyRecord: async (key: string, mutate: (current: unknown) => Promise<unknown>) => {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
    resolve: () => Promise.resolve(undefined),
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot one Loader composition from a cordis.yml body.
 * @param rows - entry rows the profile composes, in order.
 * @returns the lifecycle state of each composed entry, in profile order.
 */
async function boot(rows: readonly string[]): Promise<number[]> {
  root = await mkdtemp(join(tmpdir(), 'dsh-prism-meeting-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...rows, ''].join('\n'))
  await writeFile(join(root, 'meeting-stub.mjs'), [
    'export const name = "meeting-stub"',
    'export function apply(ctx) {',
    '  ctx.provide("meetingMinutes", {',
    '    list: () => [],',
    '    get: () => { throw new Error("the composition probe reads no meeting") },',
    '    speech: () => ({ providers: [], selected: "" }),',
    '  })',
    '}',
    '',
  ].join('\n'))

  const booted = new Context()
  context = booted
  booted.baseUrl = pathToFileURL(root).href + '/'
  booted.provide('credentials', credentialsStub())
  await booted.plugin(Loader)
  booted.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
    [ENTRY, web],
  ])
  booted.loader.internal = {
    version: 'v2',
    async import(specifier: string): Promise<unknown> {
      if (specifier === './meeting-stub.mjs') return import(pathToFileURL(join(root!, 'meeting-stub.mjs')).href)
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof booted.loader.internal>
  await booted.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await booted.loader.await()
  return [...booted.loader.entries()]
    .filter(entry => entry.options.name === ENTRY)
    .map(entry => entry.fiber?.state ?? FIBER_PENDING)
}

/** The lifecycle states of the one entry that every case loads. */
async function entryStates(rows: readonly string[]): Promise<number[]> {
  await boot(rows)
  return [...context!.loader.entries()]
    .filter(entry => entry.options.name === ENTRY)
    .map(entry => entry.fiber?.state ?? FIBER_PENDING)
}

describe('prism-meeting browser row through the real Loader', () => {
  it('activates the browser row over a real WebServer and Connection, and answers a route', async () => {
    const states = await entryStates([
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-client-connection'",
      "- name: './meeting-stub.mjs'",
      `- name: '${ENTRY}'`,
    ])
    expect(states).toEqual([FIBER_ACTIVE])
    const connection = context?.get('connection') as {
      createSharedFetchHandler: (channel: '/api') => { fetch: (request: Request) => Promise<Response> }
    }
    const response = await connection.createSharedFetchHandler('/api')
      .fetch(new Request('http://127.0.0.1/api/prism-meeting/list', { method: 'POST' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, value: { meetings: [] } })
  })

  it('stays pending rather than failing when the profile composes no Connection', async () => {
    const states = await entryStates([
      "- name: './meeting-stub.mjs'",
      `- name: '${ENTRY}'`,
    ])
    expect(states).toEqual([FIBER_PENDING])
  })

  it('stays pending rather than failing when a Connection has no web server', async () => {
    const states = await entryStates([
      "- name: '@deepseek-ai/dsh-client-connection'",
      "- name: './meeting-stub.mjs'",
      `- name: '${ENTRY}'`,
    ])
    expect(states).toEqual([FIBER_PENDING])
  })

  it('declares the web server alongside the connection', () => {
    expect(web.inject).toEqual(['meetingMinutes', 'connection', 'webServer'])
    expect(web.name).toBe('prism-meeting-web')
  })
})
