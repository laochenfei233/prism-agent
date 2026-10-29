import { describe, expect, it } from 'vitest'
import type { ImportApplyResult, ImportPlan } from '../src/types.ts'
import {
  formatBytes,
  formatDay,
  groupId,
  groupIds,
  mergeGroupsFor,
  outcomeCounts,
  selectedSessionIds,
} from '../src/client/state.ts'

const plan: ImportPlan = {
  source: 'claude',
  groups: [
    {
      path: '/work/a',
      title: 'a',
      sessions: [
        { key: 'one', createdAt: 1, updatedAt: 2 },
        { key: 'two', createdAt: 3, updatedAt: 4 },
      ],
      existingWorkspace: { id: 'ws', title: 'A', sessionCount: 4 },
      merge: true,
    },
    {
      sessions: [{ key: 'three', createdAt: 5, updatedAt: 6 }],
      merge: false,
    },
  ],
  skipped: [],
}

describe('import page state helpers', () => {
  it('maps project groups to stable ids and selected sessions', () => {
    expect(groupIds(plan)).toEqual(['/work/a', 'ungrouped:1'])
    expect(groupId(plan.groups[1]!, 1)).toBe('ungrouped:1')
    expect(selectedSessionIds(plan, ['/work/a'])).toEqual(['one', 'two'])
    expect(selectedSessionIds(plan, [])).toEqual([])
  })

  it('detects merges only among selected groups', () => {
    expect(mergeGroupsFor(plan, ['/work/a'])).toHaveLength(1)
    expect(mergeGroupsFor(plan, ['ungrouped:1'])).toHaveLength(0)
  })

  it('counts outcomes and formats stored sizes', () => {
    const result: ImportApplyResult = {
      results: [
        { key: 'a', outcome: 'imported' },
        { key: 'b', outcome: 'imported' },
        { key: 'c', outcome: 'duplicate' },
        { key: 'd', outcome: 'skipped' },
        { key: 'e', outcome: 'failed' },
      ],
      workspaces: [],
    }
    expect(outcomeCounts(result)).toEqual({ imported: 2, duplicate: 1, skipped: 1, failed: 1 })
    expect(formatBytes(0)).toBe('—')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(formatDay(0)).toBe('—')
    expect(formatDay(Date.parse('2026-01-02T00:00:00.000Z'))).toBe('2026-01-02')
  })
})
