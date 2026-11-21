/**
 * REAL-composition coverage for prism-wiki.
 *
 * The unit suites mount the plugin's rows by hand; this one boots a test-only
 * `cordis.yml` carrying the shipped rows through the vendored Loader, so the
 * facts only a real composition can show are the ones asserted: the rows
 * resolve each other, a page written through the model-facing tool path lands
 * on disk under the `vaultRoot` the file configured, and an assembled request
 * carries both the wiki protocol section and the five tool schemas.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import {
  WIKI_TOOL_NAMES,
  callTool,
  commandText,
  createAgent,
  runCommand,
  toolText,
  valueJson,
  wikiToolNames,
} from './fixtures/harness.ts'
import * as PrismWiki from '../src/index.ts'
import * as WikiTools from '../src/tools.ts'
import * as WikiCommands from '../src/commands.ts'
import * as WikiWeb from '../src/web.ts'

const owned = new Set<Context>()
const directories = new Set<string>()

afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
  await Promise.all([...directories].map(dir => rm(dir, { recursive: true, force: true })))
  directories.clear()
})

/** One empty directory this suite owns. */
async function scratch(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `prism-wiki-${name}-`))
  directories.add(dir)
  return dir
}

/** Import mapped source modules without claiming support for Node's HMR internals. */
function sourceModuleLoader(importModule: (specifier: string) => Promise<unknown>): ModuleLoaderV2 {
  return {
    version: 'v2',
    import: importModule,
    loadCache: new Map(),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
}

/**
 * Boot the shipped rows from a test-only `cordis.yml` through the real Loader.
 * @param vaultRoot - the vault directory the service row is configured with.
 * @param options - `web` adds the browser row over a real Connection, the way a
 * profile with a web client composes it.
 * @returns the booted context, owned by the caller.
 */
async function boot(vaultRoot: string, options: { readonly web?: boolean } = {}): Promise<Context> {
  const root = await scratch('composition')
  const configPath = join(root, 'cordis.yml')
  const rows = [
    '- id: prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '- id: commands',
    "  name: '@deepseek-ai/dsh-commands'",
    '- id: prism-wiki',
    "  name: '@prism/prism-wiki'",
    '  config:',
    `    vaultRoot: ${JSON.stringify(vaultRoot)}`,
    '- id: tool-prism-wiki',
    "  name: '@prism/prism-wiki/tools'",
    '- id: command-prism-wiki',
    "  name: '@prism/prism-wiki/commands'",
  ]
  if (options.web === true) {
    rows.push(
      '- id: connection',
      "  name: '@deepseek-ai/dsh-client-connection'",
      '- id: web-prism-wiki',
      "  name: '@prism/prism-wiki/web'",
    )
  }
  await writeFile(configPath, [...rows, ''].join('\n'))

  const ctx = new Context()
  owned.add(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  if (options.web === true) {
    // Connection mounts its `/api` route on the Web server and signs browser
    // sessions from the credential provider; dispatch through the exact Fetch
    // registry this suite uses touches neither beyond the shape below.
    ctx.provide('credentials', {
      modifyRecord: async () => ({
        kind: 'grant',
        payload: { version: 1, secret: Buffer.alloc(32, 7).toString('base64url') },
      }),
    })
    ctx.provide('webServer', { register: () => () => {} })
  }
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@prism/prism-wiki', PrismWiki],
    ['@prism/prism-wiki/tools', WikiTools],
    ['@prism/prism-wiki/commands', WikiCommands],
    ['@prism/prism-wiki/web', WikiWeb],
  ])
  ctx.loader.internal = sourceModuleLoader(async (specifier) => {
    if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
    return modules.get(specifier)
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

describe('prism-wiki real Loader composition', () => {
  it('serves the vault, the five tools, and /wiki from the configured rows', async () => {
    const vaultRoot = await scratch('surfaces')
    const ctx = await boot(vaultRoot)
    const agent = createAgent('composition-surfaces')

    expect(ctx.wikiVault.vaultRoot()).toBe(vaultRoot)
    expect(wikiToolNames(ctx)).toEqual([...WIKI_TOOL_NAMES])
    expect(ctx.commands.list(agent).map(command => command.name)).toEqual(['wiki'])
  })

  it('lands a page written through the model-facing tool path under the configured vaultRoot', async () => {
    const vaultRoot = await scratch('write')
    const ctx = await boot(vaultRoot)
    const agent = createAgent('composition-write')

    const written = await callTool(ctx, 'wiki_write', {
      path: 'concepts/composed.md',
      title: 'Composed page',
      type: 'concept',
      body: 'The model wrote this page through the composed tool row.',
      tags: ['composition'],
    }, agent)

    expect(written.isError).toBe(false)
    expect(valueJson(written)).toContain('"created":true')
    expect(toolText(written)).toContain('Created concepts/composed.md')

    // Durable: the page and the two derived files exist under the configured root.
    const page = await readFile(join(vaultRoot, 'wiki', 'concepts', 'composed.md'), 'utf8')
    expect(page).toContain('title: Composed page')
    expect(page).toContain('The model wrote this page through the composed tool row.')
    expect(await readFile(join(vaultRoot, 'AGENTS.md'), 'utf8')).toContain('# Wiki schema')
    expect(await readFile(join(vaultRoot, 'index.md'), 'utf8')).toContain('Composed page')
    expect(await readFile(join(vaultRoot, 'log.md'), 'utf8')).toContain('concepts/composed.md Composed page')

    // Model-visible on the way back out, and user-visible through the command row.
    const read = await callTool(ctx, 'wiki_read', { path: 'concepts/composed.md' }, agent)
    expect(toolText(read)).toContain('The model wrote this page through the composed tool row.')
    expect(commandText(await runCommand(ctx, agent, '/wiki status'))).toContain('pages: 1')
  })

  it('carries the wiki protocol section and the five tool schemas into an assembled request', async () => {
    const ctx = await boot(await scratch('request'))
    const agent = createAgent('composition-request')

    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))

    const protocol = assembly.sections.find(section => section.name === 'prism-wiki')?.text ?? ''
    expect(protocol).not.toBe('')
    expect(protocol).toContain('immutable sources')
    expect(protocol).toBe(PrismWiki.DEFAULT_PROTOCOL)
    expect(assembly.tools.map(tool => tool.name).filter(name => name.startsWith('wiki_')).sort())
      .toEqual([...WIKI_TOOL_NAMES])
  })

  it('serves every browser route from the shipped rows over the real Connection', async () => {
    const vaultRoot = await scratch('web')
    const ctx = await boot(vaultRoot, { web: true })
    const agent = createAgent('composition-web')
    const shared = ctx.connection.createSharedFetchHandler('/api')
    /** Send one browser request to a wiki route and read its envelope. */
    const post = async (
      endpoint: string,
      body: unknown,
    ): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> => {
      const response = await shared.fetch(new Request(`http://127.0.0.1/api/prism-wiki/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }))
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }

    // One page and one raw source, written the way the model writes them.
    const written = await callTool(ctx, 'wiki_write', {
      path: 'concepts/route.md',
      title: 'Route page',
      type: 'concept',
      body: 'Route body about routers.',
      tags: ['route'],
      sources: ['notes/router.md'],
    }, agent)
    expect(written.isError).toBe(false)
    const added = await callTool(ctx, 'wiki_source', {
      action: 'add',
      path: 'notes/router.md',
      text: 'The raw router note.',
    }, agent)
    expect(added.isError).toBe(false)

    // Every route the page calls answers over the composed Connection.
    expect(JSON.stringify((await post('list', {})).body)).toContain('concepts/route.md')
    expect(JSON.stringify((await post('read', { path: 'concepts/route.md' })).body))
      .toContain('Route body about routers.')
    expect(JSON.stringify((await post('search', { query: 'routers' })).body)).toContain('concepts/route.md')
    const source = await post('source', { path: 'notes/router.md' })
    expect(source.status).toBe(200)
    expect(JSON.stringify(source.body)).toContain('The raw router note.')

    // A browser save is visible to the model-facing read: one vault, not two.
    const read = await post('read', { path: 'concepts/route.md' })
    const revision = (read.body['value'] as { page: { revision: string } }).page.revision
    const saved = await post('save', {
      path: 'concepts/route.md',
      frontmatter: {
        title: 'Route page',
        type: 'concept',
        tags: ['route'],
        updated: '2026-11-21',
        status: 'current',
        sources: ['notes/router.md'],
      },
      body: 'Rewritten from the browser.',
      expectedRevision: revision,
    })
    expect(saved.status).toBe(200)
    expect(toolText(await callTool(ctx, 'wiki_read', { path: 'concepts/route.md' }, agent)))
      .toContain('Rewritten from the browser.')

    const lint = await post('lint', {})
    expect(lint.status).toBe(200)
    expect(JSON.stringify(lint.body)).toContain('"pages":1')
  })
})
