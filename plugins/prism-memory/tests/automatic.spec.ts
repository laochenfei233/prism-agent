/**
 * The automatic half of the plugin, driven through the real Harness spine.
 *
 * These specs run the production storage, session, projection, tool, and agent
 * loop services, so an assertion about what the plugin wrote or injected is an
 * assertion about durable records and about the bytes a model receives. The
 * claims under test are the ones a deployment would notice: a turn deposits what
 * it stated, standing memory arrives without being asked for, a recorded date
 * surfaces, and nothing automatic ever reaches a model unreviewed.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import {
  appendAssistant,
  appendUser,
  createAgent,
  drivePreStep,
  driveTurnStopping,
  mountMemory,
  textOf,
} from './fixtures/harness.ts'

const owned = new Set<Context>()
const trees: string[] = []
afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
  await Promise.all(trees.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function boot(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = await mountMemory({ config, tools: true, commands: true })
  owned.add(ctx)
  return ctx
}

/** An empty temporary working directory this spec owns. */
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prism-memory-auto-'))
  trees.push(root)
  return root
}

describe('distilling a turn', () => {
  it('writes what the person stated, without asking a model to do it', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'distil-user')
    appendUser(agent, 'Please note that I prefer tabs over spaces in this file.')

    await driveTurnStopping(ctx, agent)

    const stored = ctx.prismMemory.all()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.layer).toBe('user')
    expect(stored[0]?.kind).toBe('preference')
    expect(stored[0]?.origin).toBe('session')
    expect(stored[0]?.evidence.sessionId).toBe(agent.session.id)
  })

  it('writes what the assistant established', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'distil-assistant')
    appendUser(agent, 'why did the rebuild not pick up my change')
    appendAssistant(agent, 'The root cause was a stale build cache that survived the rebuild.')

    await driveTurnStopping(ctx, agent)

    const stored = ctx.prismMemory.all()
    expect(stored.map(record => record.layer)).toEqual(['lesson'])
  })

  it('parks a distilled claim for review unless the deployment says otherwise', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'distil-pending')
    appendUser(agent, 'You must never run the release script from a dirty tree.')
    await driveTurnStopping(ctx, agent)

    expect(ctx.prismMemory.all()[0]?.status).toBe('pending')
    // Pending never injects, so the turn a person typed costs nothing extra.
    const { messages } = await drivePreStep(ctx, agent, 'how do I cut a release')
    expect(messages).toHaveLength(1)
  })

  it('stores it live when the deployment trusts the class of claim', async () => {
    const ctx = await boot({ autoDistillStatus: 'active', autoDistillConfidence: 0.8 })
    const agent = await createAgent(ctx, 'distil-active')
    appendUser(agent, 'You must never run the release script from a dirty tree.')
    await driveTurnStopping(ctx, agent)

    expect(ctx.prismMemory.all()[0]?.status).toBe('active')
    const { messages } = await drivePreStep(ctx, agent, 'cutting a release now')
    expect(messages).toHaveLength(2)
    // A rule is an identity layer, so it arrives as standing memory rather than
    // waiting for the turn to mention it.
    const block = textOf(messages[1] as UserMessage)
    expect(block).toContain('Standing memory:')
    expect(block).toContain('never run the release script')
  })

  it('does not store the same claim twice across turns, nor inflate its reuse count', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'distil-repeat')
    const text = 'You must never run the release script from a dirty tree.'

    appendUser(agent, text)
    await driveTurnStopping(ctx, agent)
    const first = ctx.prismMemory.all()[0]

    appendUser(agent, text)
    await driveTurnStopping(ctx, agent)
    const after = ctx.prismMemory.all()

    expect(after).toHaveLength(1)
    expect(after[0]?.id).toBe(first?.id)
    // The write path would have raised `hits`; an automatic pass must not, since
    // reuse is read as evidence that a human or a model actually reached for it.
    expect(after[0]?.hits).toBe(0)
  })

  it('writes nothing when the deployment turns distillation off', async () => {
    const ctx = await boot({ autoDistill: false })
    const agent = await createAgent(ctx, 'distil-off')
    appendUser(agent, 'You must never run the release script from a dirty tree.')
    await driveTurnStopping(ctx, agent)
    expect(ctx.prismMemory.all()).toEqual([])
  })
})

