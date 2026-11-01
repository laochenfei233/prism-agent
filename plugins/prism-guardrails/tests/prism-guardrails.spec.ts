import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { resolveConfig, configVersion } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { createLedger } from '../src/decision.ts'
import * as Guardrails from '../src/index.ts'

/**
 * Behavior suite for the capability-hardening bundle.
 *
 * Every rail is driven through the REAL services — the production tool
 * pipeline, the production agent loop against a scripted mock adapter, the real
 * plan-mode controller, and the real skill registry — so the assertions are on
 * model-visible results and executed effects rather than on a hand-built
 * stand-in for the extension points.
 */

const testToolSignal = new AbortController().signal

/** Boot the core spine and the bundle; the caller registers tools and adapters. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Guardrails, config)
  return ctx
}

/** Boot the core spine, the bundle, and the real plan-mode controller. */
async function planHarness(config: Config): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(PlanModeController, { section: 'PLAN GUIDANCE' })
  await ctx.plugin(Guardrails, config)
  return ctx
}

/** Boot the core spine, the bundle, and the real skill registry. */
async function skillHarness(config: Config): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(Guardrails, config)
  return ctx
}

/** Boot the core spine, the bundle, and the real command runtime. */
async function commandHarness(config: Config): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Guardrails, config)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** A tool fixture whose every execution appends its name to `runs`. */
function fixture(name: string, runs: string[]) {
  return defineContentToolFixture({
    name,
    description: `${name} fixture`,
    parameters: {},
    execute() {
      runs.push(name)
      return Promise.resolve([{ type: 'text' as const, text: `${name} ran` }])
    },
  })
}

/** Every model-visible tool result this context produced, in call order. */
function recordToolResults(ctx: Context): string[] {
  const results: string[] = []
  ctx.on('tools/post-execute', (_exec, result, next) => {
    results.push(textOf(result))
    return next()
  })
  return results
}

/** Join a tool result's text blocks. */
function textOf(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** Send one user turn and wait for the loop to go idle. */
async function userTurn(ctx: Context, agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
}

describe('configuration validation', () => {
  it('resolves an empty configuration with every rail off and guidance on', () => {
    expect(resolveConfig({})).toEqual({
      mode: 'enforce',
      planDeniedTools: undefined,
      repeatAskAfter: undefined,
      maxStepsPerTurn: undefined,
      unfinishedTodoContinuations: undefined,
      skillInvocationGuidance: true,
      writeTools: undefined,
      maxWrittenFilesPerTurn: undefined,
      requirePonytailUpgradePaths: false,
      dependencyManifests: undefined,
      routingContract: undefined,
      verificationGate: undefined,
      readTools: undefined,
      sensitivePaths: undefined,
      commandGuard: undefined,
    })
  })

  it('resolves each configured rail', () => {
    const resolved = resolveConfig({
      planDeniedTools: ['write', 'edit'],
      repeatAskAfter: 5,
      maxStepsPerTurn: 20,
      unfinishedTodoContinuations: 2,
      skillInvocationGuidance: false,
      writeTools: [{ tool: 'write', pathArgument: 'path', contentArgument: 'content' }],
      maxWrittenFilesPerTurn: 4,
      requirePonytailUpgradePaths: true,
      dependencyManifests: ['package.json'],
      routingContract: { readOnlyTools: ['read'] },
      verificationGate: { verifyTools: ['bash'] },
      readTools: [{ tool: 'read', pathArgument: 'file_path' }],
      sensitivePaths: ['.env', '.ssh'],
      commandGuard: {
        tools: [{ tool: 'bash', commandArgument: 'command' }],
        deny: [{ pattern: 'git\\s+push\\s+--force', reason: 'rewrites remote history' }],
      },
    })
    expect([...(resolved.planDeniedTools ?? [])]).toEqual(['write', 'edit'])
    expect(resolved.repeatAskAfter).toBe(5)
    expect(resolved.maxStepsPerTurn).toBe(20)
    expect(resolved.unfinishedTodoContinuations).toBe(2)
    expect(resolved.skillInvocationGuidance).toBe(false)
    expect(resolved.writeTools?.get('write')).toEqual({ pathArgument: 'path', contentArgument: 'content' })
    expect(resolved.maxWrittenFilesPerTurn).toBe(4)
    expect(resolved.requirePonytailUpgradePaths).toBe(true)
    expect([...(resolved.dependencyManifests ?? [])]).toEqual(['package.json'])
    expect([...(resolved.routingContract ?? [])]).toEqual(['read'])
    expect([...(resolved.verificationGate ?? [])]).toEqual(['bash'])
    expect(resolved.readTools?.get('read')).toBe('file_path')
    expect(resolved.sensitivePaths).toEqual(['.env', '.ssh'])
    expect(resolved.commandGuard?.tools.get('bash')).toBe('command')
    expect(resolved.commandGuard?.rules[0]?.pattern.test('GIT PUSH --FORCE origin main')).toBe(true)
  })

  it('treats repeatAskAfter 0 as the off switch rather than a threshold', () => {
    expect(resolveConfig({ repeatAskAfter: 0 }).repeatAskAfter).toBeUndefined()
  })

  it('defaults the mode to enforce and accepts observe', () => {
    expect(resolveConfig({}).mode).toBe('enforce')
    expect(resolveConfig({ mode: 'observe' }).mode).toBe('observe')
  })

  it('gives one configuration one version, whichever order its keys were written in', () => {
    const written = configVersion({ maxStepsPerTurn: 20, repeatAskAfter: 3 }, 'enforce')
    const reordered = configVersion({ repeatAskAfter: 3, maxStepsPerTurn: 20 }, 'enforce')

    expect(reordered).toBe(written)
    expect(written).toMatch(/^[0-9a-f]{8}$/)
    expect(configVersion({ maxStepsPerTurn: 21, repeatAskAfter: 3 }, 'enforce')).not.toBe(written)
    expect(configVersion({ maxStepsPerTurn: 20, repeatAskAfter: 3 }, 'observe')).not.toBe(written)
  })

  it('treats maxWrittenFilesPerTurn 0 as the off switch rather than a budget', () => {
    expect(resolveConfig({ maxWrittenFilesPerTurn: 0 }).maxWrittenFilesPerTurn).toBeUndefined()
  })

  it('treats unfinishedTodoContinuations 0 as the off switch rather than a count', () => {
    expect(resolveConfig({ unfinishedTodoContinuations: 0 }).unfinishedTodoContinuations).toBeUndefined()
  })

  it.each([
    ['a non-array denied list', { planDeniedTools: 'write' }, 'must be an array'],
    ['an empty denied list', { planDeniedTools: [] }, 'must not be empty'],
    ['a blank tool name', { planDeniedTools: [''] }, 'non-empty tool names'],
    ['a non-string tool name', { planDeniedTools: [7] }, 'non-empty tool names'],
    ['a duplicate tool name', { planDeniedTools: ['write', 'write'] }, 'names "write" twice'],
    ['a negative repeat threshold', { repeatAskAfter: -1 }, 'integer >= 0'],
    ['a fractional repeat threshold', { repeatAskAfter: 1.5 }, 'integer >= 0'],
    ['a single-call repeat threshold', { repeatAskAfter: 1 }, 'one call is not a loop'],
    ['a zero step budget', { maxStepsPerTurn: 0 }, 'integer >= 1'],
    ['a fractional step budget', { maxStepsPerTurn: 2.5 }, 'integer >= 1'],
    ['a negative todo-continuation count', { unfinishedTodoContinuations: -1 }, 'integer >= 0'],
    ['a fractional todo-continuation count', { unfinishedTodoContinuations: 1.5 }, 'integer >= 0'],
    ['a non-boolean guidance switch', { skillInvocationGuidance: 'yes' }, 'must be a boolean'],
    ['an unknown key', { maxSteps: 3 }, 'unknown config key'],
    ['an unknown mode', { mode: 'dry-run' }, 'mode must be "enforce" or "observe"'],
    ['a non-array write list', { writeTools: 'write' }, 'must be an array'],
    ['an empty write list', { writeTools: [] }, 'must not be empty'],
    ['a write entry naming no tool', { writeTools: [{ pathArgument: 'path' }] }, 'must name a tool'],
    ['a write entry naming no path argument', { writeTools: [{ tool: 'write' }] }, 'must name its pathArgument'],
    ['a blank content argument', { writeTools: [{ tool: 'write', pathArgument: 'path', contentArgument: '' }] }, 'non-empty contentArgument'],
    ['a duplicated write tool', { writeTools: [{ tool: 'write', pathArgument: 'path' }, { tool: 'write', pathArgument: 'p' }] }, 'names "write" twice'],
    ['an unknown write entry key', { writeTools: [{ tool: 'write', pathArgument: 'path', content: 'body' }] }, 'unknown writeTools key'],
    ['a negative write budget', { maxWrittenFilesPerTurn: -1 }, 'integer >= 0'],
    ['a non-boolean marker switch', { requirePonytailUpgradePaths: 'yes' }, 'must be a boolean'],
    ['an empty manifest list', { dependencyManifests: [] }, 'must not be empty'],
    ['a duplicated manifest', { dependencyManifests: ['package.json', 'package.json'] }, 'names "package.json" twice'],
    ['a non-object routing contract', { routingContract: ['read'] }, 'must be an object'],
    ['an empty read-only list', { routingContract: { readOnlyTools: [] } }, 'non-empty array of tool names'],
    ['an unknown routing-contract key', { routingContract: { readOnly: ['read'] } }, 'unknown routingContract key'],
    ['a non-object verification gate', { verificationGate: ['bash'] }, 'must be an object'],
    ['an empty verify list', { verificationGate: { verifyTools: [] } }, 'non-empty array of tool names'],
    ['an unknown verification-gate key', { verificationGate: { verify: ['bash'] } }, 'unknown verificationGate key'],
    ['a non-array read list', { readTools: 'read' }, 'must be an array'],
    ['an empty read list', { readTools: [] }, 'must not be empty'],
    ['a read entry naming no path argument', { readTools: [{ tool: 'read' }] }, 'must name its pathArgument'],
    ['a duplicated read tool', { readTools: [{ tool: 'read', pathArgument: 'f' }, { tool: 'read', pathArgument: 'g' }] }, 'names "read" twice'],
    ['an unknown read entry key', { readTools: [{ tool: 'read', pathArgument: 'f', content: 'x' }] }, 'unknown readTools key'],
    ['an empty sensitive list', { readTools: [{ tool: 'read', pathArgument: 'f' }], sensitivePaths: [] }, 'must not be empty'],
    ['a blank sensitive segment', { readTools: [{ tool: 'read', pathArgument: 'f' }], sensitivePaths: [''] }, 'non-empty path segments'],
    ['a duplicated sensitive segment', { readTools: [{ tool: 'read', pathArgument: 'f' }], sensitivePaths: ['.env', '.env'] }, 'names ".env" twice'],
    ['a non-object command guard', { commandGuard: ['bash'] }, 'must be an object'],
    ['an unknown command-guard key', { commandGuard: { tools: [], denys: [] } }, 'unknown commandGuard key'],
    ['an empty command-tool list', { commandGuard: { tools: [], deny: [{ pattern: 'x', reason: 'y' }] } }, 'non-empty array of'],
    ['a command tool naming no argument', { commandGuard: { tools: [{ tool: 'bash' }], deny: [{ pattern: 'x', reason: 'y' }] } }, 'must name its commandArgument'],
    ['an empty command-pattern list', { commandGuard: { tools: [{ tool: 'bash', commandArgument: 'command' }], deny: [] } }, 'must be a non-empty array'],
    ['a command pattern naming no reason', { commandGuard: { tools: [{ tool: 'bash', commandArgument: 'command' }], deny: [{ pattern: 'x' }] } }, 'must name a reason'],
    ['an unparsable command pattern', { commandGuard: { tools: [{ tool: 'bash', commandArgument: 'command' }], deny: [{ pattern: '(', reason: 'y' }] } }, 'is not a regular expression'],
  ])('rejects %s', (_label, config, message) => {
    expect(() => resolveConfig(config as Config)).toThrow(message)
  })

  it.each([
    ['a write budget', { maxWrittenFilesPerTurn: 3 }],
    ['the marker rail', { requirePonytailUpgradePaths: true }],
    ['dependency approval', { dependencyManifests: ['package.json'] }],
    ['the verification gate', { verificationGate: { verifyTools: ['bash'] } }],
  ])('refuses to load %s without the writing tools it reads', (_label, config) => {
    expect(() => resolveConfig(config as Config)).toThrow('name writeTools as well')
  })

  it('refuses the sensitive-read rail without the tools it reads', () => {
    expect(() => resolveConfig({ sensitivePaths: ['.env'] })).toThrow('name readTools as well')
  })

  it('refuses the marker rail when no write tool names its text argument', () => {
    expect(() => resolveConfig({
      writeTools: [{ tool: 'write', pathArgument: 'path' }],
      requirePonytailUpgradePaths: true,
    })).toThrow('must name its contentArgument')
  })

  it('fails plugin load rather than silently disabling a rail', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await expect(ctx.plugin(Guardrails, { maxStepsPerTurn: 0 })).rejects.toThrow('integer >= 1')
    await ctx.fiber.dispose()
  })
})

