/**
 * The `/memory` operator command, driven end to end.
 *
 * Every case enters through the real command runtime and reads the settled
 * result text, so an assertion here is an assertion about what a person sees
 * after typing the line — not about a service method the command happens to
 * call.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { appendUser, createAgent, driveTurnStopping, mountMemory } from './fixtures/harness.ts'

const owned = new Set<Context>()
const directories = new Set<string>()
afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
  await Promise.all([...directories].map(dir => rm(dir, { recursive: true, force: true })))
  directories.clear()
})

/**
 * Mount the memory rows with the command registrant.
 * @param config - field overrides for the plugin's Config row.
 * @param options - optional rows, such as the session-query stub.
 * @returns the live context, disposed by the suite.
 */
async function boot(
  config: Record<string, unknown> = {},
  options: { readonly sessionQuery?: boolean } = {},
): Promise<Context> {
  const ctx = await mountMemory({ config, commands: true, ...options })
  owned.add(ctx)
  return ctx
}

/** One temporary directory a mirror can be written to, removed by the suite. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prism-memory-commands-'))
  directories.add(dir)
  return dir
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

  it('retires a claim the same person wrote, without asking the model', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'forget')
    await run(ctx, agent, '/memory remember the nightly job runs at 02:00')
    const stored = ctx.prismMemory.all()[0]
    if (stored === undefined) throw new Error('the claim was not stored')

    const retired = await run(ctx, agent, `/memory forget ${stored.id} wrong time`)
    expect(retired.kind).toBe('success')
    expect(retired.text).toContain('Retired, retained for audit:')
    expect(ctx.prismMemory.all()[0]?.status).toBe('archived')

    // A retired claim keeps its record and stops being recalled.
    expect(ctx.prismMemory.search('nightly', agent)).toEqual([])
  })

  it('refuses a forget with no id', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'forget-empty')
    const refused = await run(ctx, agent, '/memory forget')
    expect(refused.kind).toBe('error')
    expect(refused.text).toContain('Usage: /memory <subcommand>')
  })

  it('keeps the pre-existing status report as the default subcommand', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'status')
    await run(ctx, agent, '/memory remember the domain stays at version 1')

    const report = await run(ctx, agent, '/memory')
    expect(report.kind).toBe('success')
    expect(report.text).toContain('visible 1 record(s)')
  })

  it('verifies cited evidence end to end and counts an uncited operator claim', async () => {
    const ctx = await boot({}, { sessionQuery: true })
    const agent = await createAgent(ctx, 'verify')
    appendUser(agent, 'I prefer concise answers from now on')
    await driveTurnStopping(ctx, agent)
    await run(ctx, agent, '/memory remember an operator claim without a source')

    const settled = await run(ctx, agent, '/memory verify')
    expect(settled.kind).toBe('success')
    expect(settled.text).toContain('intact 1')
    expect(settled.text).toContain('records citing no message: 1')
  })

  it('reports a drifted source with its reason', async () => {
    const ctx = await boot({}, { sessionQuery: true })
    const agent = await createAgent(ctx, 'verify-drift')
    appendUser(agent, 'the deploy window is tuesday')
    const anchor = agent.session.deriveMessages().at(-1)
    if (anchor === undefined) throw new Error('no user message to cite')
    await ctx.prismMemory.remember({
      text: 'a claim whose fingerprint was tampered with',
      evidenceMessage: { id: anchor.id, textHash: 'ff'.repeat(32) },
    }, agent)

    const settled = await run(ctx, agent, '/memory verify')
    expect(settled.kind).toBe('success')
    expect(settled.text).toContain('drifted 1')
    expect(settled.text).toContain("the cited message's text changed")
  })

  it('compares two claims and states the preservation rule', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'compare')
    const first = await ctx.prismMemory.remember({ text: 'the retry budget is three attempts', tags: ['retry'] }, agent)
    const second = await ctx.prismMemory.remember({
      text: 'the retry budget is five attempts',
      tags: ['retry'],
      supersedes: first.record.id,
    }, agent)

    const settled = await run(ctx, agent, `/memory compare ${first.record.id} ${second.record.id}`)
    expect(settled.kind).toBe('success')
    expect(settled.text).toContain('verdict (mechanical vocabulary, not a decision): conflicting')
    expect(settled.text).toContain('relation right supersedes left')
    expect(settled.text).toContain('Conflicting claims are preserved with their conditions')
  })

  it('audits an existing mirror through export check', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'export-check')
    await run(ctx, agent, '/memory remember the domain stays at version 1')
    const dir = await scratch()

    const missing = await run(ctx, agent, `/memory export check ${dir}`)
    expect(missing.text).toContain('memory.md: missing')
    expect(missing.text).toContain('memory.index.json: missing')

    await run(ctx, agent, `/memory export ${dir}`)
    const match = await run(ctx, agent, `/memory export check ${dir}`)
    expect(match.text).toContain('memory.md: match')

    await run(ctx, agent, '/memory remember a claim written after the mirror was taken')
    const stale = await run(ctx, agent, `/memory export check ${dir}`)
    expect(stale.text).toContain('memory.md: stale')
    expect(stale.text).toContain('Re-run "/memory export" to refresh the mirror.')
  })

  it('names the verify and compare surfaces in the usage text', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'usage')
    const refused = await run(ctx, agent, '/memory nonsense-subcommand')
    expect(refused.kind).toBe('error')
    expect(refused.text).toContain('verify [limit]')
    expect(refused.text).toContain('compare <idA> <idB>')
  })
})
