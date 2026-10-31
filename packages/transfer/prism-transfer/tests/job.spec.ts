import { describe, expect, it } from 'vitest'
import { TransferJobStore } from '../src/job.ts'

describe('TransferJobStore', () => {
  it('grants the slot once per tick and reports busy for the second claim', () => {
    const store = new TransferJobStore()
    const first = store.tryBegin('a.zip', 10)
    expect(first).toBeDefined()
    expect(store.tryBegin('b.zip', 20)).toBeUndefined()
    if (first !== undefined) {
      store.finish(first.jobId, 'a.zip', 10, { projects: [] })
      const next = store.tryBegin('b.zip', 20)
      expect(next).toBeDefined()
    }
  })

  it('answers idle for unknown, foreign, and expired job ids', () => {
    const store = new TransferJobStore()
    expect(store.snapshot('nope')).toEqual({ state: 'idle' })
    const job = store.tryBegin('a.zip', 10)
    if (job === undefined) throw new Error('reservation refused')
    expect(store.snapshot('other')).toEqual({ state: 'idle' })
    const snapshot = store.snapshot(job.jobId)
    expect(snapshot).toMatchObject({ state: 'running', phase: 'validating', kind: 'unknown' })
    // Retention: ten minutes after finish the snapshot expires.
    const now = Date.now()
    store.finish(job.jobId, 'a.zip', 10, { projects: [] })
    expect(store.snapshot(job.jobId, now + 5 * 60 * 1000).state).toBe('done')
    expect(store.snapshot(job.jobId, now + 11 * 60 * 1000)).toEqual({ state: 'idle' })
  })

  it('accumulates progress and failures on the snapshot', () => {
    const store = new TransferJobStore()
    const job = store.tryBegin('a.zip', 10)
    if (job === undefined) throw new Error('reservation refused')
    job.setKind('combined')
    job.setPhase('restoring')
    job.setSessionsTotal(4)
    job.addSessionsDone(2)
    job.addDuplicates(1)
    job.setProjectsTotal(2)
    job.addProjectDone(1)
    job.addFiles(7)
    job.addBytes(90)
    expect(store.snapshot(job.jobId)).toMatchObject({
      kind: 'combined',
      phase: 'restoring',
      sessionsTotal: 4,
      sessionsDone: 2,
      duplicates: 1,
      projectsTotal: 2,
      projectsDone: 1,
      files: 7,
      bytes: 90,
    })
    store.fail(job.jobId, { code: 'crc-mismatch', detail: 'bad entry' })
    expect(store.snapshot(job.jobId)).toMatchObject({
      state: 'failed',
      error: { code: 'crc-mismatch', detail: 'bad entry' },
    })
  })

  it('ignores finish and fail calls for foreign job ids', () => {
    const store = new TransferJobStore()
    const job = store.tryBegin('a.zip', 10)
    if (job === undefined) throw new Error('reservation refused')
    store.finish('foreign', 'x.zip', 0, { projects: [] })
    store.fail('foreign', { code: 'io', detail: 'nope' })
    expect(store.snapshot(job.jobId)).toMatchObject({ state: 'running' })
  })

  it('re-opens the slot after a failed job', () => {
    const store = new TransferJobStore()
    const first = store.tryBegin('a.zip', 10)
    if (first === undefined) throw new Error('reservation refused')
    store.fail(first.jobId, { code: 'bad-archive', detail: 'nope' })
    expect(store.tryBegin('b.zip', 20)).toBeDefined()
  })
})