describe('plan-mode tool denial', () => {
  it('refuses a denied tool while plan mode is active and releases it when plan mode ends', async () => {
    const ctx = await planHarness({ planDeniedTools: ['write'] })
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await ctx.agentLoop.create(SessionId('plan-active'), { provider: 'mock', model: 'mock' })

    expect(ctx.planMode.set(agent, true)).toBe('committed')
    const denied = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'write', arguments: { path: 'a' }, agent,
    })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('plan mode is active: `write` is not executed until the plan is approved')
    expect(textOf(denied)).toContain('exit_plan_mode')
    expect(runs).toEqual([])

    expect(ctx.planMode.set(agent, false)).toBe('committed')
    const allowed = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c2'), name: 'write', arguments: { path: 'a' }, agent,
    })
    expect(allowed.isError).toBe(false)
    expect(runs).toEqual(['write'])
  })

  it('leaves an unnamed tool alone while plan mode is active', async () => {
    const ctx = await planHarness({ planDeniedTools: ['write'] })
    const runs: string[] = []
    ctx.tools.register(fixture('read', runs))
    const agent = await ctx.agentLoop.create(SessionId('plan-other'), { provider: 'mock', model: 'mock' })
    ctx.planMode.set(agent, true)

    const result = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'read', arguments: {}, agent,
    })
    expect(result.isError).toBe(false)
    expect(runs).toEqual(['read'])
  })

  it('refuses on a selection that is still pending for the next accepted step', async () => {
    const ctx = await planHarness({ planDeniedTools: ['write'] })
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const results = recordToolResults(ctx)
    const agent = await ctx.agentLoop.create(SessionId('plan-pending'), { provider: 'mock', model: 'mock' })

    // Selecting plan mode from inside the model request queues it: no accepted
    // pre-step runs again before this step's tool batch, so the selection is
    // still pending when the guard reads it.
    const adapter = new MockAdapter([
      () => {
        ctx.planMode.set(agent, true)
        return toolCallResponse('c1', 'write', { path: 'a' })
      },
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await userTurn(ctx, agent, 'go')

    expect(runs).toEqual([])
    expect(results.some(text => text.includes('plan mode is active'))).toBe(true)
  })

  it('restricts nothing when the deployment mounts no plan-mode service', async () => {
    const ctx = await harness({ planDeniedTools: ['write'] })
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await ctx.agentLoop.create(SessionId('plan-absent'), { provider: 'mock', model: 'mock' })

    const result = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'write', arguments: {}, agent,
    })
    expect(result.isError).toBe(false)
    expect(runs).toEqual(['write'])
  })

  it('denies nothing when the rail is not configured', async () => {
    const ctx = await planHarness({})
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await ctx.agentLoop.create(SessionId('plan-off'), { provider: 'mock', model: 'mock' })
    ctx.planMode.set(agent, true)

    const result = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'write', arguments: {}, agent,
    })
    expect(result.isError).toBe(false)
    expect(runs).toEqual(['write'])
  })
})

