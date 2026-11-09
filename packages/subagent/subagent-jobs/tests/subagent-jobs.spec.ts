import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import * as SubagentJobs from '../src/index.ts'

const PARENT = SessionId('11111111-1111-4111-8111-111111111111')
const CHILD = SessionId('22222222-2222-4222-8222-222222222222')

interface Setup {
  ctx: Context
  interrupts: ReturnType<typeof vi.fn>
}

async function setup({ controller = true }: { controller?: boolean } = {}): Promise<Setup> {
  const ctx = new Context()
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(AgentRegistry)
  if (controller) ctx.jobs.attachController('test')
  const interrupts = vi.fn()
  ctx.provide('subagents', { interrupt: interrupts } as never)
  await ctx.plugin(SubagentJobs)
  // An owned job registration resolves its owner to the live registered Agent.
  const ownerScope = ctx.plugin(() => {})
  const owner = {
    id: PARENT,
    ctx: ownerScope.ctx,
    inject: () => {},
    followup: () => {},
    status: 'running',
    session: { id: PARENT, header: { version: 0, id: PARENT, createdAt: 0 } },
  } as unknown as Agent
  await ctx.agents.register(owner)
  return { ctx, interrupts }
}

/** A start edge for one parent-delivered epoch, plus its end-edge builder. */
function startEdge(overrides: { delivery?: 'parent' | 'caller' } = {}) {
  const runId = SubagentRunId(randomUUID())
  const start = {
    runId,
    provider: 'spawn',
    id: CHILD,
    parentId: PARENT,
    delivery: 'parent',
    local: true,
    ...overrides,
  }
  return {
    runId,
    emitStart: (ctx: Context) => { ctx.emit('subagent/start', start) },
    endWith: (stopReason: string) => ({
      runId,
      provider: 'spawn',
      id: CHILD,
      parentId: PARENT,
      delivery: 'parent',
      local: true,
      stopReason,
    }),
  }
}

/** The single job the bridge registered, if any. */
function onlyJob(ctx: Context): JobView | undefined {
  const jobs = ctx.jobs.list(PARENT)
  return jobs.length === 1 ? jobs[0] : undefined
}

describe('subagent job bridge', () => {
  it('registers a running job owned by the delegating session', async () => {
    const { ctx } = await setup()
    const edge = startEdge()
    edge.emitStart(ctx)
    const job = onlyJob(ctx)
    expect(job).toMatchObject({
      kind: 'subagent',
      status: 'running',
      label: `spawn subagent ${CHILD}`,
      owner: PARENT,
    })
  })

  it('settles the job with the mapped outcome when the epoch ends', async () => {
    const { ctx } = await setup()
    const edge = startEdge()
    edge.emitStart(ctx)
    ctx.emit('subagent/end', edge.endWith('completed'))
    await vi.waitFor(() => { expect(onlyJob(ctx)?.status).toBe('completed') })
  })

  it.each([
    { stopReason: 'aborted', status: 'killed' },
    { stopReason: 'error', status: 'failed' },
    { stopReason: 'max-tokens', status: 'failed' },
    { stopReason: 'refusal', status: 'failed' },
  ] as const)('maps stop reason $stopReason to job status $status', async ({ stopReason, status }) => {
    const { ctx } = await setup()
    const edge = startEdge()
    edge.emitStart(ctx)
    ctx.emit('subagent/end', edge.endWith(stopReason))
    await vi.waitFor(() => {
      const job = onlyJob(ctx)
      expect(job?.status).toBe(status)
      expect(job?.detail).toBe(stopReason)
    })
  })

  it('kills the delegation by interrupting the child under the owning session', async () => {
    const { ctx, interrupts } = await setup()
    const edge = startEdge()
    edge.emitStart(ctx)
    const job = onlyJob(ctx)
    expect(ctx.jobs.kill(job!.id, PARENT, 'no longer needed')).toBe('requested')
    expect(interrupts).toHaveBeenCalledWith(CHILD, { kind: 'user', parentSessionId: PARENT })
    ctx.emit('subagent/end', edge.endWith('aborted'))
    await vi.waitFor(() => {
      const settled = onlyJob(ctx)
      expect(settled?.status).toBe('killed')
      expect(settled?.detail).toContain('no longer needed')
    })
  })

  it('ignores caller-delivered activations', async () => {
    const { ctx } = await setup()
    const edge = startEdge({ delivery: 'caller' })
    edge.emitStart(ctx)
    ctx.emit('subagent/end', edge.endWith('completed'))
    expect(ctx.jobs.list(PARENT)).toEqual([])
  })

  it('ignores an end edge without a registered epoch', async () => {
    const { ctx } = await setup()
    const edge = startEdge()
    ctx.emit('subagent/end', edge.endWith('completed'))
    expect(ctx.jobs.list(PARENT)).toEqual([])
  })

  it('cleans up the epoch pairing when the registry rejects registration', async () => {
    const { ctx } = await setup({ controller: false })
    // No controller serves the owner, so ctx.jobs.start rejects inside the
    // listener; the production lifecycle emitter contains that throw, and the
    // later end edge must find no pairing.
    const edge = startEdge()
    expect(() => { edge.emitStart(ctx) }).toThrow()
    ctx.emit('subagent/end', edge.endWith('completed'))
    expect(ctx.jobs.list(PARENT)).toEqual([])
  })
})