describe('the consolidation window', () => {
  it('runs once the corpus has moved far enough and journals what it concluded', async () => {
    const ctx = await boot({ dreamEveryWrites: 1, dailyReflection: false })
    const agent = await createAgent(ctx, 'dream-window')
    await ctx.prismMemory.remember({ text: 'the default storage backend is sqlite' }, agent)

    appendUser(agent, 'nothing durable in this message at all')
    await driveTurnStopping(ctx, agent)

    const journal = ctx.prismMemory.journal(agent)
    expect(journal).toHaveLength(1)
    expect(journal[0]?.tags).toContain('dream-journal')
    expect(journal[0]?.status).toBe('archived')
  })

  it('stays quiet until the window fills', async () => {
    const ctx = await boot({ dreamEveryWrites: 25, dailyReflection: false })
    const agent = await createAgent(ctx, 'dream-quiet')
    await ctx.prismMemory.remember({ text: 'the default storage backend is sqlite' }, agent)
    await driveTurnStopping(ctx, agent)
    expect(ctx.prismMemory.journal(agent)).toEqual([])
  })

  it('confirms a claim two conversations wrote and never resolves a contradiction', async () => {
    const ctx = await boot({ dreamEveryWrites: 1, dailyReflection: false })
    const first = await createAgent(ctx, 'dream-a')
    const second = await createAgent(ctx, 'dream-b')
    const claim = 'the default storage backend is sqlite'
    const stored = await ctx.prismMemory.remember({ text: claim, tags: ['backend'] }, first)
    await ctx.prismMemory.remember({ text: claim, tags: ['backend'] }, second)
    await ctx.prismMemory.remember({
      text: 'the default storage backend is postgres',
      tags: ['backend'],
    }, second)

    const report = await ctx.prismMemory.dream({ apply: true })
    expect(report.corroborated.map(entry => entry.id)).toEqual([stored.record.id])
    expect(ctx.prismMemory.all().find(record => record.id === stored.record.id)?.corroboratedAt).not.toBeNull()
    // The contradiction is reported and both claims survive: choosing between
    // them is a judgement, and the pass does not make it.
    expect(report.conflicts).toHaveLength(1)
    expect(ctx.prismMemory.all().filter(record => record.status === 'active')).toHaveLength(2)
  })

  it('does a dry run without writing when asked', async () => {
    const ctx = await boot({ dreamEveryWrites: 1, dailyReflection: false })
    const agent = await createAgent(ctx, 'dream-dry')
    await ctx.prismMemory.remember({ text: 'the default storage backend is sqlite' }, agent)
    const before = ctx.prismMemory.all().length

    const report = await ctx.prismMemory.dream({ apply: false })
    expect(report.applied).toBe(false)
    expect(report.journalId).toBeNull()
    expect(ctx.prismMemory.all()).toHaveLength(before)
  })
})

describe('standing memory and dates', () => {
  it('injects a preference on the first turn without a keyword match', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'identity')
    await ctx.prismMemory.remember({ text: 'prefers short answers with no preamble', layer: 'user' }, agent)

    const { messages } = await drivePreStep(ctx, agent, 'what is the weather like today')
    expect(messages).toHaveLength(2)
    expect(textOf(messages[1] as UserMessage)).toContain('Standing memory:')
  })

  it('leaves a relevance layer to keyword recall', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'identity-off')
    await ctx.prismMemory.remember({ text: 'the release script lives under scripts', layer: 'project' }, agent)

    const { messages } = await drivePreStep(ctx, agent, 'what is the weather like today')
    expect(messages).toHaveLength(1)
  })

  it('injects nothing standing when the deployment configures no identity layer', async () => {
    const ctx = await boot({ identityLayers: [] })
    const agent = await createAgent(ctx, 'identity-none')
    await ctx.prismMemory.remember({ text: 'prefers short answers with no preamble', layer: 'user' }, agent)
    const { messages } = await drivePreStep(ctx, agent, 'what is the weather like today')
    expect(messages).toHaveLength(1)
  })

  it('surfaces a claim whose recorded date has arrived', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'due')
    await ctx.prismMemory.remember({
      text: 'rotate the staging credentials',
      dueAt: Date.now() - 1_000,
    }, agent)

    const { messages } = await drivePreStep(ctx, agent, 'what is the weather like today')
    expect(textOf(messages[1] as UserMessage)).toContain('Due now')
    expect(textOf(messages[1] as UserMessage)).toContain('rotate the staging credentials')
  })

  it('leaves a date beyond the reminder window alone', async () => {
    const ctx = await boot({ reminderWindowDays: 1 })
    const agent = await createAgent(ctx, 'due-later')
    await ctx.prismMemory.remember({
      text: 'rotate the staging credentials',
      dueAt: Date.now() + 30 * 86_400_000,
    }, agent)
    const { messages } = await drivePreStep(ctx, agent, 'what is the weather like today')
    expect(messages).toHaveLength(1)
  })
})

