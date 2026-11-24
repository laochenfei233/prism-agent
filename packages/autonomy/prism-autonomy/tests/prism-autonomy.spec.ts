import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ApprovalOutcome, ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import type { Agent } from '@deepseek-ai/dsh-agent'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import PrismAutonomyService from '../src/index.ts'
import { requiresHuman } from '../src/config.ts'

/** The preset table every test mounts: the manual default plus the autonomous tier. */
const PRESETS = {
  'workspace-write': { sandbox: 'workspace-write' as SandboxMode, approval: 'ask' as ApprovalPolicy },
  'autonomous-guarded': { sandbox: 'workspace-write' as SandboxMode, approval: 'ask' as ApprovalPolicy },
}

/**
 * Mount the harness with permission presets and the autonomy plugin.
 * @param autonomyConfig - overrides for the autonomy plugin's config.
 * @returns the mounted context.
 */
async function mounted(autonomyConfig: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('autonomy tests do not execute bash') },
    run() { throw new Error('autonomy tests do not execute bash') },
    start() { throw new Error('autonomy tests do not execute bash') },
  })
  ctx.provide('approval', { config: { policy: 'ask' } })
  await ctx.plugin(PermissionPresetService, { presets: PRESETS })
  await ctx.plugin(PrismAutonomyService, autonomyConfig)
  return ctx
}

/** Dispatch one approval request through the real answerer waterfall. */
function ask(ctx: Context, agent: Agent, toolName: string, reason: string): Promise<ApprovalOutcome> {
  return ctx.waterfall(
    scopeTarget(agent, agent),
    'approval/request',
    { agent, toolName, reason },
    () => Promise.resolve<ApprovalOutcome>('unavailable'),
  )
}

describe('prism-autonomy answerer', () => {
  it('auto-answers routine asks under the autonomous preset and delegates otherwise', async () => {
    const ctx = await mounted()
    const { agent } = await ctx.agents.create({ sessionId: SessionId('s1') })

    // Under the manual default the answerer stays out of the way.
    await expect(ask(ctx, agent, 'write', 'this turn has already written 9 distinct files')).resolves.toBe('unavailable')

    ctx.permissionPresets.set(agent.session, 'autonomous-guarded')
    await expect(ask(ctx, agent, 'write', 'this turn has already written 9 distinct files')).resolves.toBe('allowed-once')
    await expect(ask(ctx, agent, 'edit', 'repeated call approval')).resolves.toBe('allowed-once')
  })

  it('keeps sandbox escalations with the human', async () => {
    const ctx = await mounted()
    const { agent } = await ctx.agents.create({ sessionId: SessionId('s1') })
    ctx.permissionPresets.set(agent.session, 'autonomous-guarded')

    await expect(ask(ctx, agent, 'bash', 'escalate sandbox to danger-full-access: need to reach the external mirror')).resolves.toBe('unavailable')
    await expect(ask(ctx, agent, 'write', 'a dependency manifest change')).resolves.toBe('allowed-once')
  })

  it('honors custom require-human matchers by tool and reason prefix', async () => {
    const ctx = await mounted({ preset: 'autonomous-guarded', requireHuman: [{ tool: 'bash' }, { reasonPrefix: 'dependency' }] })
    const { agent } = await ctx.agents.create({ sessionId: SessionId('s1') })
    ctx.permissionPresets.set(agent.session, 'autonomous-guarded')

    await expect(ask(ctx, agent, 'bash', 'anything at all')).resolves.toBe('unavailable')
    await expect(ask(ctx, agent, 'write', 'dependency manifest update')).resolves.toBe('unavailable')
    await expect(ask(ctx, agent, 'write', 'a plain write')).resolves.toBe('allowed-once')
  })

  it('fails loud when the configured preset is unknown', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await mountAgentLoopTestHarness(ctx)
    ctx.provide('shell', {
      sandboxMode: 'workspace-write',
      resolve() { throw new Error('unused') },
      run() { throw new Error('unused') },
      start() { throw new Error('unused') },
    })
    ctx.provide('approval', { config: { policy: 'ask' } })
    await ctx.plugin(PermissionPresetService, { presets: PRESETS })
    await expect(ctx.plugin(PrismAutonomyService, { preset: 'no-such-preset' }))
      .rejects.toThrow(/not in the permission-presets catalog/)
  })
})

describe('prism-autonomy live notice', () => {
  it('injects exactly one notice per engagement change and none for unrelated presets', async () => {
    const ctx = await mounted()
    const { agent } = await ctx.agents.create({ sessionId: SessionId('s1') })
    const injectSpy = vi.spyOn(agent, 'inject').mockImplementation(() => {})

    ctx.permissionPresets.set(agent.session, 'workspace-write')
    expect(injectSpy).not.toHaveBeenCalled()

    ctx.permissionPresets.set(agent.session, 'autonomous-guarded')
    expect(injectSpy).toHaveBeenCalledTimes(1)
    expect(injectSpy.mock.calls[0]?.[0]?.content?.[0]).toMatchObject({ text: expect.stringContaining('Autonomous approvals are on') })

    ctx.permissionPresets.set(agent.session, 'autonomous-guarded')
    expect(injectSpy).toHaveBeenCalledTimes(1)

    ctx.permissionPresets.set(agent.session, 'workspace-write')
    expect(injectSpy).toHaveBeenCalledTimes(2)
    expect(injectSpy.mock.calls[1]?.[0]?.content?.[0]).toMatchObject({ text: expect.stringContaining('off') })
  })
})

describe('prism-autonomy restore', () => {
  it('keeps answering after a restore without re-injecting the notice', async () => {
    const source = await mounted()
    const { agent } = await source.agents.create({ sessionId: SessionId('s1') })
    source.permissionPresets.set(agent.session, 'autonomous-guarded')
    const seed = agent.session.snapshotEvents()

    const ctx = await mounted()
    const restored = (await ctx.agents.create({ sessionId: SessionId('s1'), seed })).agent
    const injectSpy = vi.spyOn(restored, 'inject').mockImplementation(() => {})

    await expect(ask(ctx, restored, 'write', 'a plain write')).resolves.toBe('allowed-once')
    await expect(ask(ctx, restored, 'bash', 'escalate sandbox to danger-full-access: need wider access')).resolves.toBe('unavailable')
    expect(injectSpy).not.toHaveBeenCalled()
  })
})

describe('require-human matchers', () => {
  it('match by tool, by reason prefix, and require every set field to match', () => {
    expect(requiresHuman('bash', 'any', [{ tool: 'bash' }])).toBe(true)
    expect(requiresHuman('write', 'any', [{ tool: 'bash' }])).toBe(false)
    expect(requiresHuman('write', 'escalate sandbox to danger-full-access: x', [{ reasonPrefix: 'escalate sandbox to' }])).toBe(true)
    expect(requiresHuman('write', 'a plain write', [{ reasonPrefix: 'escalate sandbox to' }])).toBe(false)
    expect(requiresHuman('bash', 'escalate sandbox to danger-full-access: x', [{ tool: 'bash', reasonPrefix: 'escalate sandbox to' }])).toBe(true)
    expect(requiresHuman('bash', 'unrelated', [{ tool: 'bash', reasonPrefix: 'escalate sandbox to' }])).toBe(false)
    expect(requiresHuman('write', 'any', [])).toBe(false)
  })
})
