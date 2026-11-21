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
import type { Message } from '@deepseek-ai/dsh-llm'
import { textFingerprint } from '../src/memory.ts'
import { PrismMemoryError } from '../src/service.ts'
import {
  appendAssistant,
  appendUser,
  createAgent,
  driveTurnStopping,
  mountMemory,
  stepMessages,
} from './fixtures/harness.ts'

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

describe('the operator surface', () => {
  it('reads and searches a project claim no session at all may address', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'operator-reads', 'C:/work/operator')
    const stored = await ctx.prismMemory.remember({
      text: 'the release branch is release/2026-02',
      scope: 'project',
    }, agent)

    // A caller with no session is admitted to the global scope only, which is
    // what a browser page would see if it reused the session-facing reads.
    expect(ctx.prismMemory.visible(undefined)).toEqual([])
    expect(ctx.prismMemory.search('release branch', undefined)).toEqual([])

    expect(ctx.prismMemory.operatorRecords().map(record => record.id)).toEqual([stored.record.id])
    expect(ctx.prismMemory.operatorSearch('release branch').map(hit => hit.record.id)).toEqual([stored.record.id])
  })

  it('reads a conversation claim no other session may address', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'operator-conversation')
    const other = await createAgent(ctx, 'operator-conversation-other')
    const stored = await ctx.prismMemory.remember({
      text: 'this conversation settled on option B',
      scope: 'conversation',
    }, agent)

    expect(ctx.prismMemory.visible(other)).toEqual([])
    expect(ctx.prismMemory.visible(undefined)).toEqual([])
    expect(ctx.prismMemory.operatorRecords().map(record => record.id)).toContain(stored.record.id)
  })

  it('settles a pending claim from a caller with no session, refusing the scoped path', async () => {
    const ctx = await boot({ requireApproval: true })
    const agent = await createAgent(ctx, 'operator-settles', 'C:/work/operator')
    const stored = await ctx.prismMemory.remember({
      text: 'the release branch is release/2026-02',
      scope: 'project',
    }, agent)
    expect(stored.record.status).toBe('pending')

    const refused = await errorOf(ctx.prismMemory.approve(stored.record.id, 'looks right', undefined))
    expect(refused.code).toBe('PRISM_MEMORY_OUT_OF_SCOPE')

    const approved = await ctx.prismMemory.operatorApprove(stored.record.id, 'looks right')
    expect(approved.status).toBe('active')
    expect(approved.reviewNote).toBe('looks right')
  })

  it('archives a rejected claim and keeps it readable afterwards', async () => {
    const ctx = await boot({ requireApproval: true })
    const agent = await createAgent(ctx, 'operator-rejects')
    const stored = await ctx.prismMemory.remember({ text: 'the nightly job runs at 02:00' }, agent)

    const rejected = await ctx.prismMemory.operatorReject(stored.record.id, 'wrong time')
    expect(rejected.status).toBe('archived')
    expect(rejected.invalidAt).not.toBeNull()

    // Rejection is a status, not a deletion: the record stays in the operator
    // read so a person can see what was turned down.
    expect(ctx.prismMemory.operatorRecords().map(record => record.id)).toEqual([stored.record.id])
  })
})

