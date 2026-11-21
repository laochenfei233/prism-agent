/**
 * Behavior suite for the Ponytail mode entry.
 *
 * The spec drives the REAL system-prompt registry and command runtime, so the
 * assertions are on what a session actually reads: the assembled prompt section
 * and the text a human gets back from each slash command. Automatic switching
 * is asserted twice: through the section for the preset rules, and through the
 * pure rule function for the long-task threshold.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as Ponytail from '../src/ponytail.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * The Agent face the Ponytail section and commands read: identity, session,
 * prompt-section injection, and provider options.
 */
function isAgentFace(value: {
  readonly id?: unknown
  readonly session?: unknown
  readonly inject?: unknown
  readonly options?: unknown
}): value is Agent {
  return value.session !== undefined && typeof value.inject === 'function' && value.options !== undefined
}

/** Boot the registries the entry contributes to and return one live agent. */
async function harness(
  config: Ponytail.Config = {},
  preset?: string,
): Promise<{ ctx: Context; agent: Agent; inject: ReturnType<typeof vi.fn> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(Ponytail, config)
  const session = ctx.sessions.create(
    SessionId('ponytail-session'),
    preset === undefined ? {} : { meta: { agentPreset: preset } },
  )
  const inject = vi.fn()
  const fixture = {
    id: session.id,
    session,
    inject,
    options: { provider: 'mock', model: 'mock' },
  }
  if (!isAgentFace(fixture)) throw new Error('agent fixture is missing its Ponytail Agent face')
  const agent: Agent = fixture
  return { ctx, agent, inject }
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

describe('ponytail mode section', () => {
  it('starts at the configured level and states the rules', async () => {
    const { ctx, agent } = await harness({ level: 'full' })
    const prompt = await promptOf(ctx, agent)

    expect(prompt).toContain('PONYTAIL MODE (level: full)')
    expect(prompt).toContain('shortcut: <the limit>, <when to upgrade>')
  })

  it('switches level through /ponytail and rewrites the section', async () => {
    const { ctx, agent } = await harness({ level: 'full' })
    expect(await run(ctx, agent, '/ponytail lite')).toBe('Ponytail mode: lite.')
    expect(await promptOf(ctx, agent)).toContain('PONYTAIL MODE (level: lite)')
  })

  it('rejects an unknown level and keeps the current one', async () => {
    const { ctx, agent } = await harness({ level: 'full' })
    expect(await run(ctx, agent, '/ponytail turbo')).toContain('unknown level "turbo"')
    expect(await promptOf(ctx, agent)).toContain('level: full')
  })

  it('contributes nothing while off', async () => {
    const { ctx, agent } = await harness({ level: 'full' })
    await run(ctx, agent, '/ponytail off')

    expect(await promptOf(ctx, agent)).not.toContain('PONYTAIL MODE')
  })

  it('refuses to load with a level the mode cannot run', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(CommandRuntime)
    await expect(ctx.plugin(Ponytail, { level: 'turbo' as Ponytail.PonytailLevel }))
      .rejects.toThrow('ponytail level must be one of')
  })
})

