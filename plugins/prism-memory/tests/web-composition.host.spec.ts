/**
 * Real Loader composition for the browser row: `prism-memory-web` must activate
 * over a real WebServer and the real Connection service, and must stay PENDING —
 * never fail — in a profile that composes neither.
 *
 * Hand-mounted contexts cannot cover this: they supply `inject` themselves, so
 * they never exercise how the Loader builds the entry's fiber or how a service
 * getter resolves against the caller's context.
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
const ENTRY = '@prism/prism-memory/web'

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
 * @returns the fiber states of the browser row's entries.
 */
async function entryStates(rows: readonly string[]): Promise<number[]> {
  root = await mkdtemp(join(tmpdir(), 'dsh-prism-memory-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...rows, ''].join('\n'))
  // The composition probe reads the corpus, so the stub answers the one
  // operator read the overview route performs.
  await writeFile(join(root, 'memory-stub.mjs'), [
    'export const name = "memory-stub"',
    'export function apply(ctx) {',
    '  ctx.provide("prismMemory", { operatorRecords: () => [] })',
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
    async import(specifier: string) {
      if (specifier === './memory-stub.mjs') return import(pathToFileURL(join(root!, 'memory-stub.mjs')).href)
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

describe('prism-memory browser row through the real Loader', () => {
  it('activates over a real WebServer and Connection, and answers a route', async () => {
    const states = await entryStates([
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-client-connection'",
      "- name: './memory-stub.mjs'",
      `- name: '${ENTRY}'`,
    ])
    expect(states).toEqual([FIBER_ACTIVE])
    const connection = context?.get('connection') as {
      createPeer: (options: { principal: { kind: 'owner' } }) => unknown
      createSharedFetchHandler: (channel: '/api') => {
        fetch: (request: Request, peer: unknown) => Promise<Response>
      }
    }
    // Exact routes are reserved for the owner principal, so the probe dispatches
    // as one rather than as an anonymous peer.
    const peer = connection.createPeer({ principal: { kind: 'owner' } })
    const response = await connection.createSharedFetchHandler('/api')
      .fetch(new Request('http://127.0.0.1/api/prism-memory/overview', { method: 'POST', body: '{}' }), peer)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      value: {
        counts: { total: 0, byStatus: {}, byLayer: {} },
        pending: [],
        recent: [],
      },
    })
  })

  it('stays pending rather than failing when the profile composes no Connection', async () => {
    const states = await entryStates([
      "- name: './memory-stub.mjs'",
      `- name: '${ENTRY}'`,
    ])
    expect(states).toEqual([FIBER_PENDING])
  })

  it('stays pending rather than failing when a Connection has no web server', async () => {
    const states = await entryStates([
      "- name: '@deepseek-ai/dsh-client-connection'",
      "- name: './memory-stub.mjs'",
      `- name: '${ENTRY}'`,
    ])
    expect(states).toEqual([FIBER_PENDING])
  })

  it('declares the web server alongside the connection', () => {
    expect(web.inject).toEqual(['prismMemory', 'connection', 'webServer'])
    expect(web.name).toBe('prism-memory-web')
  })
})
