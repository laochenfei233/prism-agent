/**
 * The `/memory` operator command, driven end to end.
 *
 * Every case enters through the real command runtime and reads the settled
 * result text, so an assertion here is an assertion about what a person sees
 * after typing the line — not about a service method the command happens to
 * call.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAgent, mountMemory } from './fixtures/harness.ts'

const owned = new Set<Context>()
afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
})

/**
 * Mount the memory rows with the command registrant.
 * @param config - field overrides for the plugin's Config row.
 * @returns the live context, disposed by the suite.
 */
async function boot(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = await mountMemory({ config, commands: true })
  owned.add(ctx)
  return ctx
}

/** One settled invocation, reduced to the fields a spec asserts on. */
interface Settled {
  /** `success` or `error`, as the dispatching surface renders it. */
  readonly kind: string
  /** The text the surface shows. */
  readonly text: string
}

/**
 * Run one slash line through the real registry.
 * @param ctx - a context mounted by {@link boot}.
 * @param agent - the receiving agent.
 * @param line - the complete slash-command line.
 * @returns the settled result.
 */
async function run(ctx: Context, agent: Agent, line: string): Promise<Settled> {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`the command did not resolve: ${line}`)
  return { kind: execution.result.kind, text: execution.result.text ?? '' }
}

describe('the /memory command', () => {
  it('is registered under its own definition identity', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'registered')
    expect(ctx.commands.find(agent, 'memory')?.name).toBe('memory')
  })

  it('stores an operator claim and finds it again by keyword', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'remember')

    const stored = await run(ctx, agent, '/memory remember the staging credentials rotate on the first monday')
    expect(stored.kind).toBe('success')
    expect(stored.text).toContain('Stored:')

    const record = ctx.prismMemory.all()[0]
    expect(record?.origin).toBe('operator')
    expect(record?.status).toBe('active')

    const found = await run(ctx, agent, '/memory search staging credentials')
    expect(found.kind).toBe('success')
    expect(found.text).toContain('staging credentials rotate on the first monday')
    expect(found.text).toContain(record?.id ?? 'missing-id')
  })

  it('reports the claim it already holds instead of storing it twice', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'remember-twice')
    const line = '/memory remember the staging credentials rotate on the first monday'

    await run(ctx, agent, line)
    const again = await run(ctx, agent, line)
    expect(again.text).toContain('An identical claim already stood')
    expect(ctx.prismMemory.all()).toHaveLength(1)
  })

  it('lists the most recent claims when the query is empty', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'recent')
    await run(ctx, agent, '/memory remember the nightly job runs at 02:00')

    const listed = await run(ctx, agent, '/memory search')
    expect(listed.kind).toBe('success')
    expect(listed.text).toContain('Most recent claims, newest first:')
    expect(listed.text).toContain('the nightly job runs at 02:00')
  })

  it('rejects an empty remember with the usage text', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'empty-remember')

    const refused = await run(ctx, agent, '/memory remember')
    expect(refused.kind).toBe('error')
    expect(refused.text).toContain('Usage: /memory <subcommand>')
    expect(ctx.prismMemory.all()).toEqual([])
  })

  it('keeps the pre-existing status report as the default subcommand', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'status')
    await run(ctx, agent, '/memory remember the domain stays at version 1')

    const report = await run(ctx, agent, '/memory')
    expect(report.kind).toBe('success')
    expect(report.text).toContain('visible 1 record(s)')
  })
})