describe('automatic switching', () => {
  it('starts a coding-preset session at lite', async () => {
    const { ctx, agent } = await harness({}, 'standard')

    expect(await promptOf(ctx, agent)).toContain('PONYTAIL MODE (level: lite)')
    expect(await run(ctx, agent, '/ponytail')).toContain('Ponytail mode: lite (auto: coding preset "standard").')
  })

  it('keeps a session under a non-coding preset at the configured level', async () => {
    const { ctx, agent } = await harness({}, 'minimal')

    expect(await promptOf(ctx, agent)).toContain('PONYTAIL MODE (level: full)')
  })

  it('follows the preset a session switches to', async () => {
    const { ctx, agent } = await harness({}, 'minimal')
    ctx.emit('agent-preset/selected', agent.session.id, 'ptc')

    expect(await promptOf(ctx, agent)).toContain('PONYTAIL MODE (level: lite)')
  })

  it('lets an explicit choice win over the coding rule, and auto hands the session back', async () => {
    const { ctx, agent } = await harness({}, 'standard')
    expect(await run(ctx, agent, '/ponytail full')).toBe('Ponytail mode: full.')
    expect(await promptOf(ctx, agent)).toContain('level: full')

    expect(await run(ctx, agent, '/ponytail auto')).toBe('Ponytail mode: lite (auto: coding preset "standard").')
    expect(await promptOf(ctx, agent)).toContain('level: lite')
  })

  it('switches a long task to lite once the step count passes the threshold', () => {
    const rules = Ponytail.resolveAutoRules({ autoLongTaskSteps: 20 })

    expect(Ponytail.autoLevel(rules, { steps: 19 })).toBeUndefined()
    expect(Ponytail.autoLevel(rules, { steps: 20 })).toBe('lite')
    expect(Ponytail.autoLevel(Ponytail.resolveAutoRules({ autoLongTaskSteps: 0 }), { steps: 500 })).toBeUndefined()
  })

  it('applies the shipped coding presets unless the deployment names its own', () => {
    const shipped = Ponytail.resolveAutoRules({})
    expect(Ponytail.autoLevel(shipped, { preset: 'ptc' })).toBe('lite')
    expect(Ponytail.autoLevel(shipped, { preset: 'minimal' })).toBeUndefined()

    const custom = Ponytail.resolveAutoRules({ autoCodingPresets: ['minimal'] })
    expect(Ponytail.autoLevel(custom, { preset: 'minimal' })).toBe('lite')
    expect(Ponytail.autoLevel(custom, { preset: 'standard' })).toBeUndefined()
  })

  it('rejects automatic rules the deployment cannot mean', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(CommandRuntime)

    await expect(ctx.plugin(Ponytail, { autoLongTaskSteps: -1 })).rejects.toThrow('autoLongTaskSteps must be an integer >= 0')
    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(SystemPrompt, {})
    await second.plugin(CommandRuntime)
    await expect(second.plugin(Ponytail, { autoCodingPresets: [''] })).rejects.toThrow('autoCodingPresets must be an array')
  })
})

describe('ponytail commands', () => {
  it('reports the level and the gestures when called without an argument', async () => {
    const { ctx, agent } = await harness()
    const text = await run(ctx, agent, '/ponytail')

    expect(text).toContain('Ponytail mode: full.')
    expect(text).toContain('/ponytail-debt')
  })

  it('serves the reference card and the benchmark card', async () => {
    const { ctx, agent } = await harness()
    const help = await run(ctx, agent, '/ponytail-help')
    const gain = await run(ctx, agent, '/ponytail-gain')

    expect(help).toContain('/ponytail-review')
    expect(help).toContain('Coding preset')
    expect(gain).toContain('benchmark')
    expect(gain).toContain('/ponytail-debt')
  })

  it('steers the agent with the review and audit workflows', async () => {
    const { ctx, agent, inject } = await harness()
    expect(await run(ctx, agent, '/ponytail-review')).toBe('Ponytail review sent to the agent.')
    expect(await run(ctx, agent, '/ponytail-audit')).toBe('Ponytail audit sent to the agent.')

    expect(inject).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(inject.mock.calls[0])).toContain('Review the current change')
    expect(JSON.stringify(inject.mock.calls[1])).toContain('Audit this repository')
  })

  it('reports an error when the session has no working directory', async () => {
    const { ctx, agent } = await harness()
    const text = await run(ctx, agent, '/ponytail-debt')

    expect(text).toContain('no working directory')
  })
})

describe('shortcut ledger', () => {
  it('collects markers, groups them by file, and flags the ones with no trigger', () => {
    const root = mkdtempSync(join(tmpdir(), 'ponytail-debt-'))
    directories.push(root)
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'lock.ts'), [
      '// shortcut: global lock, per-account locks if throughput matters',
      '// shortcut: naive scan',
      'const a = 1',
    ].join('\n'))
    writeFileSync(join(root, 'README.md'), '`shortcut: prose, not a marker`\n')
    writeFileSync(join(root, 'notes.txt'), '// shortcut: ignored extension\n')

    const scan = Ponytail.scanShortcutLedger(root)
    const report = Ponytail.renderLedger(scan)

    expect(scan.rows.map(row => [row.file, row.line, row.noTrigger])).toEqual([
      ['src/lock.ts', 1, false],
      ['src/lock.ts', 2, true],
    ])
    expect(report).toContain('src/lock.ts')
    expect(report).toContain('[no-trigger]')
    expect(report).toContain('2 markers, 1 with no trigger.')
  })

  it('reports a clean ledger for a workspace with no markers', () => {
    const root = mkdtempSync(join(tmpdir(), 'ponytail-clean-'))
    directories.push(root)
    writeFileSync(join(root, 'main.ts'), 'export const value = 1\n')

    expect(Ponytail.renderLedger(Ponytail.scanShortcutLedger(root))).toBe('No shortcut debt in 1 scanned files. Clean ledger.')
  })
})
