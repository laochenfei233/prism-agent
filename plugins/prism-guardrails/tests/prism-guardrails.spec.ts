import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { resolveConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
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
      planDeniedTools: undefined,
      repeatAskAfter: undefined,
      maxStepsPerTurn: undefined,
      skillInvocationGuidance: true,
    })
  })

  it('resolves each configured rail', () => {
    const resolved = resolveConfig({
      planDeniedTools: ['write', 'edit'],
      repeatAskAfter: 5,
      maxStepsPerTurn: 20,
      skillInvocationGuidance: false,
    })
    expect([...(resolved.planDeniedTools ?? [])]).toEqual(['write', 'edit'])
    expect(resolved.repeatAskAfter).toBe(5)
    expect(resolved.maxStepsPerTurn).toBe(20)
    expect(resolved.skillInvocationGuidance).toBe(false)
  })

  it('treats repeatAskAfter 0 as the off switch rather than a threshold', () => {
    expect(resolveConfig({ repeatAskAfter: 0 }).repeatAskAfter).toBeUndefined()
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
    ['a non-boolean guidance switch', { skillInvocationGuidance: 'yes' }, 'must be a boolean'],
    ['an unknown key', { maxSteps: 3 }, 'unknown config key'],
  ])('rejects %s', (_label, config, message) => {
    expect(() => resolveConfig(config as Config)).toThrow(message)
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