describe('repeated-call approval', () => {
  it('sends the call after the configured run to approval, which denies with no channel', async () => {
    const ctx = await harness({ repeatAskAfter: 3 })
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    const results = recordToolResults(ctx)
    const agent = await ctx.agentLoop.create(SessionId('repeat-over-limit'), { provider: 'mock', model: 'mock' })

    const adapter = new MockAdapter([
      ...Array.from({ length: 5 }, (_, index) => toolCallResponse(`c${index}`, 'probe', { q: 'same' })),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await userTurn(ctx, agent, 'go')

    // Three calls ran; the fourth and fifth were priced by a human channel that
    // does not exist here, so the fail-closed approval ladder refused them, and
    // the refusal reports the run length already reached.
    expect(runs).toEqual(['probe', 'probe', 'probe'])
    expect(results.map(text => /has now been called (\d+) times in a row/.exec(text)?.[1]).filter(Boolean))
      .toEqual(['3', '4'])
    expect(results.filter(text => text.includes('probe ran'))).toHaveLength(3)
    expect(adapter.requests).toHaveLength(6)
  })

  it('allows a run exactly at the threshold and approves the next one', async () => {
    const ctx = await harness({ repeatAskAfter: 3 })
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    const results = recordToolResults(ctx)
    const agent = await ctx.agentLoop.create(SessionId('repeat-at-limit'), { provider: 'mock', model: 'mock' })

    const adapter = new MockAdapter([
      ...Array.from({ length: 4 }, (_, index) => toolCallResponse(`c${index}`, 'probe', { q: 'same' })),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await userTurn(ctx, agent, 'go')

    expect(runs).toEqual(['probe', 'probe', 'probe'])
    expect(results.filter(text => text.includes('has now been called'))).toHaveLength(1)
  })

  it('keys the run on the arguments, so a changed argument is a new run', async () => {
    const ctx = await harness({ repeatAskAfter: 3 })
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    const results = recordToolResults(ctx)
    const agent = await ctx.agentLoop.create(SessionId('repeat-arguments'), { provider: 'mock', model: 'mock' })

    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 'same' }),
      toolCallResponse('c2', 'probe', { q: 'same' }),
      toolCallResponse('c3', 'probe', { q: 'other' }),
      toolCallResponse('c4', 'probe', { q: 'same' }),
      toolCallResponse('c5', 'probe', { q: 'same' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await userTurn(ctx, agent, 'go')

    expect(runs).toHaveLength(5)
    expect(results.filter(text => text.includes('has now been called'))).toHaveLength(0)
  })

  it('keys the run on property order, so reordered arguments are the same call', async () => {
    const ctx = await harness({ repeatAskAfter: 2 })
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    const results = recordToolResults(ctx)
    const agent = await ctx.agentLoop.create(SessionId('repeat-key-order'), { provider: 'mock', model: 'mock' })

    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { a: 1, b: 2 }),
      toolCallResponse('c2', 'probe', { b: 2, a: 1 }),
      toolCallResponse('c3', 'probe', { b: 2, a: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await userTurn(ctx, agent, 'go')

    expect(runs).toEqual(['probe', 'probe'])
    expect(results.filter(text => text.includes('has now been called 2 times in a row'))).toHaveLength(1)
  })

  it('resets the run when the user speaks, so the next identical call is not an approval', async () => {
    const ctx = await harness({ repeatAskAfter: 3 })
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    const results = recordToolResults(ctx)
    const agent = await ctx.agentLoop.create(SessionId('repeat-user-reset'), { provider: 'mock', model: 'mock' })

    const adapter = new MockAdapter([
      toolCallResponse('a1', 'probe', { q: 'same' }),
      toolCallResponse('a2', 'probe', { q: 'same' }),
      toolCallResponse('a3', 'probe', { q: 'same' }),
      textResponse('first turn done'),
      toolCallResponse('b1', 'probe', { q: 'same' }),
      textResponse('second turn done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await userTurn(ctx, agent, 'go')
    await userTurn(ctx, agent, 'go again')

    expect(runs).toHaveLength(4)
    expect(results.filter(text => text.includes('has now been called'))).toHaveLength(0)
  })

  it('counts a refused call, so hammering the gate keeps meeting it', async () => {
    const ctx = await harness({ repeatAskAfter: 2 })
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    const results = recordToolResults(ctx)
    const agent = await ctx.agentLoop.create(SessionId('repeat-hammering'), { provider: 'mock', model: 'mock' })

    const adapter = new MockAdapter([
      ...Array.from({ length: 4 }, (_, index) => toolCallResponse(`c${index}`, 'probe', { q: 'same' })),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await userTurn(ctx, agent, 'go')

    expect(runs).toEqual(['probe', 'probe'])
    // The threshold itself does not ask; every later call does, and the run
    // length each one reports keeps climbing because a refused call is counted.
    expect(results.map(text => /has now been called (\d+) times/.exec(text)?.[1]).filter(Boolean))
      .toEqual(['2', '3'])
  })

  it('leaves every call alone when the rail is off', async () => {
    const ctx = await harness({})
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    const results = recordToolResults(ctx)
    const agent = await ctx.agentLoop.create(SessionId('repeat-off'), { provider: 'mock', model: 'mock' })

    const adapter = new MockAdapter([
      ...Array.from({ length: 6 }, (_, index) => toolCallResponse(`c${index}`, 'probe', { q: 'same' })),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await userTurn(ctx, agent, 'go')

    expect(runs).toHaveLength(6)
    expect(results.filter(text => text.includes('has now been called'))).toHaveLength(0)
  })
})

describe('turn budget', () => {
  it('stops opening steps beyond the budget and logs why', async () => {
    const ctx = await harness({ maxStepsPerTurn: 3 })
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    const agent = await ctx.agentLoop.create(SessionId('budget'), { provider: 'mock', model: 'mock' })
    const warnings: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')) })

    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { i: 1 }),
      toolCallResponse('c2', 'probe', { i: 2 }),
      toolCallResponse('c3', 'probe', { i: 3 }),
      toolCallResponse('c4', 'probe', { i: 4 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await userTurn(ctx, agent, 'go')

    expect(runs).toHaveLength(3)
    expect(adapter.requests).toHaveLength(3)
    expect(warnings.some(line => line.includes('reached the 3-step budget'))).toBe(true)
  })

  it('lets a turn finish inside the budget', async () => {
    const ctx = await harness({ maxStepsPerTurn: 4 })
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    const agent = await ctx.agentLoop.create(SessionId('budget-inside'), { provider: 'mock', model: 'mock' })

    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { i: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await userTurn(ctx, agent, 'go')

    expect(runs).toHaveLength(1)
    expect(adapter.requests).toHaveLength(2)
  })

  it('measures each turn separately', async () => {
    const ctx = await harness({ maxStepsPerTurn: 2 })
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    const agent = await ctx.agentLoop.create(SessionId('budget-per-turn'), { provider: 'mock', model: 'mock' })

    const adapter = new MockAdapter([
      toolCallResponse('a1', 'probe', { i: 1 }),
      toolCallResponse('a2', 'probe', { i: 2 }),
      toolCallResponse('b1', 'probe', { i: 3 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    await userTurn(ctx, agent, 'go')
    await userTurn(ctx, agent, 'go again')

    // The first turn spends its whole budget and stops; the second turn starts
    // with a fresh one, so the third call is not an over-budget step.
    expect(runs).toHaveLength(3)
    expect(adapter.requests).toHaveLength(4)
  })
})

describe('skill-invocation guidance', () => {
  const USER_ONLY = {
    name: 'user-only',
    description: 'Only a human may invoke this',
    source: 'runtime',
    content: 'user-only body',
    invocation: { modelInvocable: false, userInvocable: true },
  } as const

  async function callSkill(ctx: Context, session: string, argumentsValue: unknown): Promise<ToolExecutionResult> {
    const agent = await ctx.agentLoop.create(SessionId(session), { provider: 'mock', model: 'mock' })
    return ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId(`call-${session}`), name: 'skill', arguments: argumentsValue, agent,
    })
  }

  it('names the gesture that would load a user-only skill', async () => {
    const ctx = await skillHarness({})
    const runs: string[] = []
    ctx.tools.register(fixture('skill', runs))
    ctx.skills.register(USER_ONLY)

    const result = await callSkill(ctx, 'skill-user-only', { name: 'user-only' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('Error: skill "user-only" is user-invoked only: '
      + 'ask the user to type /user-only in their next message')
    expect(runs).toEqual([])
  })

  it('delegates a model-invocable skill to the loader', async () => {
    const ctx = await skillHarness({})
    const runs: string[] = []
    ctx.tools.register(fixture('skill', runs))
    ctx.skills.register({ name: 'open-skill', description: 'Open', source: 'runtime', content: 'body' })

    const result = await callSkill(ctx, 'skill-model', { name: 'open-skill' })
    expect(result.isError).toBe(false)
    expect(runs).toEqual(['skill'])
  })

  it('keeps the loader own rejection when neither interface can invoke the skill', async () => {
    const ctx = await skillHarness({})
    const runs: string[] = []
    ctx.tools.register(fixture('skill', runs))
    ctx.skills.register({
      name: 'closed-skill',
      description: 'Closed',
      source: 'runtime',
      content: 'body',
      invocation: { modelInvocable: false, userInvocable: false },
    })

    const result = await callSkill(ctx, 'skill-closed', { name: 'closed-skill' })
    expect(runs).toEqual(['skill'])
    expect(textOf(result)).not.toContain('user-invoked only')
  })

  it('delegates an unknown skill name to the loader', async () => {
    const ctx = await skillHarness({})
    const runs: string[] = []
    ctx.tools.register(fixture('skill', runs))

    const result = await callSkill(ctx, 'skill-unknown', { name: 'ghost' })
    expect(runs).toEqual(['skill'])
    expect(textOf(result)).not.toContain('user-invoked only')
  })

  it('delegates a call that carries no skill name', async () => {
    const ctx = await skillHarness({})
    const runs: string[] = []
    ctx.tools.register(fixture('skill', runs))
    ctx.skills.register(USER_ONLY)

    const result = await callSkill(ctx, 'skill-no-name', {})
    expect(runs).toEqual(['skill'])
    expect(textOf(result)).not.toContain('user-invoked only')
  })

  it('delegates a call whose name is not a string', async () => {
    const ctx = await skillHarness({})
    const runs: string[] = []
    ctx.tools.register(fixture('skill', runs))
    ctx.skills.register(USER_ONLY)

    const result = await callSkill(ctx, 'skill-numeric-name', { name: 42 })
    expect(runs).toEqual(['skill'])
    expect(textOf(result)).not.toContain('user-invoked only')
  })

  it('delegates a call whose name is empty', async () => {
    const ctx = await skillHarness({})
    const runs: string[] = []
    ctx.tools.register(fixture('skill', runs))
    ctx.skills.register(USER_ONLY)

    const result = await callSkill(ctx, 'skill-empty-name', { name: '' })
    expect(runs).toEqual(['skill'])
    expect(textOf(result)).not.toContain('user-invoked only')
  })

  it('never sees a non-object argument list: the tool schema rejects it first', async () => {
    const ctx = await skillHarness({})
    const runs: string[] = []
    ctx.tools.register(fixture('skill', runs))
    ctx.skills.register(USER_ONLY)

    const result = await callSkill(ctx, 'skill-scalar', 'user-only')
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('Error: invalid arguments: "arguments" must be an object')
    expect(runs).toEqual([])
  })

  it('leaves another tool named differently alone', async () => {
    const ctx = await skillHarness({})
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    ctx.skills.register(USER_ONLY)

    const agent = await ctx.agentLoop.create(SessionId('skill-other-tool'), { provider: 'mock', model: 'mock' })
    const result = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'probe', arguments: { name: 'user-only' }, agent,
    })
    expect(result.isError).toBe(false)
    expect(runs).toEqual(['probe'])
  })

  it('leaves a user-only skill alone when the deployment mounts no skill service', async () => {
    const ctx = await harness({})
    const runs: string[] = []
    ctx.tools.register(fixture('skill', runs))

    const result = await callSkill(ctx, 'skill-absent', { name: 'user-only' })
    expect(runs).toEqual(['skill'])
    expect(textOf(result)).not.toContain('user-invoked only')
  })

  it('leaves a user-only skill alone when guidance is switched off', async () => {
    const ctx = await skillHarness({ skillInvocationGuidance: false })
    const runs: string[] = []
    ctx.tools.register(fixture('skill', runs))
    ctx.skills.register(USER_ONLY)

    const result = await callSkill(ctx, 'skill-off', { name: 'user-only' })
    expect(runs).toEqual(['skill'])
    expect(textOf(result)).not.toContain('user-invoked only')
  })
})

/** The writing-tool surface every rail that reads written content is configured with. */
const WRITE_TOOLS = [{ tool: 'write', pathArgument: 'path', contentArgument: 'content' }] as const

/** One call id per invocation, so a spec's calls are distinguishable in the log. */
let nextCallId = 0

/** Call a tool directly with one argument record, bypassing the loop. */
function toolCall(ctx: Context, agent: Agent, name: string, args: object): Promise<ToolExecutionResult> {
  nextCallId += 1
  return ctx.tools.execute({
    signal: testToolSignal, callId: ToolCallId(`call-${String(nextCallId)}`), name, arguments: args, agent,
  })
}

/** Make a fresh agent on a harness whose rails are already installed. */
async function newAgent(ctx: Context, session: string): Promise<Agent> {
  return await ctx.agentLoop.create(SessionId(session), { provider: 'mock', model: 'mock' })
}

describe('routing contract', () => {
  const CONFIG = { routingContract: { readOnlyTools: ['read'] } } as const

  it('refuses the first non-readonly call until a route is on the record', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    ctx.tools.register(fixture('skill', runs))
    const agent = await newAgent(ctx, 'routing-first')

    const refused = await toolCall(ctx, agent, 'write', { path: 'a.ts' })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('the routing contract is not satisfied')
    expect(textOf(refused)).toContain('Route: fast-path')
    expect(runs).toEqual([])

    // Loading a skill is the other accepted decision, and it is itself an
    // allowed call, so the model answers the refusal without a dead end.
    expect((await toolCall(ctx, agent, 'skill', { name: 'brainstorming' })).isError).toBe(false)
    expect((await toolCall(ctx, agent, 'write', { path: 'a.ts' })).isError).toBe(false)
    expect(runs).toEqual(['skill', 'write'])
  })

  it('leaves a read-only call alone', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('read', runs))
    const agent = await newAgent(ctx, 'routing-readonly')

    expect((await toolCall(ctx, agent, 'read', { path: 'a.ts' })).isError).toBe(false)
    expect(runs).toEqual(['read'])
  })

  it('accepts the declaration a committed assistant message carries', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'routing-declared')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'write', { path: 'a.ts' }, 'Route: fast-path — a single fixture write.'),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await userTurn(ctx, agent, 'go')

    expect(runs).toEqual(['write'])
  })

  it('records one decision per session rather than per call', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    ctx.tools.register(fixture('skill', runs))
    const agent = await newAgent(ctx, 'routing-session')
    const other = await newAgent(ctx, 'routing-other-session')

    await toolCall(ctx, agent, 'skill', { name: 'brainstorming' })
    expect((await toolCall(ctx, agent, 'write', { path: 'a.ts' })).isError).toBe(false)
    // Another session holds its own record: the decision is not global state.
    expect((await toolCall(ctx, other, 'write', { path: 'b.ts' })).isError).toBe(true)
    expect(runs).toEqual(['skill', 'write'])
  })

  it('leaves every call alone when the rail is off', async () => {
    const ctx = await harness({})
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'routing-off')

    expect((await toolCall(ctx, agent, 'write', { path: 'a.ts' })).isError).toBe(false)
    expect(runs).toEqual(['write'])
  })
})

describe('write budget', () => {
  const CONFIG = { writeTools: WRITE_TOOLS, maxWrittenFilesPerTurn: 2 } as const

  it('sends the path beyond the budget to approval, which denies with no channel', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'budget-over')

    expect((await toolCall(ctx, agent, 'write', { path: 'a.ts' })).isError).toBe(false)
    expect((await toolCall(ctx, agent, 'write', { path: 'b.ts' })).isError).toBe(false)
    const refused = await toolCall(ctx, agent, 'write', { path: 'c.ts' })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('beyond the 2 the deployment allows')
    expect(runs).toEqual(['write', 'write'])
  })

  it('counts a path once, so re-editing a written file stays free', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'budget-repeat')

    await toolCall(ctx, agent, 'write', { path: 'a.ts' })
    await toolCall(ctx, agent, 'write', { path: 'a.ts' })
    await toolCall(ctx, agent, 'write', { path: 'a.ts' })

    expect(runs).toEqual(['write', 'write', 'write'])
  })

  it('spends no budget on a call that never wrote', async () => {
    // Budget 1 with dependency approval on: the manifest write is refused by
    // the other rail, and the source write that follows must still be the
    // turn's first written path. Counting the refusal would refuse it too.
    const ctx = await harness({ writeTools: WRITE_TOOLS, maxWrittenFilesPerTurn: 1, dependencyManifests: ['package.json'] })
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'budget-refused')

    expect((await toolCall(ctx, agent, 'write', { path: 'package.json', content: '{}' })).isError).toBe(true)
    expect((await toolCall(ctx, agent, 'write', { path: 'src/a.ts', content: '' })).isError).toBe(false)
    expect(runs).toEqual(['write'])
  })

  it('leaves writes alone when the rail is off', async () => {
    const ctx = await harness({ writeTools: WRITE_TOOLS })
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'budget-off')

    for (const path of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) await toolCall(ctx, agent, 'write', { path })
    expect(runs).toHaveLength(4)
  })
})

describe('ponytail marker discipline', () => {
  const CONFIG = { writeTools: WRITE_TOOLS, requirePonytailUpgradePaths: true } as const

  it('refuses a marker that names no upgrade path', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'marker-bare')

    const refused = await toolCall(ctx, agent, 'write', {
      path: 'lock.ts', content: '// ponytail: global lock\n',
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('no upgrade path')
    expect(textOf(refused)).toContain('global lock')
    expect(runs).toEqual([])
  })

  it('accepts a marker naming its ceiling and upgrade path', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'marker-complete')

    const allowed = await toolCall(ctx, agent, 'write', {
      path: 'lock.ts', content: '// ponytail: global lock, per-account locks if throughput matters\n',
    })
    expect(allowed.isError).toBe(false)
    expect(runs).toEqual(['write'])
  })

  it('applies the upgrade-path rule to the current shortcut: marker too', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'marker-shortcut-bare')

    const refused = await toolCall(ctx, agent, 'write', {
      path: 'lock.ts', content: '// shortcut: global lock\n',
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('no upgrade path')
    expect(runs).toEqual([])
  })

  it('accepts a shortcut: marker naming its ceiling and upgrade path', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'marker-shortcut-complete')

    const allowed = await toolCall(ctx, agent, 'write', {
      path: 'lock.ts', content: '// shortcut: global lock, per-account locks if throughput matters\n',
    })
    expect(allowed.isError).toBe(false)
    expect(runs).toEqual(['write'])
  })

  it('ignores prose that mentions the convention without a comment prefix', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'marker-prose')

    const allowed = await toolCall(ctx, agent, 'write', {
      path: 'notes.md', content: 'Mark it `ponytail: <ceiling>, <upgrade path>` when you cut a corner.\n',
    })
    expect(allowed.isError).toBe(false)
    expect(runs).toEqual(['write'])
  })

  it('reads every marker in the written text, not only the first', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'marker-later')

    const refused = await toolCall(ctx, agent, 'write', {
      path: 'lock.ts',
      content: '// ponytail: global lock, per-account locks if throughput matters\nconst a = 1\n// ponytail: naive scan\n',
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('naive scan')
  })
})

