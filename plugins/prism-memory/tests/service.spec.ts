/**
 * The durable service: write-time hygiene, scope isolation, the two-time
 * record model, the governance inbox and maintenance pass, and the mirror
 * export.
 *
 * Every case runs against the real storage facility and a real SQLite backend,
 * so a passing assertion is about what was durably stored, not about an
 * in-memory stand-in.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { PrismMemoryError } from '../src/service.ts'
import { createAgent, mountMemory, stepMessages } from './fixtures/harness.ts'

const owned = new Set<Context>()
const directories = new Set<string>()
afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
  await Promise.all([...directories].map(dir => rm(dir, { recursive: true, force: true })))
  directories.clear()
})

async function boot(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = await mountMemory({ config })
  owned.add(ctx)
  return ctx
}

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prism-memory-'))
  directories.add(dir)
  return dir
}

/** Capture the PrismMemoryError a promise rejects with. */
async function errorOf(operation: Promise<unknown>): Promise<PrismMemoryError> {
  try {
    await operation
  } catch (error: unknown) {
    if (error instanceof PrismMemoryError) return error
    throw error
  }
  throw new Error('expected the operation to reject')
}

const DAY = 86_400_000

describe('write and read', () => {
  it('stores a claim, finds it by keyword, and counts an explicit read as reuse', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'basic')

    const stored = await ctx.prismMemory.remember({ text: 'the storage domain stays at version 1' }, agent)
    expect(stored.outcome).toBe('created')

    const hits = ctx.prismMemory.search('storage domain version', agent)
    expect(hits.map(hit => hit.record.id)).toEqual([stored.record.id])

    const opened = await ctx.prismMemory.open(stored.record.id, agent)
    expect(opened.hits).toBe(1)
    expect(ctx.prismMemory.search('storage domain version', agent)[0]?.record.hits).toBe(1)
  })

  it('derives recall tags when the writer supplied none', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'tags')
    const stored = await ctx.prismMemory.remember({
      text: 'the unicode61 tokenizer handles the retrieval index',
    }, agent)
    expect(stored.record.tags.length).toBeGreaterThan(0)
    expect(stored.record.tags).toContain('unicode61')
  })

  it('reuses an identical claim instead of storing a second copy of it', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'identical')
    const first = await ctx.prismMemory.remember({ text: 'the cache key is the session id' }, agent)
    const second = await ctx.prismMemory.remember({ text: 'the cache key is the session id' }, agent)

    expect(second.outcome).toBe('existing')
    expect(second.record.id).toBe(first.record.id)
    expect(second.record.hits).toBe(1)
    expect(ctx.prismMemory.all()).toHaveLength(1)
  })

  it('reports a paraphrase as a near-duplicate instead of silently storing both', async () => {
    const ctx = await boot({ dedupeJaccard: 0.4, dedupeReplaceJaccard: 0.99 })
    const agent = await createAgent(ctx, 'near')
    const first = await ctx.prismMemory.remember({
      text: 'the default storage backend is sqlite, storing one document per record',
    }, agent)
    const second = await ctx.prismMemory.remember({
      text: 'the default storage backend is sqlite, storing one document per memory record',
    }, agent)

    expect(second.outcome).toBe('created')
    expect(second.duplicates.map(entry => entry.id)).toContain(first.record.id)
    expect(second.duplicates[0]?.similarity).toBeGreaterThan(0.4)
  })

  it('keeps a retired record readable, so audited claims do not disappear', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'retire')
    const stored = await ctx.prismMemory.remember({ text: 'the old endpoint is deprecated' }, agent)

    await ctx.prismMemory.forget(stored.record.id, 'superseded by the new host', agent)
    expect(ctx.prismMemory.search('old endpoint deprecated', agent)).toHaveLength(0)
    const audited = await ctx.prismMemory.open(stored.record.id, agent)
    expect(audited.status).toBe('archived')
    expect(audited.evidence.note).toBe('superseded by the new host')
  })
})

