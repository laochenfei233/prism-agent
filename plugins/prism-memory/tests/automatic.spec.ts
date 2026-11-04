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
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmFailure, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import PrismMemory from '../src/index.ts'
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

const DAY = 86_400_000

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

  it('writes the person\'s constraint live on the shipped defaults', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'distil-user-active')
    appendUser(agent, 'You must never run the release script from a dirty tree.')
    await driveTurnStopping(ctx, agent)

    // The person's own words are the trusted tier: active above the review
    // floor, so it arrives as standing memory without anyone approving it.
    expect(ctx.prismMemory.all()[0]?.status).toBe('active')
    const { messages } = await drivePreStep(ctx, agent, 'cutting a release now')
    expect(messages).toHaveLength(2)
    // A rule is an identity layer, so it arrives as standing memory rather than
    // waiting for the turn to mention it.
    const block = textOf(messages[1] as UserMessage)
    expect(block).toContain('Standing memory:')
    expect(block).toContain('never run the release script')
  })

  it('parks what the assistant established until it is corroborated', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'distil-assistant-pending')
    appendUser(agent, 'why did the rebuild not pick up my change')
    appendAssistant(agent, 'The root cause was a stale build cache that survived the rebuild.')
    await driveTurnStopping(ctx, agent)

    expect(ctx.prismMemory.all()[0]?.status).toBe('pending')
    // Pending never injects, so the turn a person typed costs nothing extra.
    const { messages } = await drivePreStep(ctx, agent, 'how do I cut a release')
    expect(messages).toHaveLength(1)
  })

  it('parks everything when the deployment asks for review first', async () => {
    const ctx = await boot({ autoDistillStatus: 'pending' })
    const agent = await createAgent(ctx, 'distil-pending')
    appendUser(agent, 'You must never run the release script from a dirty tree.')
    await driveTurnStopping(ctx, agent)

    expect(ctx.prismMemory.all()[0]?.status).toBe('pending')
    const { messages } = await drivePreStep(ctx, agent, 'how do I cut a release')
    expect(messages).toHaveLength(1)
  })

  it('promotes a held claim the person restates in their own turn', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'distil-promote')
    const claim = 'The root cause was a stale build cache that survived the rebuild.'

    appendUser(agent, 'why did the rebuild not pick up my change')
    appendAssistant(agent, claim)
    await driveTurnStopping(ctx, agent)
    const held = ctx.prismMemory.all()[0]
    expect(held?.status).toBe('pending')

    appendUser(agent, `${claim} Remember that.`)
    await driveTurnStopping(ctx, agent)
    const after = ctx.prismMemory.all()
    expect(after).toHaveLength(1)
    expect(after[0]?.status).toBe('active')
    expect(after[0]?.reviewedAt).not.toBeNull()
    expect(after[0]?.reviewNote).toBe('auto-approved: restated at active confidence')
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

  it('confirms a claim two conversations wrote', async () => {
    const ctx = await boot({ dreamEveryWrites: 1, dailyReflection: false })
    const first = await createAgent(ctx, 'dream-a')
    const second = await createAgent(ctx, 'dream-b')
    const claim = 'the default storage backend is sqlite'
    const stored = await ctx.prismMemory.remember({ text: claim, tags: ['backend'] }, first)
    await ctx.prismMemory.remember({ text: claim, tags: ['backend'] }, second)

    const report = await ctx.prismMemory.dream({ apply: true })
    expect(report.corroborated.map(entry => entry.id)).toEqual([stored.record.id])
    expect(ctx.prismMemory.all().find(record => record.id === stored.record.id)?.corroboratedAt).not.toBeNull()
  })

  it('promotes a held claim a second conversation corroborated', async () => {
    const ctx = await boot({ dreamEveryWrites: 1, dailyReflection: false })
    const first = await createAgent(ctx, 'dream-hold-a')
    const second = await createAgent(ctx, 'dream-hold-b')
    const claim = 'the ingest pipeline runs hourly'
    const held = await ctx.prismMemory.remember({ text: claim, tags: ['pipeline'], confidence: 0.2 }, first)
    expect(held.record.status).toBe('pending')
    // The identical write from the other conversation corroborates the held
    // record instead of duplicating it.
    await ctx.prismMemory.remember({ text: claim, tags: ['pipeline'], confidence: 0.2 }, second)
    expect(ctx.prismMemory.all()).toHaveLength(1)

    const report = await ctx.prismMemory.dream({ apply: true })
    expect(report.promoted).toEqual([held.record.id])
    const promoted = ctx.prismMemory.all().find(record => record.id === held.record.id)
    expect(promoted?.status).toBe('active')
    expect(promoted?.corroboratedAt).not.toBeNull()
    expect(promoted?.reviewedAt).not.toBeNull()
    expect(promoted?.reviewNote).toBe('auto-approved: corroborated by another conversation')
  })

  it('settles a contradiction by recency: the newer claim supersedes the older', async () => {
    const ctx = await boot({ dreamEveryWrites: 1, dailyReflection: false })
    const agent = await createAgent(ctx, 'dream-resolve')
    const older = await ctx.prismMemory.remember({
      text: 'the default storage backend is sqlite',
      tags: ['backend'],
    }, agent)
    await new Promise(resolve => setTimeout(resolve, 3))
    const newer = await ctx.prismMemory.remember({
      text: 'the default storage backend is postgres',
      tags: ['backend'],
    }, agent)

    const report = await ctx.prismMemory.dream({ apply: true })
    expect(report.resolved).toHaveLength(1)
    expect(report.resolved[0]?.left).toBe(older.record.id)
    expect(report.resolved[0]?.right).toBe(newer.record.id)
    expect(report.conflicts).toEqual([])
    const replaced = ctx.prismMemory.all().find(record => record.id === older.record.id)
    expect(replaced?.status).toBe('superseded')
    expect(replaced?.supersededBy).toBe(newer.record.id)
    const standing = ctx.prismMemory.all().find(record => record.id === newer.record.id)
    expect(standing?.status).toBe('active')
    expect(standing?.supersedes).toBe(older.record.id)
    // A wrong recency choice is one command away from undone.
    await ctx.prismMemory.restore(older.record.id, 'recency was wrong here', agent)
    expect(ctx.prismMemory.all().find(record => record.id === older.record.id)?.status).toBe('active')
  })

  it('leaves a contradiction to a person when the deployment says so', async () => {
    const ctx = await boot({ dreamEveryWrites: 1, dailyReflection: false, dreamAutoResolveConflicts: false })
    const first = await createAgent(ctx, 'dream-keep-a')
    const second = await createAgent(ctx, 'dream-keep-b')
    await ctx.prismMemory.remember({ text: 'the default storage backend is sqlite', tags: ['backend'] }, first)
    await ctx.prismMemory.remember({ text: 'the default storage backend is postgres', tags: ['backend'] }, second)

    const report = await ctx.prismMemory.dream({ apply: true })
    // The contradiction is reported and both claims survive: choosing between
    // them stays a human judgement on this deployment.
    expect(report.conflicts).toHaveLength(1)
    expect(report.resolved).toEqual([])
    expect(ctx.prismMemory.all().filter(record => record.status === 'active')).toHaveLength(2)
  })

  it('writes a topic digest live on the shipped defaults', async () => {
    const ctx = await boot({ dreamEveryWrites: 1, dailyReflection: false })
    const agent = await createAgent(ctx, 'digest-live')
    await ctx.prismMemory.remember({ text: 'the deploy pipeline gates on smoke', tags: ['deploy'] }, agent)
    await ctx.prismMemory.remember({ text: 'the deploy pipeline tags every image', tags: ['deploy'] }, agent)
    await ctx.prismMemory.remember({ text: 'the deploy pipeline rolls out canary first', tags: ['deploy'] }, agent)

    await ctx.prismMemory.dream({ apply: true })
    const digest = ctx.prismMemory.all().find(record => record.tags.includes('dream-topic'))
    expect(digest?.status).toBe('active')
  })

  it('runs the hygiene pass with the committed consolidation', async () => {
    const ctx = await boot({ dreamEveryWrites: 1, dailyReflection: false })
    const agent = await createAgent(ctx, 'auto-maintain')
    const expiring = await ctx.prismMemory.remember({
      text: 'the staging window closes on friday',
      ttlDays: 1,
    }, agent)

    const report = await ctx.prismMemory.dream({ apply: true, now: Date.now() + 2 * DAY })
    expect(report.maintenance?.expired).toEqual([expiring.record.id])
    expect(ctx.prismMemory.all().find(record => record.id === expiring.record.id)?.status).toBe('archived')
  })

  it('holds every automatic gate while requireApproval is set', async () => {
    const ctx = await boot({ requireApproval: true, dreamEveryWrites: 1, dailyReflection: false })
    const first = await createAgent(ctx, 'gate-a')
    const second = await createAgent(ctx, 'gate-b')
    const held = await ctx.prismMemory.remember({ text: 'the ingest pipeline runs hourly', confidence: 0.2 }, first)
    await ctx.prismMemory.remember({ text: 'the ingest pipeline runs hourly', confidence: 0.2 }, second)

    const report = await ctx.prismMemory.dream({ apply: true })
    expect(report.promoted).toEqual([])
    expect(ctx.prismMemory.all().find(record => record.id === held.record.id)?.status).toBe('pending')
  })

  it('keeps a digest pending while requireApproval holds', async () => {
    // Seed live claims first: review holds every write, so a corpus grown
    // entirely under `requireApproval` never clusters — the gate below is what
    // stops an existing cluster's digest from reaching recall anyway.
    const root = await scratch()
    const path = join(root, 'digest-hold.db')
    const first = await mountMemory({ config: { dreamEveryWrites: 1, dailyReflection: false }, storagePath: path, tools: true })
    owned.add(first)
    const seeder = await createAgent(first, 'digest-seed')
    for (const text of ['the deploy pipeline gates on smoke', 'the deploy pipeline tags every image', 'the deploy pipeline rolls out canary first']) {
      await first.prismMemory.remember({ text, tags: ['deploy'] }, seeder)
    }
    await first.fiber.dispose()
    owned.delete(first)

    const second = await mountMemory({ config: { requireApproval: true, dreamEveryWrites: 1, dailyReflection: false }, storagePath: path, tools: true })
    owned.add(second)
    await second.prismMemory.dream({ apply: true })
    const digest = second.prismMemory.all().find(record => record.tags.includes('dream-topic'))
    expect(digest?.status).toBe('pending')
  })

  it('skips a pair whose newer claim already carries a supersedes back-link', async () => {
    const ctx = await boot({ dreamEveryWrites: 1, dailyReflection: false })
    const agent = await createAgent(ctx, 'fan-in')
    const olderA = await ctx.prismMemory.remember({
      text: 'the release window opens on monday',
      tags: ['window'],
    }, agent)
    await new Promise(resolve => setTimeout(resolve, 3))
    const olderB = await ctx.prismMemory.remember({
      text: 'the release window opens on tuesdays',
      tags: ['window'],
    }, agent)
    await new Promise(resolve => setTimeout(resolve, 3))
    const newer = await ctx.prismMemory.remember({
      text: 'the release window opens on wednesday',
      tags: ['window'],
    }, agent)

    const report = await ctx.prismMemory.dream({ apply: true })
    // Whichever pair sorts first settles and chains; the remaining pairs stay
    // open for a person rather than overwriting the winner's back-link or
    // superseding an already-settled record twice.
    expect(report.resolved).toHaveLength(1)
    expect(report.conflicts).toHaveLength(2)
    const [settled] = report.resolved
    const winner = ctx.prismMemory.all().find(record => record.id === settled?.right)
    expect(winner?.status).toBe('active')
    expect(winner?.supersedes).toBe(settled?.left)
    const loser = ctx.prismMemory.all().find(record => record.id === settled?.left)
    expect(loser?.status).toBe('superseded')
    expect(loser?.supersededBy).toBe(settled?.right)
    const untouchedId = [olderA.record.id, olderB.record.id, newer.record.id]
      .find(id => id !== settled?.left && id !== settled?.right)
    const untouched = ctx.prismMemory.all().find(record => record.id === untouchedId)
    expect(untouched?.status).toBe('active')
    expect(untouched?.supersedes).toBeNull()
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
    // The import source is a file the operator chose to read, so it lands live.
    expect(stored?.status).toBe('active')
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

/** A scripted extraction backend: one canned answer, or a provider failure. */
class ExtractionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly answer: string | LlmFailure) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 4096 } })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (typeof this.answer === 'string') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: this.answer } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'finish', reason: { kind: 'error', failure: this.answer } }
  }
}