describe('dependency approval', () => {
  const CONFIG = { writeTools: WRITE_TOOLS, dependencyManifests: ['package.json'] } as const

  it('sends a dependency manifest write to approval, which denies with no channel', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'dependency-manifest')

    const refused = await toolCall(ctx, agent, 'write', { path: 'package.json', content: '{}' })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toContain('changes the dependency manifest')
    expect(runs).toEqual([])
  })

  it('matches the file name on either separator', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'dependency-subdirectory')

    const refused = await toolCall(ctx, agent, 'write', { path: 'apps\\web\\package.json', content: '{}' })
    expect(refused.isError).toBe(true)
    expect(runs).toEqual([])
  })

  it('leaves an ordinary source write alone', async () => {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'dependency-source')

    expect((await toolCall(ctx, agent, 'write', { path: 'src/a.ts', content: '' })).isError).toBe(false)
    expect(runs).toEqual(['write'])
  })
})

describe('verification gate', () => {
  const CONFIG = { writeTools: WRITE_TOOLS, verificationGate: { verifyTools: ['bash'] } } as const

  /** Boot a harness whose adapter is scripted with the given responses. */
  async function turnHarness(
    session: string,
    responses: ReturnType<typeof textResponse>[],
  ): Promise<{ ctx: Context; agent: Agent; runs: string[]; adapter: MockAdapter }> {
    const ctx = await harness(CONFIG)
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    ctx.tools.register(fixture('bash', runs))
    const agent = await newAgent(ctx, session)
    const adapter = new MockAdapter(responses)
    ctx.llm.registerAdapter(['mock'], adapter)
    return { ctx, agent, runs, adapter }
  }

  it('sends a turn that wrote without verifying back for evidence', async () => {
    const { ctx, agent, runs, adapter } = await turnHarness('verify-missing', [
      toolCallResponse('c1', 'write', { path: 'a.ts', content: '' }),
      textResponse('done'),
      toolCallResponse('c2', 'bash', { command: 'pnpm test' }),
      textResponse('verified'),
    ])

    await userTurn(ctx, agent, 'go')

    // The stop boundary steered, the model ran its check, and the second stop
    // boundary was left alone.
    expect(runs).toEqual(['write', 'bash'])
    expect(adapter.requests).toHaveLength(4)
  })

  it('does not interrupt a turn that ran its verification', async () => {
    const { ctx, agent, runs, adapter } = await turnHarness('verify-present', [
      toolCallResponse('c1', 'write', { path: 'a.ts', content: '' }),
      toolCallResponse('c2', 'bash', { command: 'pnpm test' }),
      textResponse('done'),
    ])

    await userTurn(ctx, agent, 'go')

    expect(runs).toEqual(['write', 'bash'])
    expect(adapter.requests).toHaveLength(3)
  })

  it('interrupts a turn at most once, so a model that ignores it still stops', async () => {
    const { ctx, agent, runs, adapter } = await turnHarness('verify-ignored', [
      toolCallResponse('c1', 'write', { path: 'a.ts', content: '' }),
      textResponse('done'),
      textResponse('still done'),
    ])

    await userTurn(ctx, agent, 'go')

    expect(runs).toEqual(['write'])
    expect(adapter.requests).toHaveLength(3)
  })

  it('leaves a turn that wrote nothing alone', async () => {
    const { ctx, agent, runs, adapter } = await turnHarness('verify-readonly', [
      textResponse('nothing to do'),
    ])

    await userTurn(ctx, agent, 'go')

    expect(runs).toEqual([])
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('unfinished-todo gate', () => {
  /** Boot a harness on one continuation budget, with the agent's list already written. */
  async function todoHarness(
    session: string,
    todos: readonly { content: string; status: 'pending' | 'in_progress' | 'completed' }[],
    responses: StreamChunk[][],
    continuations = 1,
  ): Promise<{ ctx: Context; agent: Agent; runs: string[]; adapter: MockAdapter }> {
    const ctx = await harness({ unfinishedTodoContinuations: continuations })
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    const agent = await newAgent(ctx, session)
    agent.session.append('todo/write', { todos: [...todos] })
    const adapter = new MockAdapter(responses)
    ctx.llm.registerAdapter(['mock'], adapter)
    return { ctx, agent, runs, adapter }
  }

  /** The text the model was sent in one request, across every content block. */
  function requestText(request: GenerateOptions): string {
    return request.messages
      .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
      .join('\n')
  }

  it('sends a turn back to the items its own list still has open', async () => {
    const { ctx, agent, runs, adapter } = await todoHarness('todo-unfinished', [
      { content: 'T1 wire the store', status: 'in_progress' },
      { content: 'T2 add the panel', status: 'pending' },
    ], [textResponse('phase one done'), toolCallResponse('c1', 'probe', { i: 1 }), textResponse('done')])

    await userTurn(ctx, agent, 'implement it')

    const steered = adapter.requests[1]
    if (steered === undefined) throw new Error('the second request carries the continuation')
    expect(runs).toEqual(['probe'])
    expect(adapter.requests).toHaveLength(3)
    expect(requestText(steered)).toContain('still has 2 unfinished item(s)')
    expect(requestText(steered)).toContain('T1 wire the store')
  })

  it('stops a turn whose list is finished', async () => {
    const { ctx, agent, runs, adapter } = await todoHarness('todo-finished', [
      { content: 'T1 wire the store', status: 'completed' },
    ], [textResponse('done')])

    await userTurn(ctx, agent, 'implement it')

    expect(runs).toEqual([])
    expect(adapter.requests).toHaveLength(1)
  })

  it('stops steering after the configured number of continuations', async () => {
    const { ctx, agent, runs, adapter } = await todoHarness('todo-bounded', [
      { content: 'T1 wire the store', status: 'pending' },
    ], [textResponse('one'), textResponse('two'), textResponse('three')], 2)

    await userTurn(ctx, agent, 'implement it')

    expect(runs).toEqual([])
    expect(adapter.requests).toHaveLength(3)
  })
})

describe('sensitive-read denial', () => {
  /** The sensitive-path rail as a deployment names it: one reading tool, three segments. */
  const guarded: Config = {
    readTools: [{ tool: 'read', pathArgument: 'file_path' }],
    sensitivePaths: ['.env', '.ssh', '.aws'],
  }

  it('refuses a credential directory entry and never runs the tool', async () => {
    const ctx = await harness(guarded)
    const runs: string[] = []
    ctx.tools.register(fixture('read', runs))
    const agent = await ctx.agentLoop.create(SessionId('sensitive-read-aws'), { provider: 'mock', model: 'mock' })

    const denied = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'read',
      arguments: { file_path: '/home/u/.aws/credentials' }, agent,
    })

    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('matched ".aws"')
    expect(runs).toEqual([])
  })

  it('refuses a credential path and never runs the tool', async () => {
    const ctx = await harness(guarded)
    const runs: string[] = []
    ctx.tools.register(fixture('read', runs))
    const agent = await ctx.agentLoop.create(SessionId('sensitive-read'), { provider: 'mock', model: 'mock' })

    const denied = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'read',
      arguments: { file_path: '/home/u/.ssh/id_rsa' }, agent,
    })

    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('/home/u/.ssh/id_rsa')
    expect(textOf(denied)).toContain('credential material (matched ".ssh")')
    expect(textOf(denied)).toContain('Ask the user for the specific value')
    expect(runs).toEqual([])
  })

  it('refuses a dotted extension of a guarded name', async () => {
    const ctx = await harness(guarded)
    const runs: string[] = []
    ctx.tools.register(fixture('read', runs))
    const agent = await ctx.agentLoop.create(SessionId('sensitive-read-dotenv'), { provider: 'mock', model: 'mock' })

    const denied = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'read',
      arguments: { file_path: 'C:\\work\\.env.local' }, agent,
    })

    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('matched ".env"')
    expect(runs).toEqual([])
  })

  it('leaves an ordinary source file alone', async () => {
    const ctx = await harness(guarded)
    const runs: string[] = []
    ctx.tools.register(fixture('read', runs))
    const agent = await ctx.agentLoop.create(SessionId('sensitive-read-source'), { provider: 'mock', model: 'mock' })

    for (const filePath of ['src/environment.ts', 'src/index.ts']) {
      const allowed = await ctx.tools.execute({
        signal: testToolSignal, callId: ToolCallId('c1'), name: 'read',
        arguments: { file_path: filePath }, agent,
      })
      expect(allowed.isError).toBe(false)
    }
    expect(runs).toEqual(['read', 'read'])
  })

  it('leaves the repository\'s own credentials package alone', async () => {
    const ctx = await harness(guarded)
    const runs: string[] = []
    ctx.tools.register(fixture('read', runs))
    const agent = await ctx.agentLoop.create(SessionId('sensitive-read-package'), { provider: 'mock', model: 'mock' })

    // A `credentials` segment in the shipped list would refuse both of these.
    for (const filePath of ['packages/credentials/credentials/src/index.ts', 'docs/subsystems/credentials.md']) {
      const allowed = await ctx.tools.execute({
        signal: testToolSignal, callId: ToolCallId('c1'), name: 'read',
        arguments: { file_path: filePath }, agent,
      })
      expect(allowed.isError).toBe(false)
    }
    expect(runs).toEqual(['read', 'read'])
  })

  it('refuses a credential path that is spelled in upper case', async () => {
    const ctx = await harness(guarded)
    const runs: string[] = []
    ctx.tools.register(fixture('read', runs))
    const agent = await ctx.agentLoop.create(SessionId('sensitive-read-upper'), { provider: 'mock', model: 'mock' })

    const denied = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'read',
      arguments: { file_path: 'C:\\Users\\U\\.SSH\\ID_RSA' }, agent,
    })

    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toContain('matched ".ssh"')
    expect(runs).toEqual([])
  })

  it('ignores a tool the deployment did not name', async () => {
    const ctx = await harness(guarded)
    const runs: string[] = []
    ctx.tools.register(fixture('grep', runs))
    const agent = await ctx.agentLoop.create(SessionId('sensitive-read-other-tool'), { provider: 'mock', model: 'mock' })

    const result = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'grep',
      arguments: { path: '/home/u/.ssh/id_rsa' }, agent,
    })

    expect(result.isError).toBe(false)
    expect(runs).toEqual(['grep'])
  })
})

