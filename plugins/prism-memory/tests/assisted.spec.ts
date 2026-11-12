/**
 * The model-assisted producer and the bootstrap command, driven through the
 * real Harness spine with a scripted llm.
 *
 * The claims under test are the ones governance rests on: the producer is
 * silent until a deployment turns it on, everything it writes parks in the
 * review inbox, an external failure never fails the turn, and bootstrap
 * spends model calls only when an operator applies it — once per session.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  appendAssistant,
  appendUser,
  createAgent,
  driveTurnStopping,
  llmOf,
  mountMemory,
} from './fixtures/harness.ts'

const owned = new Set<Context>()
const trees: string[] = []
afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
  await Promise.all(trees.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function boot(config: Record<string, unknown> = {}, options: { llm?: boolean, sessionQuery?: boolean } = {}): Promise<Context> {
  const ctx = await mountMemory({ config, ...options })
  owned.add(ctx)
  return ctx
}

/** An empty temporary working directory this spec owns. */
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prism-memory-assisted-'))
  trees.push(root)
  return root
}

/** One claim the scripted model proposes, citing message 1. */
const ONE_CLAIM = JSON.stringify([
  { text: 'the staging cluster resets every monday', kind: 'fact', layer: 'project', sourceMessage: 1 },
])

describe('the assisted distillation window', () => {
  it('stays silent while the deployment has not turned it on', async () => {
    const ctx = await boot({ autoDistill: false }, { llm: true })
    const agent = await createAgent(ctx, 'assisted-off')
    appendUser(agent, 'hello there, nothing durable in this line')
    appendAssistant(agent, 'a plain reply')

    await driveTurnStopping(ctx, agent)

    expect(llmOf(ctx).calls).toHaveLength(0)
    expect(ctx.prismMemory.all()).toHaveLength(0)
  })

  it('calls once per window and parks the candidates in review', async () => {
    const cwd = await scratch()
    const ctx = await boot(
      { assistedDistill: true, assistedDistillEveryTurns: 1, autoDistill: false },
      { llm: true },
    )
    llmOf(ctx).reply = ONE_CLAIM
    const agent = await createAgent(ctx, 'assisted-on', cwd)
    appendUser(agent, 'hello there, nothing durable in this line')
    appendAssistant(agent, 'a plain reply')

    await driveTurnStopping(ctx, agent)

    expect(llmOf(ctx).calls).toHaveLength(1)
    const stored = ctx.prismMemory.all()
    expect(stored).toHaveLength(1)
    const record = stored[0]
    expect(record?.status).toBe('pending')
    expect(record?.scope).toBe('project')
    expect(record?.evidence.note).toBe('assisted')
    expect(record?.evidence.messageId).not.toBeNull()
    expect(ctx.prismMemory.review(agent, { limit: 10 })).toHaveLength(1)
  })

  it('does not store the same claim twice across windows', async () => {
    const cwd = await scratch()
    const ctx = await boot(
      { assistedDistill: true, assistedDistillEveryTurns: 1, autoDistill: false },
      { llm: true },
    )
    llmOf(ctx).reply = ONE_CLAIM
    const agent = await createAgent(ctx, 'assisted-dedupe', cwd)
    appendUser(agent, 'first turn, nothing durable here')
    appendAssistant(agent, 'a plain reply')
    await driveTurnStopping(ctx, agent)
    appendUser(agent, 'second turn, still nothing durable')
    appendAssistant(agent, 'another plain reply')
    await driveTurnStopping(ctx, agent)

    expect(llmOf(ctx).calls).toHaveLength(2)
    expect(ctx.prismMemory.all()).toHaveLength(1)
  })

  it('fails soft when the model call or its output is unusable', async () => {
    const ctx = await boot(
      { assistedDistill: true, assistedDistillEveryTurns: 1, autoDistill: false },
      { llm: true },
    )
    const agent = await createAgent(ctx, 'assisted-failure')
    appendUser(agent, 'a turn with words but no durable claim')
    appendAssistant(agent, 'a plain reply')

    llmOf(ctx).failure = new Error('the provider refused')
    await expect(driveTurnStopping(ctx, agent)).resolves.toBeUndefined()
    expect(llmOf(ctx).calls).toHaveLength(1)
    expect(ctx.prismMemory.all()).toHaveLength(0)

    llmOf(ctx).failure = undefined
    llmOf(ctx).reply = 'I cannot answer in the requested form.'
    await expect(driveTurnStopping(ctx, agent)).resolves.toBeUndefined()
    expect(llmOf(ctx).calls).toHaveLength(2)
    expect(ctx.prismMemory.all()).toHaveLength(0)
  })

  it('cites the message the candidate names, and verify reads it back intact', async () => {
    const cwd = await scratch()
    const ctx = await boot(
      { assistedDistill: true, assistedDistillEveryTurns: 1, autoDistill: false },
      { llm: true, sessionQuery: true },
    )
    llmOf(ctx).reply = ONE_CLAIM
    const agent = await createAgent(ctx, 'assisted-cite', cwd)
    appendUser(agent, 'hello there, nothing durable in this line')
    appendAssistant(agent, 'a plain reply')
    await driveTurnStopping(ctx, agent)

    const report = await ctx.prismMemory.verifyEvidence()
    expect(report.readerUnavailable).toBe(false)
    expect(report.verdicts).toHaveLength(1)
    expect(report.verdicts[0]?.outcome).toBe('intact')
  })
})

