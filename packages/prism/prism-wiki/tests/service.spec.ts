/**
 * The vault service's own seams: the schema-debt pre-step listener and its
 * switches, the source-integration check, the status tail, the character caps,
 * and the search cache lifecycle.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import {
  callTool, createAgent, mountVault, mountWiki, proposeStep, schemaFrames, valueJson, writePage,
} from './fixtures/harness.ts'
import type { VaultMountOptions } from './fixtures/harness.ts'

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
  const dir = await mkdtemp(join(tmpdir(), 'prism-wiki-service-'))
  vaults.add(dir)
  return dir
}

/** Boot the vault service over one fresh vault, with the caller's config. */
async function boot(config: VaultMountOptions['config'] = {}): Promise<{ readonly ctx: Context; readonly root: string }> {
  const root = await scratchVault()
  const ctx = new Context()
  owned.add(ctx)
  await mountVault(ctx, { vaultRoot: root, config })
  return { ctx, root }
}

/** Boot the vault service together with its tool row, with the caller's config. */
async function bootWiki(config: VaultMountOptions['config'] = {}): Promise<{ readonly ctx: Context; readonly root: string }> {
  const root = await scratchVault()
  const ctx = await mountWiki({ vaultRoot: root, config })
  owned.add(ctx)
  return { ctx, root }
}

/** One pre-step event payload, with an optional caller-supplied signal. */
function stepPayload(signal = new AbortController().signal) {
  return {
    messages: [],
    turn: 1,
    step: 1,
    signal,
    modelSelection: { provider: 'prism-wiki-test', model: 'prism-wiki-test' },
  }
}

describe('the schema-debt pre-step listener', () => {
  it('yields to a step the pipeline rejected', async () => {
    const { ctx } = await boot()
    const agent = createAgent('service-reject')
    ctx.wikiVault.noteSchemaDue(agent)

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      stepPayload(),
      async () => ({ kind: 'reject' as const }),
    )

    expect(decision.kind).toBe('reject')
  })

  it('yields to a step whose signal is already aborted', async () => {
    const { ctx } = await boot()
    const agent = createAgent('service-aborted')
    ctx.wikiVault.noteSchemaDue(agent)

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      stepPayload(AbortSignal.abort()),
      async () => ({ kind: 'enter' as const, messages: [] }),
    )

    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('owes nothing to a call without an agent', async () => {
    const { ctx } = await boot()
    const agent = createAgent('service-no-agent')

    ctx.wikiVault.noteSchemaDue(undefined)

    expect(schemaFrames(await proposeStep(ctx, agent))).toEqual([])
  })

  it('skips the frame when the deployment disabled schema delivery', async () => {
    const { ctx } = await boot({ schemaDeliveryEnabled: false })
    const agent = createAgent('service-delivery-off')

    ctx.wikiVault.noteSchemaDue(agent)

    expect(schemaFrames(await proposeStep(ctx, agent))).toEqual([])
  })

  it('never marks a session that already received the frame', async () => {
    const { ctx } = await boot()
    const agent = createAgent('service-once')

    ctx.wikiVault.noteSchemaDue(agent)
    expect(schemaFrames(await proposeStep(ctx, agent))).toHaveLength(1)
    ctx.wikiVault.noteSchemaDue(agent)

    expect(schemaFrames(await proposeStep(ctx, agent))).toEqual([])
  })
})

describe('vault operations', () => {
  it('refuses to confirm a source the vault does not hold', async () => {
    const { ctx } = await bootWiki()
    const agent = createAgent('service-confirm-missing')

    const refused = await callTool(ctx, 'wiki_source', { action: 'integrate', path: 'notes/ghost.md' }, agent)

    expect(valueJson(refused)).toContain('PRISM_WIKI_SOURCE_NOT_FOUND')
  })

  it('reports no log entry for a vault that never wrote one', async () => {
    const { ctx } = await boot()

    const status = await ctx.wikiVault.status()

    expect(status.pages).toBe(0)
    expect(status.lastLogEntry).toBeNull()
  })

  it('refuses a page body beyond the configured cap', async () => {
    const { ctx } = await bootWiki({ maxPageChars: 10 })
    const agent = createAgent('service-page-cap')

    const refused = await writePage(ctx, agent, {
      path: 'concepts/long.md', title: 'Long', type: 'concept', body: '0123456789A',
    })

    expect(valueJson(refused)).toContain('PRISM_WIKI_TOO_LARGE')
  })

  it('refuses a source beyond the configured cap', async () => {
    const { ctx } = await bootWiki({ maxSourceChars: 10 })
    const agent = createAgent('service-source-cap')

    const refused = await callTool(ctx, 'wiki_source', {
      action: 'add', path: 'notes/long.md', text: '0123456789A',
    }, agent)

    expect(valueJson(refused)).toContain('PRISM_WIKI_TOO_LARGE')
  })

  it('closes the search cache when the service is disposed', async () => {
    const { ctx, root } = await bootWiki()
    const agent = createAgent('service-close')
    await writePage(ctx, agent, { path: 'concepts/one.md', title: 'One', type: 'concept', body: 'One body.' })
    await ctx.wikiVault.search('body', { limit: 5 })
    await ctx.fiber.dispose()
    owned.delete(ctx)

    // The cache file stays on disk under the vault, now closed by the disposal.
    expect((await stat(join(root, '.wiki', 'index.db'))).isFile()).toBe(true)
  })
})