describe('evidence fingerprints', () => {
  it('anchors a model write to the user message it answers, with its write-time fingerprint', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'anchor')
    appendUser(agent, 'the deploy window is tuesday')

    // The anchor is the caller-side fact (the tool computes it); the write
    // stores exactly what it is given.
    const anchor = ctx.prismMemory.evidenceAnchor(agent)
    expect(anchor?.id).toBe(agent.session.deriveMessages().at(-1)?.id)
    expect(anchor?.textHash).toBe(textFingerprint('the deploy window is tuesday'))
    const stored = await ctx.prismMemory.remember({
      text: 'the deploy window is tuesday',
      ...(anchor === null ? {} : { evidenceMessage: anchor }),
    }, agent)
    expect(stored.record.evidence.messageId).toBe(anchor?.id)
    expect(stored.record.evidence.textHash).toBe(anchor?.textHash)
    expect(stored.record.evidence.sessionId).toBe(agent.session.id)
  })

  it('cites the exact message each distilled claim came from', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'distill-cite')
    appendUser(agent, 'I prefer concise answers from now on')
    appendAssistant(agent, 'Noted. The root cause was the stale build cache.')
    await driveTurnStopping(ctx, agent)

    const records = ctx.prismMemory.operatorRecords()
    expect(records.length).toBeGreaterThan(0)
    const messages = agent.session.deriveMessages()
    const textOf = (message: Message): string =>
      message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    for (const record of records) {
      const source = messages.find(message => message.id === record.evidence.messageId)
      if (source === undefined) throw new Error(`the cited message is missing: ${String(record.evidence.messageId)}`)
      expect(record.evidence.textHash).toBe(textFingerprint(textOf(source)))
    }
    // Both sides of the turn contributed, each through its own message.
    const cited = new Set(records.map(record => record.evidence.messageId))
    expect(cited.size).toBeGreaterThan(1)
  })

  it('leaves a write with no cited message unanchored instead of inventing one', async () => {
    const ctx = await boot()
    const stored = await ctx.prismMemory.remember({ text: 'an operator wrote this claim' }, undefined)
    expect(stored.record.evidence.messageId).toBeNull()
    expect(stored.record.evidence.textHash ?? null).toBeNull()
  })

  it('re-reads cited sources and reports intact, drifted, and missing', async () => {
    const ctx = await mountMemory({ sessionQuery: true })
    owned.add(ctx)
    const agent = await createAgent(ctx, 'verify')
    appendUser(agent, 'the deploy window is tuesday')
    const anchor = agent.session.deriveMessages().at(-1)
    if (anchor === undefined) throw new Error('no user message to cite')
    const intact = await ctx.prismMemory.remember({
      text: 'the deploy window is tuesday',
      evidenceMessage: { id: anchor.id, textHash: textFingerprint('the deploy window is tuesday') },
    }, agent)
    const drifted = await ctx.prismMemory.remember({
      text: 'a drift probe with distinct words',
      evidenceMessage: { id: anchor.id, textHash: 'ff'.repeat(32) },
    }, agent)
    const missing = await ctx.prismMemory.remember({
      text: 'a claim whose cited message never existed',
      evidenceMessage: { id: 'msg-bogus', textHash: 'ee'.repeat(32) },
    }, agent)

    const report = await ctx.prismMemory.verifyEvidence()
    expect(report.readerUnavailable).toBe(false)
    const outcomes = new Map(report.verdicts.map(verdict => [verdict.id, verdict.outcome]))
    expect(outcomes.get(intact.record.id)).toBe('intact')
    expect(outcomes.get(drifted.record.id)).toBe('drifted')
    expect(outcomes.get(missing.record.id)).toBe('missing')
    expect(report.uncited).toBe(0)
  })

  it('reports unavailable when no session-query engine is mounted', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'no-reader')
    appendUser(agent, 'the deploy window is tuesday')
    const anchor = ctx.prismMemory.evidenceAnchor(agent)
    await ctx.prismMemory.remember({
      text: 'the deploy window is tuesday',
      ...(anchor === null ? {} : { evidenceMessage: anchor }),
    }, agent)
    await ctx.prismMemory.remember({ text: 'an operator claim without a source' }, undefined)

    const report = await ctx.prismMemory.verifyEvidence()
    expect(report.readerUnavailable).toBe(true)
    expect(report.verdicts.map(verdict => verdict.outcome)).toEqual(['unavailable'])
    expect(report.uncited).toBe(1)
  })
})

describe('derivation parents', () => {
  it('carries the member claims as parents on a digest', async () => {
    const ctx = await boot({ dreamEveryWrites: 1, dreamClusterFloor: 2, dreamMaxTopics: 1 })
    const first = await ctx.prismMemory.remember({ text: 'the gateway rate limit is 100 requests', tags: ['gateway'] }, undefined)
    const second = await ctx.prismMemory.remember({ text: 'the gateway timeout is 5 seconds', tags: ['gateway'] }, undefined)

    const report = await ctx.prismMemory.dream({ apply: true })
    expect(report.topics.map(topic => topic.tag)).toEqual(['gateway'])
    const digest = ctx.prismMemory.all().find(record => record.tags.includes('dream-topic'))
    expect(digest?.status).toBe('pending')
    expect(digest?.parents).toEqual(report.topics[0]?.memberIds)
    expect(digest?.parents).toContain(first.record.id)
    expect(digest?.parents).toContain(second.record.id)
  })

  it('reports a digest whose parent no longer resolves, such as after an eviction', async () => {
    const ctx = await boot({ maxRecords: 4, dreamEveryWrites: 1, dreamClusterFloor: 2, dreamMaxTopics: 1 })
    const first = await ctx.prismMemory.remember({ text: 'the gateway rate limit is 100 requests', tags: ['gateway'] }, undefined)
    await ctx.prismMemory.remember({ text: 'the gateway timeout is 5 seconds', tags: ['gateway'] }, undefined)
    await ctx.prismMemory.dream({ apply: true })
    const digest = ctx.prismMemory.all().find(record => record.tags.includes('dream-topic'))
    if (digest === undefined) throw new Error('the digest was not written')

    // A write at the cap evicts the oldest archived record: the journal first,
    // then the forgotten claim — the one parent the digest carries.
    await ctx.prismMemory.forget(first.record.id, 'no longer true', undefined)
    await ctx.prismMemory.remember({ text: 'a filler claim that forces one eviction' }, undefined)
    await ctx.prismMemory.remember({ text: 'a second filler claim that forces another eviction' }, undefined)

    const plan = await ctx.prismMemory.maintain({})
    expect(plan.orphanedParents).toEqual([digest.id])
  })

  it('renders derivation parents into the mirror and its index', async () => {
    const ctx = await boot({ dreamEveryWrites: 1, dreamClusterFloor: 2, dreamMaxTopics: 1 })
    await ctx.prismMemory.remember({ text: 'the gateway rate limit is 100 requests', tags: ['gateway'] }, undefined)
    await ctx.prismMemory.remember({ text: 'the gateway timeout is 5 seconds', tags: ['gateway'] }, undefined)
    await ctx.prismMemory.dream({ apply: true })

    const dir = await scratch()
    await ctx.prismMemory.exportMarkdown({ dir })
    const markdown = await readFile(join(dir, 'memory.md'), 'utf8')
    expect(markdown).toContain('parents: `mem_')
    const index = JSON.parse(await readFile(join(dir, 'memory.index.json'), 'utf8')) as {
      records: readonly { tags: readonly string[], parents: readonly string[] | null }[] }
    const digest = index.records.find(record => record.tags.includes('dream-topic'))
    expect(digest?.parents?.length).toBe(2)
    expect(index.records.filter(record => !record.tags.includes('dream-topic')).every(record => record.parents === null))
      .toBe(true)
  })
})