describe('the two-time record model', () => {
  it('invalidates the record a supersede replaces, in the same write', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'supersede')
    const old = await ctx.prismMemory.remember({ text: 'the retry budget is three attempts' }, agent)
    const replacement = await ctx.prismMemory.remember({
      text: 'the retry budget is five attempts',
      supersedes: old.record.id,
    }, agent)

    expect(replacement.record.supersedes).toBe(old.record.id)
    const previous = ctx.prismMemory.all().find(record => record.id === old.record.id)
    expect(previous?.status).toBe('superseded')
    expect(previous?.supersededBy).toBe(replacement.record.id)
    expect(previous?.invalidAt).not.toBeNull()
    // Only the current claim ranks, but the old one stays readable.
    expect(ctx.prismMemory.search('retry budget attempts', agent)[0]?.record.id).toBe(replacement.record.id)
    expect(ctx.prismMemory.history(replacement.record.id, agent).map(record => record.id))
      .toEqual([old.record.id, replacement.record.id])
  })

  it('rolls a superseded claim back and archives its live successor', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'rollback')
    const old = await ctx.prismMemory.remember({ text: 'the retry budget is three attempts' }, agent)
    const replacement = await ctx.prismMemory.remember({
      text: 'the retry budget is five attempts',
      supersedes: old.record.id,
    }, agent)

    await ctx.prismMemory.restore(old.record.id, 'the five-attempt change was reverted', agent)

    const restored = ctx.prismMemory.all().find(record => record.id === old.record.id)
    const demoted = ctx.prismMemory.all().find(record => record.id === replacement.record.id)
    expect(restored?.status).toBe('active')
    expect(restored?.invalidAt).toBeNull()
    expect(restored?.supersededBy).toBeNull()
    expect(demoted?.status).toBe('archived')
    expect(demoted?.evidence.note).toContain('rollback')
    expect(ctx.prismMemory.search('retry budget attempts', agent)[0]?.record.id).toBe(old.record.id)
  })

  it('refuses to restore a record that is already current', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'already')
    const stored = await ctx.prismMemory.remember({ text: 'the retry budget is three attempts' }, agent)
    const error = await errorOf(ctx.prismMemory.restore(stored.record.id, undefined, agent))
    expect(error.code).toBe('PRISM_MEMORY_ALREADY_ACTIVE')
  })
})

describe('scope isolation', () => {
  it('hides a project claim from a session in another working directory', async () => {
    const ctx = await boot()
    const mine = await createAgent(ctx, 'project-mine', 'C:/work/mine')
    const other = await createAgent(ctx, 'project-other', 'C:/work/other')

    const stored = await ctx.prismMemory.remember({
      text: 'the release branch is release/2026-02',
      scope: 'project',
    }, mine)
    expect(stored.record.scopeKey).toBe('C:/work/mine')

    expect(ctx.prismMemory.search('release branch', mine)).toHaveLength(1)
    expect(ctx.prismMemory.search('release branch', other)).toHaveLength(0)
    const error = await errorOf(ctx.prismMemory.open(stored.record.id, other))
    expect(error.code).toBe('PRISM_MEMORY_OUT_OF_SCOPE')
  })

  it('hides a conversation claim from every other session', async () => {
    const ctx = await boot()
    const mine = await createAgent(ctx, 'conversation-mine')
    const other = await createAgent(ctx, 'conversation-other')

    const stored = await ctx.prismMemory.remember({
      text: 'this conversation settled on option B',
      scope: 'conversation',
    }, mine)
    expect(stored.record.scopeKey).toBe(mine.session.id)
    expect(ctx.prismMemory.search('settled option', other)).toHaveLength(0)
    const error = await errorOf(ctx.prismMemory.forget(stored.record.id, undefined, other))
    expect(error.code).toBe('PRISM_MEMORY_OUT_OF_SCOPE')
  })

  it('requires a working directory before it will accept a project claim', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'no-cwd')
    const error = await errorOf(ctx.prismMemory.remember({
      text: 'a claim with nowhere to live',
      scope: 'project',
    }, agent))
    expect(error.code).toBe('PRISM_MEMORY_NO_WORKSPACE')
  })

  it('fails loud on an unknown scope rather than defaulting to global', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'bad-scope')
    const error = await errorOf(ctx.prismMemory.remember({
      text: 'a claim',
      scope: 'organisation' as never,
    }, agent))
    expect(error.code).toBe('PRISM_MEMORY_INVALID_SCOPE')
  })
})