describe('orientation and per-step recall', () => {
  it('says nothing beyond what the corpus holds unless the deployment asks it to', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'orientation-off')
    const { messages } = await drivePreStep(ctx, agent, 'a first message with no memory behind it')
    expect(messages).toHaveLength(1)
  })

  it('carries the local date on a first turn when enabled', async () => {
    const ctx = await boot({ orientationEnabled: true })
    const agent = await createAgent(ctx, 'orientation-on')
    const { messages } = await drivePreStep(ctx, agent, 'a first message with no memory behind it')
    expect(messages).toHaveLength(2)
    const block = textOf(messages[1] as UserMessage)
    expect(block).toMatch(/Today is \w+day, \d{4}-\d{2}-\d{2}/)
  })

  it('stays on the first step unless the deployment asks for more', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'steps-off')
    await ctx.prismMemory.remember({ text: 'the default storage backend is sqlite' }, agent)
    const { messages } = await drivePreStep(ctx, agent, 'which storage backend is the default', 2)
    expect(messages).toHaveLength(1)
  })

  it('recalls on a later step when the deployment asks for it', async () => {
    const ctx = await boot({ injectEveryStep: true })
    const agent = await createAgent(ctx, 'steps-on')
    await ctx.prismMemory.remember({ text: 'the default storage backend is sqlite' }, agent)
    const { messages } = await drivePreStep(ctx, agent, 'which storage backend is the default', 2)
    expect(messages).toHaveLength(2)
    expect(textOf(messages[1] as UserMessage)).toContain('Possibly relevant memory:')
  })
})

describe('importing another tool\'s memory', () => {
  it('reads the workspace instruction file into project-scoped claims', async () => {
    const ctx = await boot()
    const cwd = await scratch()
    await writeFile(join(cwd, 'AGENTS.md'), '# Rules\n- Never commit credentials to the repository.\n')
    const agent = await createAgent(ctx, 'import', cwd)

    const dry = await ctx.prismMemory.importMemories({ sources: ['workspace'], agent })
    expect(dry.applied).toBe(false)
    expect(dry.scanned).toBe(1)
    expect(dry.created).toEqual([])
    expect(ctx.prismMemory.all()).toEqual([])

    const applied = await ctx.prismMemory.importMemories({ sources: ['workspace'], apply: true, agent })
    expect(applied.created).toHaveLength(1)
    const [stored] = ctx.prismMemory.all()
    expect(stored?.origin).toBe('import')
    expect(stored?.layer).toBe('rule')
    expect(stored?.scope).toBe('project')
    expect(stored?.status).toBe('pending')
    expect(stored?.evidence.note).toContain('AGENTS.md')
  })

  it('counts a claim it already knows instead of storing it twice', async () => {
    const ctx = await boot()
    const cwd = await scratch()
    await writeFile(join(cwd, 'AGENTS.md'), '# Rules\n- Never commit credentials to the repository.\n')
    const agent = await createAgent(ctx, 'import-twice', cwd)

    await ctx.prismMemory.importMemories({ sources: ['workspace'], apply: true, agent })
    const second = await ctx.prismMemory.importMemories({ sources: ['workspace'], apply: true, agent })
    expect(second.skipped).toBe(1)
    expect(second.created).toEqual([])
    expect(ctx.prismMemory.all()).toHaveLength(1)
  })

  it('refuses to guess a source rather than reading nothing', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'import-none')
    const error = await ctx.prismMemory.importMemories({ agent }).catch((thrown: unknown) => thrown)
    expect(error).toMatchObject({ code: 'PRISM_MEMORY_NO_IMPORT_SOURCE' })
  })
})
