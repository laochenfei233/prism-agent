/**
 * The `/wiki` operator command, driven through the real command registry.
 *
 * These cases assert what a person sees after typing the command: vault
 * counts, the health report, the schema the vault owns, the log, and one page
 * with its relations. The command is a registry contribution too, so its
 * removal on disposal is asserted alongside its results.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import {
  callTool,
  commandText,
  createAgent,
  mountVault,
  mountWiki,
  runCommand,
  valueJson,
  writePage,
} from './fixtures/harness.ts'
import * as WikiCommands from '../src/commands.ts'

const owned = new Set<Context>()
const vaults = new Set<string>()

afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
  await Promise.all([...vaults].map(dir => rm(dir, { recursive: true, force: true })))
  vaults.clear()
})

/** One empty directory this suite owns as a vault. */
async function scratchVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prism-wiki-commands-'))
  vaults.add(dir)
  return dir
}

/** Boot the plugin's real registries over one fresh vault. */
async function boot(): Promise<{ readonly ctx: Context; readonly root: string }> {
  const root = await scratchVault()
  const ctx = await mountWiki({ vaultRoot: root })
  owned.add(ctx)
  return { ctx, root }
}

/** Store one page and register one uncited source, so counts and findings are non-trivial. */
async function seed(ctx: Context, agent: Agent): Promise<void> {
  await writePage(ctx, agent, { path: 'concepts/one.md', title: 'One', type: 'concept', body: 'One body.' })
  await callTool(ctx, 'wiki_source', { action: 'add', path: 'notes/note.md', text: 'A note.' }, agent)
}

describe('the /wiki command', () => {
  it('reports the vault counts for status, and the same for an empty argument', async () => {
    const { ctx, root } = await boot()
    const agent = createAgent('commands-status')
    await seed(ctx, agent)

    const status = await runCommand(ctx, agent, '/wiki status')

    expect(status.kind).toBe('success')
    const text = commandText(status)
    expect(text).toContain(`vault: ${root}`)
    expect(text).toContain('pages: 1')
    expect(text).toContain('sources: 1 (1 not yet cited by any page)')
    expect(text).toMatch(/newest log entry: ## \[\d{4}-\d{2}-\d{2}\] write \| concepts\/one\.md One/u)
    // No subcommand is the status report, so `/wiki` and `/wiki status` agree.
    expect(await runCommand(ctx, agent, '/wiki')).toEqual(status)
  })

  it('reports the health pass for lint', async () => {
    const { ctx } = await boot()
    const agent = createAgent('commands-lint')
    await seed(ctx, agent)

    const lint = await runCommand(ctx, agent, '/wiki lint')

    expect(lint.kind).toBe('success')
    const text = commandText(lint)
    expect(text).toMatch(/^1 page\(s\), 1 source\(s\), 2 finding\(s\)/u)
    expect(text).toContain('orphan-page concepts/one.md')
    expect(text).toContain('unintegrated-source')
  })

  it('rebuilds the search cache for reindex', async () => {
    const { ctx } = await boot()
    const agent = createAgent('commands-reindex')
    await seed(ctx, agent)

    const reindex = await runCommand(ctx, agent, '/wiki reindex')

    expect(reindex).toEqual({ kind: 'success', text: 'Search cache discarded and rebuilt from the page files.' })
    // The rebuilt cache still answers, so the command left a usable index.
    expect(valueJson(await callTool(ctx, 'wiki_search', { query: 'body' }, agent))).toContain('concepts/one.md')
  })

  it('returns the vault\'s own AGENTS.md for schema', async () => {
    const root = await scratchVault()
    await writeFile(join(root, 'AGENTS.md'), '# House rules\n\nKeep pages short.\n', 'utf8')
    const ctx = await mountWiki({ vaultRoot: root })
    owned.add(ctx)
    const agent = createAgent('commands-schema')

    const schema = await runCommand(ctx, agent, '/wiki schema')

    expect(schema.kind).toBe('success')
    expect(commandText(schema)).toContain('Keep pages short.')
  })

  it('lists the newest log headings for log', async () => {
    const { ctx } = await boot()
    const agent = createAgent('commands-log')
    await seed(ctx, agent)

    const log = await runCommand(ctx, agent, '/wiki log')

    expect(log.kind).toBe('success')
    const text = commandText(log)
    expect(text).toContain('Newest first:')
    expect(text).toMatch(/## \[\d{4}-\d{2}-\d{2}\] write \| concepts\/one\.md One/u)
  })

  it('opens one page with its relations for open', async () => {
    const { ctx } = await boot()
    const agent = createAgent('commands-open')
    await seed(ctx, agent)

    const open = await runCommand(ctx, agent, '/wiki open concepts/one.md')

    expect(open.kind).toBe('success')
    const text = commandText(open)
    expect(text).toContain('concepts/one.md — One')
    expect(text).toMatch(/concept · current · updated \d{4}-\d{2}-\d{2} · confidence unstated/u)
    expect(text).toContain('One body.')
  })

  it('refuses open without a page and names the usage', async () => {
    const { ctx } = await boot()
    const agent = createAgent('commands-open-missing')

    const open = await runCommand(ctx, agent, '/wiki open')

    expect(open.kind).toBe('error')
    expect(commandText(open)).toContain('Usage: /wiki <subcommand>')
  })

  it('names the usage for an unknown subcommand', async () => {
    const { ctx } = await boot()
    const agent = createAgent('commands-unknown')

    const unknown = await runCommand(ctx, agent, '/wiki nonsense')

    expect(unknown.kind).toBe('error')
    const text = commandText(unknown)
    expect(text).toContain('unknown subcommand: nonsense')
    expect(text).toContain('Usage: /wiki <subcommand>')
  })

  it('removes the command when the contributing fiber is disposed', async () => {
    const ctx = new Context()
    owned.add(ctx)
    await mountVault(ctx, { vaultRoot: await scratchVault() })
    const fiber = await ctx.plugin(WikiCommands)
    const agent = createAgent('commands-hmr')
    expect(ctx.commands.list(agent).map(command => command.name)).toEqual(['wiki'])

    await fiber.dispose()

    expect(ctx.commands.list(agent)).toEqual([])
  })
})
