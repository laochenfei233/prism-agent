/**
 * The consolidation pass: what it is willing to conclude on its own, and what it
 * refuses to.
 *
 * The line these specs draw is the point of the pass. Corroboration and topic
 * indexing are corroborated by the corpus itself, so the pass may assert them.
 * A contradiction is a judgement, so the pass may only report it. Everything here
 * is pure, so a plan is reproducible from a fixed corpus and clock.
 */

import { describe, expect, it } from 'vitest'
import type { MemoryRecord } from '../src/domain.ts'
import { planDream, renderDreamJournal, renderReflection } from '../src/dream.ts'

const EPOCH = Date.UTC(2026, 9, 6, 12, 0, 0)
const DAY = 86_400_000

/** One stored record carrying only what a consolidation test needs. */
function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_00000000-0000-4000-8000-000000000001',
    scope: 'global',
    scopeKey: '',
    kind: 'fact',
    text: 'the default storage backend is sqlite',
    tags: ['backend'],
    status: 'active',
    confidence: 0.9,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    validAt: EPOCH,
    invalidAt: null,
    supersedes: null,
    supersededBy: null,
    evidence: { sessionId: 'session-a', messageId: null, note: null },
    hits: 0,
    ...overrides,
  }
}

/** Plan over a corpus with the shipped thresholds. */
function plan(corpus: readonly MemoryRecord[], candidates: readonly MemoryRecord[] = corpus) {
  return planDream({
    candidates,
    corpus,
    now: EPOCH,
    corroborationFloor: 2,
    conflictFloor: 0.5,
    duplicateFloor: 0.97,
    clusterFloor: 3,
    maxTopics: 3,
    maxMembers: 3,
    maxDigestChars: 400,
  })
}

describe('corroboration', () => {
  it('confirms a claim an independent conversation has also written', () => {
    const corroborated = record({ corroborations: 1 })
    expect(plan([corroborated]).corroborated).toEqual([{ id: corroborated.id, corroborations: 2 }])
  })

  it('leaves a claim written once by one conversation alone', () => {
    expect(plan([record({ corroborations: 0 })]).corroborated).toEqual([])
    expect(plan([record()]).corroborated).toEqual([])
  })

  it('ignores a record that is no longer live', () => {
    expect(plan([record({ corroborations: 3, status: 'archived' })]).corroborated).toEqual([])
  })

  it('ignores a claim outside the window', () => {
    const older = record({ corroborations: 3 })
    const fresh = record({ id: 'mem_00000000-0000-4000-8000-000000000002', text: 'something else entirely' })
    expect(plan([older, fresh], [fresh]).corroborated).toEqual([])
  })
})

describe('topics', () => {
  it('indexes a tag the corpus keeps returning to', () => {
    const corpus = Array.from({ length: 3 }, (_, index) => record({
      id: `mem_00000000-0000-4000-8000-00000000001${index}`,
      text: `sqlite detail number ${index}`,
      tags: ['backend'],
    }))
    const [topic] = plan(corpus).topics
    expect(topic?.tag).toBe('backend')
    expect(topic?.memberIds).toHaveLength(3)
    expect(topic?.text).toContain('Recurring topic "backend" (3 claims)')
  })

  it('leaves a tag below the cluster floor alone', () => {
    const corpus = Array.from({ length: 2 }, (_, index) => record({
      id: `mem_00000000-0000-4000-8000-00000000002${index}`,
      text: `sqlite detail number ${index}`,
      tags: ['backend'],
    }))
    expect(plan(corpus).topics).toEqual([])
  })

  it('bounds the members and the digest text it writes', () => {
    const corpus = Array.from({ length: 6 }, (_, index) => record({
      id: `mem_00000000-0000-4000-8000-00000000003${index}`,
      text: `sqlite detail number ${index} ${'y'.repeat(300)}`,
      tags: ['backend'],
    }))
    const [topic] = plan(corpus).topics
    expect(topic?.memberIds).toHaveLength(3)
    expect((topic?.text.length ?? 0)).toBeLessThanOrEqual(400)
  })

  it('excludes its own journal and digest records from clustering', () => {
    const corpus = Array.from({ length: 3 }, (_, index) => record({
      id: `mem_00000000-0000-4000-8000-00000000004${index}`,
      text: `sqlite detail number ${index}`,
      tags: ['dream-journal'],
    }))
    expect(plan(corpus).topics).toEqual([])
  })
})

