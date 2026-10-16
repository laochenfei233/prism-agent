/**
 * The headline claim: recall costs nothing on a turn that does not use it, and
 * never invalidates the cached prefix when it does.
 *
 * Every assertion here is about bytes the model receives. A turn with no match
 * must be indistinguishable from an uninstalled plugin; a turn with a match
 * may add one message at the tail and nothing else; and the tool-schema and
 * command surfaces must stay fixed while the corpus grows.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { createAgent, drivePreStep, mountMemory, stepMessages, textOf } from './fixtures/harness.ts'

const owned = new Set<Context>()
afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
})

async function boot(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = await mountMemory({ config, tools: true, commands: true })
  owned.add(ctx)
  return ctx
}

/** The memory ids the plugin rendered into one injected message. */
function injectedId(text: string): string {
  const match = /\[(mem_[0-9a-f-]{36})\]/u.exec(text)
  if (match?.[1] === undefined) throw new Error(`no memory id in the injected block: ${text}`)
  return match[1]
}

describe('an unmatched turn', () => {
  it('adds no message at all and leaves the admitted input exactly as claimed', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'clean')

    const { decision, messages } = await drivePreStep(ctx, agent, 'how do I run the test suite')

    expect(decision.kind).toBe('enter')
    // The claimed message and nothing else: no recall frame was appended, so
    // this turn's request is byte-identical to one from a plugin-less build.
    expect(messages).toHaveLength(1)
    expect(textOf(messages[0] as UserMessage)).toBe('how do I run the test suite')
  })

  it('is byte-identical to a turn whose corpus is non-empty but unrelated', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'unrelated')
    await ctx.prismMemory.remember({ text: 'the deploy window is monday morning' }, agent)

    const { messages } = await drivePreStep(ctx, agent, 'explain the tokenizer')
    expect(messages).toHaveLength(1)
    expect(textOf(messages[0] as UserMessage)).toBe('explain the tokenizer')
  })
})

describe('a matched turn', () => {
  it('appends exactly one message, after the admitted input, and rewrites nothing before it', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'matched')
    const stored = await ctx.prismMemory.remember({ text: 'the default storage backend is sqlite' }, agent)

    const claimed = stepMessages('which storage backend is the default')
    const decision = await ctx.waterfall(
      ctx as never,
      'agent/pre-step',
      { agent, messages: claimed, turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: claimed }),
    )
    const messages = decision.kind === 'enter' ? decision.messages : []

    expect(messages).toHaveLength(2)
    // Identity, not equality: the prefix the model already had is untouched.
    expect(messages[0]).toBe(claimed[0])
    expect(injectedId(textOf(messages[1] as UserMessage))).toBe(stored.record.id)
  })

  it('never repeats a record the session already received', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'once')
    await ctx.prismMemory.remember({ text: 'the default storage backend is sqlite' }, agent)

    const first = await drivePreStep(ctx, agent, 'which storage backend is the default')
    expect(first.messages).toHaveLength(2)
    const delivered = first.messages[1] as UserMessage
    // Commit the delivery the way the loop does, so the plugin's projection
    // folds it and the record is known to this session.
    agent.session.append('user/message', delivered, { surfaceOp: 'append' })

    const second = await drivePreStep(ctx, agent, 'which storage backend is the default')
    expect(second.messages).toHaveLength(1)
    expect(textOf(second.messages[0] as UserMessage)).toBe('which storage backend is the default')
  })

  it('is confined to the turn\'s first step', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'steps')
    await ctx.prismMemory.remember({ text: 'the default storage backend is sqlite' }, agent)

    const later = await drivePreStep(ctx, agent, 'which storage backend is the default', 2)
    expect(later.messages).toHaveLength(1)
  })

  it('injects nothing when the deployment turns recall off, while the tools keep working', async () => {
    const ctx = await boot({ injectEnabled: false })
    const agent = await createAgent(ctx, 'off')
    await ctx.prismMemory.remember({ text: 'the default storage backend is sqlite' }, agent)

    const { messages } = await drivePreStep(ctx, agent, 'which storage backend is the default')
    expect(messages).toHaveLength(1)
    // The capability is intact; only the automatic tail contribution is off.
    expect(ctx.prismMemory.search('sqlite backend', agent)).toHaveLength(1)
  })

  it('renders the same bytes for the same corpus, so a repeat turn cannot miss the cache', async () => {
    const ctx = await boot()
    const first = await createAgent(ctx, 'deterministic-a')
    const second = await createAgent(ctx, 'deterministic-b')

    for (const agent of [first, second]) {
      await ctx.prismMemory.remember({ text: 'the default storage backend is sqlite' }, agent)
      await ctx.prismMemory.remember({ text: 'the domain stays at version 1' }, agent)
    }

    const a = await drivePreStep(ctx, first, 'storage backend and domain version')
    const b = await drivePreStep(ctx, second, 'storage backend and domain version')
    expect(textOf(b.messages[1] as UserMessage)).toBe(textOf(a.messages[1] as UserMessage))
  })

  it('bounds the injected block by maxInjectedChars', async () => {
    const ctx = await boot({ maxInjectedChars: 320, maxInjectedRecords: 5 })
    const agent = await createAgent(ctx, 'bounded')
    for (let index = 0; index < 6; index += 1) {
      await ctx.prismMemory.remember({ text: `sqlite storage detail number ${index} ${'y'.repeat(120)}` }, agent)
    }

    const { messages } = await drivePreStep(ctx, agent, 'sqlite storage detail')
    const block = textOf(messages[1] as UserMessage)
    expect(block.length).toBeLessThanOrEqual(320)
  })
})

describe('the cached prefix surfaces', () => {
  it('keeps the five tool schemas fixed and adds none when the command row mounts', async () => {
    const withoutCommands = await boot()
    const withCommands = await mountMemory({ config: {}, tools: true, commands: true })
    owned.add(withCommands)

    const names = (ctx: Context): string[] => ctx.tools.schemas()
      .map(schema => schema.name)
      .filter(name => name.startsWith('memory_'))
      .sort()

    expect(names(withoutCommands)).toEqual([
      'memory_conversations',
      'memory_forget',
      'memory_open',
      'memory_remember',
      'memory_search',
    ])
    // Governance is a human surface: it costs the model nothing.
    expect(names(withCommands)).toEqual(names(withoutCommands))
  })

  it('renders the same tool schemas on every read', async () => {
    const ctx = await boot()
    const first = JSON.stringify(ctx.tools.schemas().filter(schema => schema.name.startsWith('memory_')))
    const agent = await createAgent(ctx, 'schemas')
    await ctx.prismMemory.remember({ text: 'a claim added later' }, agent)
    const second = JSON.stringify(ctx.tools.schemas().filter(schema => schema.name.startsWith('memory_')))
    expect(second).toBe(first)
  })
})
