/**
 * Behavior suite for the Compose mode entry.
 *
 * The spec drives the REAL system-prompt registry and command runtime, so the
 * assertions are on what a session actually reads: the assembled prompt section
 * and the text a human gets back from each slash command. The automatic rule is
 * asserted through the pure function and through one assembled section.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as Compose from '../src/compose.ts'

/** Boot the registries the entry contributes to and return one live agent. */
async function harness(config: Compose.Config = {}): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Compose, config)
  const session = ctx.sessions.create(SessionId('compose-session'))
  const agent = {
    id: session.id,
    session,
    inject: () => undefined,
    options: { provider: 'mock', model: 'mock' },
  } as unknown as Agent
  return { ctx, agent }
}

/** The assembled prompt as this agent reads it. */
async function promptOf(ctx: Context, agent: Agent): Promise<string> {
  return renderPrompt(await ctx.systemPrompt.assemble({ agent, scope: agent }))
}

/** Run one slash command as the agent and return its text. */
async function run(ctx: Context, agent: Agent, line: string): Promise<string> {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  return execution?.result.text ?? ''
}

describe('compose mode section', () => {
  it('is silent until a level or the long-task rule turns it on', async () => {
    const { ctx, agent } = await harness()
    expect(await promptOf(ctx, agent)).not.toContain('COMPOSE')
  })

  it('states the five phases at lite and the nine at full', async () => {
    const lite = await harness({ level: 'lite' })
    const litePrompt = await promptOf(lite.ctx, lite.agent)
    expect(litePrompt).toContain('COMPOSE (level: lite)')
    expect(litePrompt).toContain('5. Review')
    expect(litePrompt).not.toContain('Grill')

    const full = await harness({ level: 'full' })
    const fullPrompt = await promptOf(full.ctx, full.agent)
    expect(fullPrompt).toContain('COMPOSE (level: full)')
    expect(fullPrompt).toContain('2. Grill')
    expect(fullPrompt).toContain('9. Finish')
  })

  it('refuses a level the mode cannot run', () => {
    expect(() => Compose.resolveLevel('turbo')).toThrow('compose level must be one of')
  })
})

describe('compose automatic rule', () => {
  it('switches to lite at the configured step count and never before it', () => {
    const rules = Compose.resolveAutoRules({ autoLongTaskSteps: 3 })
    expect(Compose.autoLevel(rules, 2)).toBeUndefined()
    expect(Compose.autoLevel(rules, 3)).toBe('lite')
  })

  it('stays off when the rule is disabled', () => {
    const rules = Compose.resolveAutoRules({ autoLongTaskSteps: 0 })
    expect(Compose.autoLevel(rules, 10_000)).toBeUndefined()
  })

  it('rejects a non-integer or negative step count at load', () => {
    expect(() => Compose.resolveAutoRules({ autoLongTaskSteps: -1 })).toThrow('autoLongTaskSteps must be an integer >= 0')
    expect(() => Compose.resolveAutoRules({ autoLongTaskSteps: 2.5 })).toThrow('autoLongTaskSteps must be an integer >= 0')
  })
})

describe('compose command', () => {
  it('reports the level and lists the gestures', async () => {
    const { ctx, agent } = await harness({ level: 'lite' })
    const text = await run(ctx, agent, '/compose-next')
    expect(text).toContain('Compose mode: lite.')
    expect(text).toContain('/compose-next full')
  })

  it('switches level and gives the section back to the automatic rule', async () => {
    const { ctx, agent } = await harness({ level: 'off' })
    expect(await run(ctx, agent, '/compose-next full')).toBe('Compose mode: full.')
    expect(await promptOf(ctx, agent)).toContain('COMPOSE (level: full)')

    expect(await run(ctx, agent, '/compose-next off')).toBe('Compose mode is off. `/compose-next lite|full` turns it on.')
    expect(await promptOf(ctx, agent)).not.toContain('COMPOSE')

    expect(await run(ctx, agent, '/compose-next auto')).toContain('Compose mode is off.')
  })

  it('rejects an unknown level by name', async () => {
    const { ctx, agent } = await harness()
    expect(await run(ctx, agent, '/compose-next turbo')).toContain('unknown level "turbo"')
  })
})