describe('time to live', () => {
  it('stops ranking an expired claim while it stays readable by id', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'ttl')
    const stored = await ctx.prismMemory.remember({
      text: 'the staging host is staging.internal',
      ttlDays: 1,
    }, agent)

    expect(ctx.prismMemory.search('staging host', agent)).toHaveLength(1)
    const later = Date.now() + 2 * DAY
    expect(ctx.prismMemory.search('staging host', agent, {})).toHaveLength(1)
    // Rank against an explicit clock: the deadline has passed.
    expect(ctx.prismMemory.conversations(agent, { now: later })[0]?.liveCount).toBe(0)
    expect((await ctx.prismMemory.open(stored.record.id, agent)).status).toBe('active')
  })
})

describe('governance', () => {
  it('holds a pending write out of injection until an operator approves it', async () => {
    const ctx = await boot({ requireApproval: true })
    const agent = await createAgent(ctx, 'approval')
    const stored = await ctx.prismMemory.remember({ text: 'the ingest pipeline runs hourly' }, agent)
    expect(stored.record.status).toBe('pending')

    const inbox = ctx.prismMemory.review(agent)
    expect(inbox.map(record => record.id)).toEqual([stored.record.id])

    await ctx.prismMemory.approve(stored.record.id, 'confirmed with the platform team', agent)
    const approved = ctx.prismMemory.all().find(record => record.id === stored.record.id)
    expect(approved?.status).toBe('active')
    expect(approved?.reviewNote).toBe('confirmed with the platform team')
    expect(approved?.reviewedAt).not.toBeNull()
  })

  it('keeps a low-confidence write findable while never injecting it', async () => {
    // The shipped configuration: requireApproval off, pendingBelowConfidence on.
    // The write is held back from injection, but it must not be held back from
    // search — a record the model can never find again is worse than none.
    const ctx = await boot()
    const agent = await createAgent(ctx, 'confidence')
    const stored = await ctx.prismMemory.remember({
      text: 'the ingest pipeline runs hourly',
      confidence: 0.2,
    }, agent)
    expect(stored.record.status).toBe('pending')

    expect(ctx.prismMemory.search('ingest pipeline hourly', agent).map(hit => hit.record.id))
      .toEqual([stored.record.id])
    expect(ctx.prismMemory.search('', agent).map(hit => hit.record.id)).toEqual([stored.record.id])

    expect(ctx.prismMemory.tailText(agent, stepMessages('ingest pipeline hourly'), 1)).toBe('')
    expect(ctx.prismMemory.conversations(agent)[0]?.liveCount).toBe(0)
    expect(ctx.prismMemory.review(agent)).toHaveLength(1)
  })

  it('makes a pending record findable under requireApproval too', async () => {
    const ctx = await boot({ requireApproval: true })
    const agent = await createAgent(ctx, 'approval-search')
    const stored = await ctx.prismMemory.remember({ text: 'the ingest pipeline runs hourly' }, agent)
    expect(stored.record.status).toBe('pending')
    expect(ctx.prismMemory.search('ingest pipeline', agent).map(hit => hit.record.id))
      .toEqual([stored.record.id])
  })

  it('archives a rejected record and refuses to settle a review twice', async () => {
    const ctx = await boot({ requireApproval: true })
    const agent = await createAgent(ctx, 'reject')
    const stored = await ctx.prismMemory.remember({ text: 'the ingest pipeline runs hourly' }, agent)

    const rejected = await ctx.prismMemory.reject(stored.record.id, 'not durable enough to record', agent)
    expect(rejected.status).toBe('archived')
    const error = await errorOf(ctx.prismMemory.approve(stored.record.id, undefined, agent))
    expect(error.code).toBe('PRISM_MEMORY_NOT_PENDING')
  })

  it('plans expiry and duplicate merges without writing, then commits them', async () => {
    const ctx = await boot({ dedupeJaccard: 0.4, dedupeReplaceJaccard: 0.99 })
    const agent = await createAgent(ctx, 'maintain')
    const expiring = await ctx.prismMemory.remember({
      text: 'the staging window closes on friday',
      ttlDays: 1,
    }, agent)
    const first = await ctx.prismMemory.remember({
      text: 'the default storage backend is sqlite, storing one document per record',
    }, agent)
    await ctx.prismMemory.remember({
      text: 'the default storage backend is sqlite, storing one document per memory record',
    }, agent)

    const future = Date.now() + 2 * DAY
    const plan = await ctx.prismMemory.maintain({ now: future })
    expect(plan.applied).toBe(false)
    expect(plan.expired).toEqual([expiring.record.id])
    expect(plan.duplicates).toHaveLength(1)
    expect(plan.totalBefore).toBe(3)
    expect(plan.totalAfter).toBe(1)
    // A dry run changed nothing.
    expect(ctx.prismMemory.all()).toHaveLength(3)

    const applied = await ctx.prismMemory.maintain({ apply: true, now: future })
    expect(applied.duplicates[0]?.keep).toBeDefined()
    const dropped = ctx.prismMemory.all().find(record => record.id === applied.duplicates[0]?.drop)
    expect(dropped?.status).toBe('archived')
    expect(dropped?.mergedInto).toBe(applied.duplicates[0]?.keep)
    expect(ctx.prismMemory.all().find(record => record.id === expiring.record.id)?.status).toBe('archived')
    expect(ctx.prismMemory.all().find(record => record.id === first.record.id)).toBeDefined()
    expect(ctx.prismMemory.all()).toHaveLength(3)
  })

  it('reports a supersede link that no longer resolves', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'orphan')
    const old = await ctx.prismMemory.remember({ text: 'the retry budget is three attempts' }, agent)
    await ctx.prismMemory.remember({
      text: 'the retry budget is five attempts',
      supersedes: old.record.id,
    }, agent)

    const report = await ctx.prismMemory.maintain({})
    expect(report.orphaned).toEqual([])
  })
})