describe('the bootstrap pass', () => {
  it('fails loud when a dependency is missing', async () => {
    const ctx = await boot(
      { assistedDistillProvider: 'mock', assistedDistillModel: 'mock' },
      { llm: true },
    )
    const agent = await createAgent(ctx, 'bootstrap-no-reader')
    await expect(ctx.prismMemory.bootstrap({ agent })).rejects.toMatchObject({
      code: 'PRISM_MEMORY_BOOTSTRAP_UNAVAILABLE',
    })
  })

  it('selects this directory\'s sessions in a dry run and calls nothing', async () => {
    const cwd = await scratch()
    const ctx = await boot(
      { assistedDistillProvider: 'mock', assistedDistillModel: 'mock', autoDistill: false },
      { llm: true, sessionQuery: true },
    )
    const past = await createAgent(ctx, 'past', cwd)
    appendUser(past, 'a past turn of this workspace')
    appendAssistant(past, 'its plain reply')
    const elsewhere = await createAgent(ctx, 'elsewhere', `${cwd}-elsewhere`)
    appendUser(elsewhere, 'a turn of another workspace')
    const agent = await createAgent(ctx, 'bootstrap-dry', cwd)

    const report = await ctx.prismMemory.bootstrap({ agent })

    expect(llmOf(ctx).calls).toHaveLength(0)
    expect(ctx.prismMemory.all()).toHaveLength(0)
    expect(report.applied).toBe(false)
    expect(report.processedCount).toBe(0)
    expect(report.sessions.map(session => session.sessionId)).toEqual(['session-past'])
    expect(report.sessions[0]?.messageCount).toBe(2)
  })

  it('applies once per session and writes pending project-scope claims', async () => {
    const cwd = await scratch()
    const ctx = await boot(
      { assistedDistillProvider: 'mock', assistedDistillModel: 'mock', autoDistill: false },
      { llm: true, sessionQuery: true },
    )
    const past = await createAgent(ctx, 'past', cwd)
    appendUser(past, 'a past turn of this workspace')
    appendAssistant(past, 'its plain reply')
    const agent = await createAgent(ctx, 'bootstrap-apply', cwd)
    llmOf(ctx).reply = ONE_CLAIM

    const report = await ctx.prismMemory.bootstrap({ apply: true, agent })

    expect(llmOf(ctx).calls).toHaveLength(1)
    expect(report.created).toHaveLength(1)
    expect(report.failed).toBe(0)
    const stored = ctx.prismMemory.all().filter(record => !record.tags.includes('bootstrap-log'))
    expect(stored).toHaveLength(1)
    expect(stored[0]?.status).toBe('pending')
    expect(stored[0]?.scope).toBe('project')
    expect(stored[0]?.evidence.note).toBe('bootstrap')

    const again = await ctx.prismMemory.bootstrap({ apply: true, agent })
    expect(again.processedCount).toBe(1)
    expect(again.sessions).toHaveLength(0)
    expect(llmOf(ctx).calls).toHaveLength(1)
    expect(again.created).toHaveLength(0)
  })
})

describe('the assisted configuration', () => {
  it('rejects a one-sided provider override at load', async () => {
    await expect(mountMemory({ config: { assistedDistillProvider: 'mock' } })).rejects.toThrow(/assistedDistillProvider/)
  })
})