describe('command guard', () => {
  /** The command rail as a deployment names it: one shell tool, one guarded pattern. */
  const guarded: Config = {
    commandGuard: {
      tools: [{ tool: 'bash', commandArgument: 'command' }],
      deny: [{
        pattern: 'git\\s+push\\b[^\\n]*(--force\\b|\\s-f\\b)',
        reason: 'rewrites a remote branch history others may already have',
      }],
    },
  }

  it('sends a matching command to approval, which denies with no channel', async () => {
    const ctx = await harness(guarded)
    const runs: string[] = []
    ctx.tools.register(fixture('bash', runs))
    const agent = await ctx.agentLoop.create(SessionId('command-guarded'), { provider: 'mock', model: 'mock' })

    const result = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'bash',
      arguments: { command: 'git push --force origin main' }, agent,
    })

    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('would run a command this deployment guards')
    expect(textOf(result)).toContain('rewrites a remote branch history')
    expect(runs).toEqual([])
  })

  it('matches a guarded command inside a wrapper', async () => {
    const ctx = await harness(guarded)
    const runs: string[] = []
    ctx.tools.register(fixture('bash', runs))
    const agent = await ctx.agentLoop.create(SessionId('command-wrapped'), { provider: 'mock', model: 'mock' })

    const result = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'bash',
      arguments: { command: 'bash -c "git push --force origin main"' }, agent,
    })

    expect(result.isError).toBe(true)
    expect(runs).toEqual([])
  })

  it('runs a command that matches no guarded pattern', async () => {
    const ctx = await harness(guarded)
    const runs: string[] = []
    ctx.tools.register(fixture('bash', runs))
    const agent = await ctx.agentLoop.create(SessionId('command-allowed'), { provider: 'mock', model: 'mock' })

    const result = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'bash',
      arguments: { command: 'git status --short' }, agent,
    })

    expect(result.isError).toBe(false)
    expect(runs).toEqual(['bash'])
  })

  it('ignores a tool the deployment did not name', async () => {
    const ctx = await harness(guarded)
    const runs: string[] = []
    ctx.tools.register(fixture('pwsh', runs))
    const agent = await ctx.agentLoop.create(SessionId('command-other-tool'), { provider: 'mock', model: 'mock' })

    const result = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'pwsh',
      arguments: { command: 'git push --force origin main' }, agent,
    })

    expect(result.isError).toBe(false)
    expect(runs).toEqual(['pwsh'])
  })
})

