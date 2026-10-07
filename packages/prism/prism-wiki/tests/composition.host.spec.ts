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
 * @returns the booted context, owned by the caller.
 */
async function boot(vaultRoot: string): Promise<Context> {
  const root = await scratch('composition')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '- id: commands',
    "  name: '@deepseek-ai/dsh-commands'",
    '- id: prism-wiki',
    "  name: '@prism-ai/prism-wiki'",
    '  config:',
    `    vaultRoot: ${JSON.stringify(vaultRoot)}`,
    '- id: tool-prism-wiki',
    "  name: '@prism-ai/prism-wiki/tools'",
    '- id: command-prism-wiki',
    "  name: '@prism-ai/prism-wiki/commands'",
    '',
  ].join('\n'))

  const ctx = new Context()
  owned.add(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@prism-ai/prism-wiki', PrismWiki],
    ['@prism-ai/prism-wiki/tools', WikiTools],
    ['@prism-ai/prism-wiki/commands', WikiCommands],
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
})