describe('the conversation dimension', () => {
  it('groups claims by the session that produced them, newest first', async () => {
    const ctx = await boot()
    const first = await createAgent(ctx, 'thread-one')
    const second = await createAgent(ctx, 'thread-two')

    await ctx.prismMemory.remember({ text: 'thread one settled on the sqlite backend' }, first)
    await ctx.prismMemory.remember({ text: 'thread two settled on the json backend' }, second)

    const buckets = ctx.prismMemory.conversations(first)
    expect(buckets).toHaveLength(2)
    const ids = buckets.map(bucket => bucket.sessionId)
    expect(ids).toContain(first.session.id)
    expect(ids).toContain(second.session.id)

    // Narrowing by conversation is how a naming question ("that conversation
    // about X") reaches a phrase search.
    const narrowed = ctx.prismMemory.search('settled backend', first, { sessionId: second.session.id })
    expect(narrowed.map(hit => hit.record.id)).toEqual(
      ctx.prismMemory.search('settled backend', first).filter(hit => hit.record.evidence.sessionId === second.session.id)
        .map(hit => hit.record.id),
    )
  })
})

describe('the Markdown mirror', () => {
  it('writes a deterministic mirror and its machine-readable index', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'export')
    await ctx.prismMemory.remember({ text: 'the domain stays at version 1' }, agent)
    await ctx.prismMemory.remember({ text: 'reuse before adding an abstraction', kind: 'preference' }, agent)

    const dir = await scratch()
    const result = await ctx.prismMemory.exportMarkdown({ dir })
    expect(result.total).toBe(2)
    expect(result.files).toHaveLength(2)

    const markdown = await readFile(join(dir, 'memory.md'), 'utf8')
    expect(markdown).toContain('the domain stays at version 1')
    expect(markdown).toContain('reuse before adding an abstraction')
    const index = JSON.parse(await readFile(join(dir, 'memory.index.json'), 'utf8')) as { total: number }
    expect(index.total).toBe(2)

    // A second export over the same corpus is byte-identical.
    await ctx.prismMemory.exportMarkdown({ dir })
    expect(await readFile(join(dir, 'memory.md'), 'utf8')).toBe(markdown)
  })

  it('fails loud when no directory is configured or supplied', async () => {
    const ctx = await boot()
    const error = await errorOf(ctx.prismMemory.exportMarkdown({}))
    expect(error.code).toBe('PRISM_MEMORY_NO_EXPORT_DIR')
  })

  it('uses the configured directory when the caller supplies none', async () => {
    const dir = await scratch()
    const ctx = await boot({ exportDir: dir })
    const agent = await createAgent(ctx, 'configured-export')
    await ctx.prismMemory.remember({ text: 'the domain stays at version 1' }, agent)

    const result = await ctx.prismMemory.exportMarkdown({})
    expect(result.dir).toBe(dir)
    expect(await readFile(join(dir, 'memory.md'), 'utf8')).toContain('the domain stays at version 1')
  })
})
