/**
 * The injected frame: what it may carry, and the one bound that matters.
 *
 * The whole point of assembling every contribution into one frame is that a step
 * appends exactly one message. These specs pin that the frame is absent when it
 * has nothing to say, that a budget bounds the finished bytes rather than the body
 * alone, and that the orientation line is stable enough not to vary between two
 * turns of the same session.
 */

import { describe, expect, it } from 'vitest'
import type { MemoryRecord } from '../src/domain.ts'
import { rankRecords } from '../src/memory.ts'
import { dayPartOf, FRAME_CLOSE, FRAME_GUIDANCE, FRAME_OPEN, renderOrientation, renderTail } from '../src/recall.ts'

const EPOCH = 1_700_000_000_000

/** One stored record carrying only what the frame tests need. */
function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_00000000-0000-4000-8000-000000000001',
    scope: 'global',
    scopeKey: '',
    kind: 'fact',
    text: 'the default storage backend is sqlite',
    tags: ['sqlite'],
    status: 'active',
    confidence: 0.9,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    validAt: EPOCH,
    invalidAt: null,
    supersedes: null,
    supersededBy: null,
    evidence: { sessionId: null, messageId: null, note: null },
    hits: 0,
    ...overrides,
  }
}

describe('the day part', () => {
  it('names the four parts of a local day at their boundaries', () => {
    expect(dayPartOf(4)).toBe('night')
    expect(dayPartOf(5)).toBe('morning')
    expect(dayPartOf(11)).toBe('morning')
    expect(dayPartOf(12)).toBe('afternoon')
    expect(dayPartOf(17)).toBe('afternoon')
    expect(dayPartOf(18)).toBe('evening')
    expect(dayPartOf(22)).toBe('evening')
    expect(dayPartOf(23)).toBe('night')
  })
})

describe('the orientation line', () => {
  it('carries the local date and day part but never the minute', () => {
    const first = new Date(2026, 9, 6, 18, 0, 0).getTime()
    const second = new Date(2026, 9, 6, 18, 59, 0).getTime()
    expect(renderOrientation(first)).toBe(renderOrientation(second))
    expect(renderOrientation(first)).toContain('2026-10-06')
    expect(renderOrientation(first)).toContain('evening')
  })

  it('changes across a day part so a late session is greeted differently', () => {
    const morning = new Date(2026, 9, 6, 8, 0, 0).getTime()
    const evening = new Date(2026, 9, 6, 20, 0, 0).getTime()
    expect(renderOrientation(morning)).not.toBe(renderOrientation(evening))
  })
})

describe('the assembled frame', () => {
  it('is empty when every section is empty', () => {
    expect(renderTail({})).toBe('')
    expect(renderTail({ identity: [], due: [], recall: [] })).toBe('')
  })

  it('renders each section under its own heading, omitting the empty ones', () => {
    const hits = rankRecords([record()], 'storage backend', { now: EPOCH })
    const block = renderTail({ orientation: 'Good evening.', recall: hits })
    expect(block).toContain(FRAME_OPEN)
    expect(block).toContain(FRAME_CLOSE)
    expect(block).toContain(FRAME_GUIDANCE)
    expect(block).toContain('Good evening.')
    expect(block).toContain('Possibly relevant memory:')
    expect(block).not.toContain('Standing memory:')
    expect(block).not.toContain('Due now')
  })

  it('labels standing memory and dated memory apart from keyword recall', () => {
    const block = renderTail({
      identity: [record({ layer: 'user' })],
      due: [record({ id: 'mem_00000000-0000-4000-8000-000000000002', dueAt: EPOCH })],
    })
    expect(block).toContain('Standing memory:')
    expect(block).toContain('Due now')
    expect(block).not.toContain('Possibly relevant memory:')
  })

  it('bounds the finished frame, not the body, including at an exact limit', () => {
    const hits = rankRecords(
      Array.from({ length: 6 }, (_, index) => record({
        id: `mem_00000000-0000-4000-8000-00000000010${index}`,
        text: `sqlite storage detail number ${index} ${'y'.repeat(200)}`,
      })),
      'sqlite storage detail',
      { now: EPOCH },
    )
    const fixed = renderTail({ orientation: 'Good evening.', recall: hits }, { maxChars: 1_000_000 })
    for (const cap of [fixed.length, fixed.length - 1, 300, 320, 500]) {
      expect(renderTail({ orientation: 'Good evening.', recall: hits }, { maxChars: cap }).length)
        .toBeLessThanOrEqual(cap)
    }
  })

  it('renders nothing when the cap cannot hold the frame itself', () => {
    expect(renderTail({ orientation: 'Good evening.' }, { maxChars: 40 })).toBe('')
  })

  it('renders the same bytes for the same inputs', () => {
    const hits = rankRecords([record()], 'storage backend', { now: EPOCH })
    expect(renderTail({ orientation: 'x', recall: hits })).toBe(renderTail({ orientation: 'x', recall: hits }))
  })
})