describe('contradictions', () => {
  it('reports two comparable claims about one tagged subject', () => {
    const left = record({ text: 'the default storage backend is sqlite', tags: ['backend'] })
    const right = record({
      id: 'mem_00000000-0000-4000-8000-000000000005',
      text: 'the default storage backend is postgres',
      tags: ['backend'],
      createdAt: EPOCH + DAY,
    })
    const [conflict] = plan([left, right]).conflicts
    expect(conflict?.left).toBe(left.id)
    expect(conflict?.right).toBe(right.id)
    expect(conflict?.similarity).toBeGreaterThan(0.5)
  })

  it('does not report two claims about unrelated subjects', () => {
    const left = record({ text: 'the default storage backend is sqlite', tags: ['backend'] })
    const right = record({
      id: 'mem_00000000-0000-4000-8000-000000000006',
      text: 'the release script refuses to run from a dirty tree',
      tags: ['release'],
    })
    expect(plan([left, right]).conflicts).toEqual([])
  })

  it('does not report a paraphrase of the same claim as a contradiction', () => {
    const left = record({ text: 'the default storage backend is sqlite', tags: ['backend'] })
    const right = record({
      id: 'mem_00000000-0000-4000-8000-000000000007',
      text: 'the default storage backend is sqlite',
      tags: ['backend'],
    })
    expect(plan([left, right]).conflicts).toEqual([])
  })

  it('reports each pair once, oldest first', () => {
    const left = record({ text: 'the default storage backend is sqlite', tags: ['backend'] })
    const right = record({
      id: 'mem_00000000-0000-4000-8000-000000000008',
      text: 'the default storage backend is postgres',
      tags: ['backend'],
      createdAt: EPOCH + DAY,
    })
    const conflicts = plan([right, left]).conflicts
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.left).toBe(left.id)
  })
})

describe('the journal', () => {
  it('says so when a pass changed nothing', () => {
    expect(renderDreamJournal(plan([record()]))).toBe('Dream pass over 1 record(s).\nNothing changed.')
  })

  it('names each thing it concluded', () => {
    const corpus = Array.from({ length: 3 }, (_, index) => record({
      id: `mem_00000000-0000-4000-8000-00000000005${index}`,
      text: `sqlite detail number ${index}`,
      tags: ['backend'],
      corroborations: 2,
    }))
    const journal = renderDreamJournal(plan(corpus))
    expect(journal).toContain('Corroborated by more than one conversation:')
    expect(journal).toContain('Topics indexed: backend (3)')
  })

  it('renders the same bytes for the same plan', () => {
    const corpus = [record({ corroborations: 2 })]
    expect(renderDreamJournal(plan(corpus))).toBe(renderDreamJournal(plan(corpus)))
  })
})

describe('the daily reflection', () => {
  it('counts what the day wrote and where it came from', () => {
    // A locally aligned window, so the day the entry names does not depend on the
    // machine's UTC offset.
    const dayStart = new Date(2026, 9, 6).getTime()
    const previousDayStart = new Date(2026, 9, 5).getTime()
    const during = previousDayStart + 3_600_000
    const corpus = [
      record({ createdAt: during, evidence: { sessionId: 'session-a', messageId: null, note: null } }),
      record({
        id: 'mem_00000000-0000-4000-8000-000000000009',
        createdAt: during,
        layer: 'lesson',
        status: 'pending',
        evidence: { sessionId: 'session-b', messageId: null, note: null },
      }),
      record({
        id: 'mem_00000000-0000-4000-8000-00000000000a',
        createdAt: previousDayStart - 3 * DAY,
        status: 'archived',
      }),
    ]
    const text = renderReflection(corpus, { since: previousDayStart, until: dayStart })
    expect(text).toContain('Daily reflection: 2026-10-05.')
    expect(text).toContain('Written that day: 2 claim(s) from 2 conversation(s)')
    expect(text).toContain('lesson=1')
    // Only one record is active: the archived one is out of the corpus and the
    // pending one is counted as awaiting review rather than as live.
    expect(text).toContain('Corpus since: 1 live, 1 awaiting review.')
  })

  it('renders the same bytes for the same corpus', () => {
    expect(renderReflection([record()], { since: 0, until: EPOCH }))
      .toBe(renderReflection([record()], { since: 0, until: EPOCH }))
  })
})