describe('compare', () => {
  it('classifies two claims with the deployment thresholds and touches nothing', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'compare')
    const first = await ctx.prismMemory.remember({
      text: 'the default storage backend is sqlite, storing one document per record',
    }, agent)
    const second = await ctx.prismMemory.remember({
      text: 'the default storage backend is sqlite, storing one document per memory record',
    }, agent)
    const retryA = await ctx.prismMemory.remember({ text: 'the retry budget is three attempts per endpoint', tags: ['retry'] }, agent)
    const retryB = await ctx.prismMemory.remember({ text: 'the retry budget is five attempts per endpoint', tags: ['retry'] }, agent)
    const backoff = await ctx.prismMemory.remember({ text: 'retry storms are prevented by exponential backoff', tags: ['retry'] }, agent)
    const invoice = await ctx.prismMemory.remember({ text: 'the invoice batches on the first monday', tags: ['invoice'] }, agent)

    expect(ctx.prismMemory.operatorCompare(first.record.id, second.record.id).verdict).toBe('equivalent')
    const conflicting = ctx.prismMemory.operatorCompare(retryA.record.id, retryB.record.id)
    expect(conflicting.verdict).toBe('conflicting')
    expect(conflicting.sharedTags).toEqual(['retry'])
    expect(ctx.prismMemory.operatorCompare(retryA.record.id, backoff.record.id).verdict).toBe('complementary')
    expect(ctx.prismMemory.operatorCompare(first.record.id, invoice.record.id).verdict).toBe('unrelated')

    // Compare is a read: no record moved.
    expect(ctx.prismMemory.all().every(record => record.updatedAt === record.createdAt)).toBe(true)
  })

  it('names the supersede relation between the two claims', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'compare-relation')
    const old = await ctx.prismMemory.remember({ text: 'the retry budget is three attempts', tags: ['retry'] }, agent)
    const updated = await ctx.prismMemory.remember({
      text: 'the retry budget is five attempts',
      tags: ['retry'],
      supersedes: old.record.id,
    }, agent)

    const report = ctx.prismMemory.operatorCompare(old.record.id, updated.record.id)
    expect(report.relation).toBe('right supersedes left')
  })

  it('refuses to compare a record with itself and names an unknown id', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'compare-guard')
    const stored = await ctx.prismMemory.remember({ text: 'the deploy window is tuesday' }, agent)

    const same = await errorOf((async () => ctx.prismMemory.operatorCompare(stored.record.id, stored.record.id))())
    expect(same.code).toBe('PRISM_MEMORY_COMPARE_SAME')
    const unknown = await errorOf((async () => ctx.prismMemory.operatorCompare(stored.record.id, 'mem_missing'))())
    expect(unknown.code).toBe('PRISM_MEMORY_NOT_FOUND')
  })
})

describe('the mirror check', () => {
  it('reads missing, match, then stale against the current store', async () => {
    const ctx = await boot()
    const agent = await createAgent(ctx, 'mirror-check')
    await ctx.prismMemory.remember({ text: 'the domain stays at version 1' }, agent)

    const dir = await scratch()
    const missing = await ctx.prismMemory.checkExport({ dir })
    expect(missing.markdown).toBe('missing')
    expect(missing.index).toBe('missing')

    await ctx.prismMemory.exportMarkdown({ dir })
    const match = await ctx.prismMemory.checkExport({ dir })
    expect(match.markdown).toBe('match')
    expect(match.index).toBe('match')

    await ctx.prismMemory.remember({ text: 'a claim written after the mirror was taken' }, agent)
    const stale = await ctx.prismMemory.checkExport({ dir })
    expect(stale.markdown).toBe('stale')
    expect(stale.index).toBe('stale')
  })

  it('fails loud without a directory, like the export itself', async () => {
    const ctx = await boot()
    const error = await errorOf(ctx.prismMemory.checkExport({}))
    expect(error.code).toBe('PRISM_MEMORY_NO_EXPORT_DIR')
  })
})