describe('observe mode', () => {
  /** Read the status report, which is where an observed decision shows up. */
  async function report(ctx: Context, agent: Agent): Promise<string> {
    const execution = await ctx.commands.execute(agent, '/guardrails', [], new AbortController().signal)
    return execution?.result.text ?? ''
  }

  it('runs a guarded command and records it', async () => {
    const ctx = await commandHarness({
      mode: 'observe',
      commandGuard: {
        tools: [{ tool: 'bash', commandArgument: 'command' }],
        deny: [{ pattern: 'git\\s+push\\s+--force', reason: 'rewrites remote history' }],
      },
    })
    const runs: string[] = []
    ctx.tools.register(fixture('bash', runs))
    const agent = await newAgent(ctx, 'observe-command')

    const result = await toolCall(ctx, agent, 'bash', { command: 'git push --force origin main' })

    expect(result.isError).toBe(false)
    expect(runs).toEqual(['bash'])
    const text = await report(ctx, agent)
    expect(text).toContain('OBSERVE MODE')
    expect(text).toContain('nothing is refused')
    expect(text).toContain('observed  command guard  git push --force origin main')
  })

  it('runs a read of a credential path and records it', async () => {
    const ctx = await commandHarness({
      mode: 'observe',
      readTools: [{ tool: 'read', pathArgument: 'file_path' }],
      sensitivePaths: ['.env'],
    })
    const runs: string[] = []
    ctx.tools.register(fixture('read', runs))
    const agent = await newAgent(ctx, 'observe-secret')

    const result = await toolCall(ctx, agent, 'read', { file_path: '.env' })

    expect(result.isError).toBe(false)
    expect(runs).toEqual(['read'])
    expect(await report(ctx, agent)).toContain('observed  sensitive reads  .env')
  })

  it('runs a dependency-manifest write and records it', async () => {
    const ctx = await commandHarness({
      mode: 'observe',
      writeTools: WRITE_TOOLS,
      dependencyManifests: ['package.json'],
    })
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'observe-manifest')

    const result = await toolCall(ctx, agent, 'write', { path: 'package.json', content: '{}' })

    expect(result.isError).toBe(false)
    expect(runs).toEqual(['write'])
    expect(await report(ctx, agent)).toContain('observed  dependency manifests  package.json')
  })

  it('runs a write carrying an untriggered marker and records it', async () => {
    const ctx = await commandHarness({
      mode: 'observe',
      writeTools: WRITE_TOOLS,
      requirePonytailUpgradePaths: true,
    })
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'observe-marker')

    const result = await toolCall(ctx, agent, 'write', {
      path: 'src/lock.ts',
      content: '// shortcut: global lock',
    })

    expect(result.isError).toBe(false)
    expect(runs).toEqual(['write'])
    expect(await report(ctx, agent)).toContain('observed  ponytail markers  src/lock.ts')
  })

  it('runs a write beyond the file budget and records it', async () => {
    const ctx = await commandHarness({
      mode: 'observe',
      writeTools: WRITE_TOOLS,
      maxWrittenFilesPerTurn: 1,
    })
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'observe-budget')

    expect((await toolCall(ctx, agent, 'write', { path: 'a.ts', content: '' })).isError).toBe(false)
    const second = await toolCall(ctx, agent, 'write', { path: 'b.ts', content: '' })

    expect(second.isError).toBe(false)
    expect(runs).toEqual(['write', 'write'])
    expect(await report(ctx, agent)).toContain('observed  write budget  b.ts')
  })

  it('runs the first non-readonly call and records it', async () => {
    const ctx = await commandHarness({ mode: 'observe', routingContract: { readOnlyTools: ['read'] } })
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'observe-routing')

    const result = await toolCall(ctx, agent, 'write', { path: 'a.ts' })

    expect(result.isError).toBe(false)
    expect(runs).toEqual(['write'])
    expect(await report(ctx, agent)).toContain('observed  routing contract  write')
  })

  it('runs a denied plan-mode tool and records it', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(PlanModeController, { section: 'PLAN GUIDANCE' })
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(Guardrails, { mode: 'observe', planDeniedTools: ['write'] })
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    const agent = await newAgent(ctx, 'observe-plan')

    expect(ctx.planMode.set(agent, true)).toBe('committed')
    const result = await toolCall(ctx, agent, 'write', { path: 'a' })

    expect(result.isError).toBe(false)
    expect(runs).toEqual(['write'])
    expect(await report(ctx, agent)).toContain('observed  plan-mode denial  write')
  })

  it('opens the step beyond the turn budget and records it', async () => {
    const ctx = await commandHarness({ mode: 'observe', maxStepsPerTurn: 1 })
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    const agent = await newAgent(ctx, 'observe-budget-steps')
    const warnings: string[] = []
    vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(' ')) })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      toolCallResponse('c2', 'probe', {}),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await userTurn(ctx, agent, 'go')

    expect(runs).toEqual(['probe', 'probe'])
    expect(await report(ctx, agent)).toContain('observed  turn budget  step 2')
    // The log line says a step "was not opened", which would be false here.
    expect(warnings.filter(line => line.includes('was not opened'))).toEqual([])
  })

  it('runs a repeated call past the threshold and records it', async () => {
    const ctx = await commandHarness({ mode: 'observe', repeatAskAfter: 3 })
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    const agent = await newAgent(ctx, 'observe-repeat')
    const adapter = new MockAdapter([
      ...Array.from({ length: 5 }, (_, index) => toolCallResponse(`c${index}`, 'probe', { q: 'same' })),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await userTurn(ctx, agent, 'go')

    expect(runs).toHaveLength(5)
    expect(await report(ctx, agent)).toContain('observed  repeat approval  probe')
  })

  it('runs a model-solicited user-only skill and records it', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(Guardrails, { mode: 'observe' })
    const runs: string[] = []
    ctx.tools.register(fixture('skill', runs))
    ctx.skills.register({
      name: 'user-only',
      description: 'Only a human may invoke this',
      source: 'runtime',
      content: 'user-only body',
      invocation: { modelInvocable: false, userInvocable: true },
    })
    const agent = await newAgent(ctx, 'observe-skill')

    const result = await toolCall(ctx, agent, 'skill', { name: 'user-only' })

    expect(runs).toEqual(['skill'])
    expect(await report(ctx, agent)).toContain('observed  skill guidance  user-only')
  })

  it('still steers a turn back to its own todo list', async () => {
    const ctx = await commandHarness({ mode: 'observe', unfinishedTodoContinuations: 1 })
    const runs: string[] = []
    ctx.tools.register(fixture('probe', runs))
    const agent = await newAgent(ctx, 'observe-todos')
    agent.session.append('todo/write', {
      todos: [{ content: 'T1 finish the change', status: 'pending' }],
    } as never)
    const adapter = new MockAdapter([
      textResponse('progress report'),
      textResponse('still reporting'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await userTurn(ctx, agent, 'go')

    expect(adapter.requests).toHaveLength(2)
    expect(await report(ctx, agent)).toContain('decisions this session: 1 (0 observed)')
  })

  it('shortens a long subject and caps how many rows it lists', async () => {
    const ctx = await commandHarness({
      mode: 'observe',
      commandGuard: {
        tools: [{ tool: 'bash', commandArgument: 'command' }],
        deny: [{ pattern: '^rm\\b', reason: 'deletes files' }],
      },
    })
    const runs: string[] = []
    ctx.tools.register(fixture('bash', runs))
    const agent = await newAgent(ctx, 'observe-truncation')
    const long = `rm -rf ${'x'.repeat(200)}`

    await toolCall(ctx, agent, 'bash', { command: long })

    const text = await report(ctx, agent)
    expect(text).toContain('…')
    expect(text).not.toContain('x'.repeat(120))
  })

  it('keeps only the newest decisions and hands out a copy', () => {
    const ledger = createLedger()
    const agent = {} as Agent
    for (let index = 0; index < 250; index += 1) {
      ledger.record(agent, { rail: 'command guard', outcome: 'observed', subject: String(index) })
    }

    const listed = ledger.list(agent)
    expect(listed).toHaveLength(200)
    expect(listed[0]?.subject).toBe('50')
    expect(listed.at(-1)?.subject).toBe('249')
    listed.pop()
    expect(ledger.list(agent)).toHaveLength(200)
  })

  it('still steers a turn back for evidence', async () => {
    // A steer is a request to finish work, not a refusal: observing must not
    // switch it off, which is why the report counts it apart from an observation.
    const ctx = await commandHarness({
      mode: 'observe',
      writeTools: WRITE_TOOLS,
      verificationGate: { verifyTools: ['bash'] },
    })
    const runs: string[] = []
    ctx.tools.register(fixture('write', runs))
    ctx.tools.register(fixture('bash', runs))
    const agent = await newAgent(ctx, 'observe-verify')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'write', { path: 'a.ts', content: '' }),
      textResponse('done'),
      toolCallResponse('c2', 'bash', { command: 'pnpm test' }),
      textResponse('verified'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await userTurn(ctx, agent, 'go')

    expect(runs).toEqual(['write', 'bash'])
    expect(adapter.requests).toHaveLength(4)
    expect(await report(ctx, agent)).toContain('decisions this session: 1 (0 observed)')
  })
})

describe('/guardrails status', () => {
  it('reports every rail with its configured value', async () => {
    const ctx = await commandHarness({
      maxStepsPerTurn: 20,
      readTools: [{ tool: 'read', pathArgument: 'file_path' }],
      sensitivePaths: ['.env'],
    })
    const agent = await ctx.agentLoop.create(SessionId('status'), { provider: 'mock', model: 'mock' })

    const execution = await ctx.commands.execute(agent, '/guardrails', [], new AbortController().signal)
    const text = execution?.result.text ?? ''

    expect(text).toContain('Guardrails: 3 of 12 rails armed (mode: enforce, config ')
    expect(text.split('\n').slice(1, 13)).toEqual([
      'plan-mode denial: off',
      'repeat approval: off',
      'turn budget: 20 steps',
      'unfinished todos: off',
      'skill guidance: on',
      'write budget: off',
      'ponytail markers: off',
      'dependency manifests: off',
      'routing contract: off',
      'verification gate: off',
      'sensitive reads: .env',
      'command guard: off',
    ])
    // Nothing was observed and nothing was refused, so the ledger has no rows
    // beyond the count an observing deployment would need.
    expect(text).not.toContain('decisions this session')
  })

  it('names the mode and the configuration version', async () => {    const ctx = await commandHarness({ maxStepsPerTurn: 20 })
    const agent = await ctx.agentLoop.create(SessionId('status-version'), { provider: 'mock', model: 'mock' })

    const first = await ctx.commands.execute(agent, '/guardrails', [], new AbortController().signal)
    const second = await ctx.commands.execute(agent, '/guardrails', [], new AbortController().signal)

    expect(first?.result.text.split('\n')[0])
      .toMatch(/^Guardrails: \d+ of 12 rails armed \(mode: enforce, config [0-9a-f]{8}\)\.$/)
    expect(second?.result.text).toEqual(first?.result.text)
  })

  it('moves the version when the rail configuration changes', async () => {
    const one = await commandHarness({ maxStepsPerTurn: 20 })
    const other = await commandHarness({ maxStepsPerTurn: 21 })
    const first = await one.agentLoop.create(SessionId('status-version-a'), { provider: 'mock', model: 'mock' })
    const second = await other.agentLoop.create(SessionId('status-version-b'), { provider: 'mock', model: 'mock' })

    const versionOf = async (ctx: Context, agent: Agent): Promise<string> =>
      /config ([0-9a-f]{8})\)/.exec((await ctx.commands.execute(agent, '/guardrails', [], new AbortController().signal))
        ?.result.text ?? '')?.[1] ?? ''

    expect(await versionOf(one, first)).not.toBe(await versionOf(other, second))
  })

  it('registers even when the command runtime mounts after the bundle', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Guardrails, { maxStepsPerTurn: 20 })
    await ctx.plugin(CommandRuntime)

    const agent = await ctx.agentLoop.create(SessionId('status-late-commands'), { provider: 'mock', model: 'mock' })
    const execution = await ctx.commands.execute(agent, '/guardrails', [], new AbortController().signal)

    expect(execution?.result.text).toContain('turn budget: 20 steps')
  })

  it('enforces every rail when the deployment mounts no command runtime', async () => {
    const ctx = await harness({
      readTools: [{ tool: 'read', pathArgument: 'file_path' }],
      sensitivePaths: ['.env'],
    })
    expect(ctx.get('commands')).toBeUndefined()

    const runs: string[] = []
    ctx.tools.register(fixture('read', runs))
    const agent = await ctx.agentLoop.create(SessionId('status-no-commands'), { provider: 'mock', model: 'mock' })
    const denied = await ctx.tools.execute({
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'read',
      arguments: { file_path: '.env' }, agent,
    })

    expect(denied.isError).toBe(true)
    expect(runs).toEqual([])
  })

  it('prints no decisions block for an enforced refusal the model already read', async () => {
    const ctx = await commandHarness({
      readTools: [{ tool: 'read', pathArgument: 'file_path' }],
      sensitivePaths: ['.env'],
    })
    const runs: string[] = []
    ctx.tools.register(fixture('read', runs))
    const agent = await newAgent(ctx, 'status-enforced-refusal')

    expect((await toolCall(ctx, agent, 'read', { file_path: '.env' })).isError).toBe(true)

    expect((await ctx.commands.execute(agent, '/guardrails', [], new AbortController().signal))?.result.text)
      .not.toContain('decisions this session')
  })
})