describe('model-read extraction', () => {
  // Past the llmDistillMinChars floor, and phrased outside every distiller form
  // so the two readers do not overlap in these specs.
  const TURN = 'we spent this session on the release pipeline, and I want the smoke suite to stay the gate before any deploy goes out'

  it('reads the turn with a model call and files claims by their trust tier', async () => {
    const ctx = await boot({ llmDistill: true })
    const adapter = new ExtractionAdapter(JSON.stringify([
      { text: 'the deploy pipeline gates on the smoke suite', layer: 'project', kind: 'fact', source: 'inferred' },
      { text: 'I prefer releases to be cut on tuesdays', layer: 'user', kind: 'preference', source: 'user' },
      { text: 'garbage', layer: 'nonsense', kind: 'fact', source: 'user' },
    ]))
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await createAgent(ctx, 'llm-tiers')
    appendUser(agent, TURN)

    await driveTurnStopping(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.purpose).toBe('memory-distill')
    expect(adapter.requests[0]?.provider).toBe('mock')
    expect(adapter.requests[0]?.sessionId).toBe(agent.session.id)
    const stored = ctx.prismMemory.all()
    expect(stored).toHaveLength(2)
    const inferred = stored.find(record => record.text.includes('smoke suite'))
    expect(inferred?.status).toBe('pending')
    const stated = stored.find(record => record.text.includes('tuesdays'))
    expect(stated?.status).toBe('active')
    expect(stated?.evidence.note).toContain('model-read extraction')
  })

  it('never fails the turn when the provider fails', async () => {
    const ctx = await boot({ llmDistill: true })
    ctx.llm.registerAdapter(['mock'], new ExtractionAdapter({ message: 'provider down', code: 'PROVIDER_DOWN' }))
    const agent = await createAgent(ctx, 'llm-error')
    appendUser(agent, TURN)

    await expect(driveTurnStopping(ctx, agent)).resolves.toBeUndefined()
    expect(ctx.prismMemory.all()).toEqual([])
  })

  it('reads nothing out of an answer that is not a claim array', async () => {
    const ctx = await boot({ llmDistill: true })
    const adapter = new ExtractionAdapter('I would rather not answer that in JSON.')
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await createAgent(ctx, 'llm-prose')
    appendUser(agent, TURN)

    await driveTurnStopping(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(ctx.prismMemory.all()).toEqual([])
  })

  it('skips a turn too short to be worth a request', async () => {
    const ctx = await boot({ llmDistill: true })
    const adapter = new ExtractionAdapter('[]')
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await createAgent(ctx, 'llm-short')
    appendUser(agent, 'hi there')

    await driveTurnStopping(ctx, agent)
    expect(adapter.requests).toHaveLength(0)
  })

  it('fails to load with the channel on but no llm service mounted', async () => {
    const ctx = new Context()
    owned.add(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageSqlite, { path: ':memory:' })
    await ctx.plugin(StorageDomain, { backend: 'sqlite' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(AgentRegistry)

    await expect(ctx.plugin(PrismMemory, { llmDistill: true })).rejects.toThrow(/llmDistill/)
  })
})

describe('the backlog on upgrade', () => {
  it('promotes the backlog the tier policy trusts and holds the rest', async () => {
    const root = await scratch()
    const path = join(root, 'backlog.db')
    const first = await mountMemory({ config: { requireApproval: true }, storagePath: path, tools: true })
    owned.add(first)
    const seeder = await createAgent(first, 'seed')
    await first.prismMemory.remember({ text: 'prefers concise release notes', layer: 'user', origin: 'session', confidence: 0.2 }, seeder)
    await first.prismMemory.remember({ text: 'imported rule about credentials', origin: 'import', confidence: 0.2 }, seeder)
    await first.prismMemory.remember({ text: 'a note a model wrote about ingest', origin: 'model', confidence: 0.2 }, seeder)
    expect(first.prismMemory.all().every(record => record.status === 'pending')).toBe(true)
    await first.fiber.dispose()
    owned.delete(first)

    const second = await mountMemory({ config: {}, storagePath: path, tools: true })
    owned.add(second)
    const stored = second.prismMemory.all()
    const stated = stored.find(record => record.text.includes('concise'))
    expect(stated?.status).toBe('active')
    expect(stated?.reviewNote).toBe('auto-approved on upgrade: stated by the person')
    expect(stored.find(record => record.text.includes('imported'))?.status).toBe('active')
    expect(stored.find(record => record.text.includes('model wrote'))?.status).toBe('pending')
  })
})
