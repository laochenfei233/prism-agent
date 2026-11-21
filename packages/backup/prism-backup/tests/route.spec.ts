/** The settings route: action dispatch, status codes, and the failure envelopes. */

import { describe, expect, it } from 'vitest'
import { BackupError } from '../src/error.ts'
import { createBackupRoute, type BackupRouteDeps } from '../src/index.ts'
import type { BackupRunRecord, BackupState } from '../src/types.ts'

/** A finished run record the fakes answer with. */
function record(overrides: Partial<BackupRunRecord> = {}): BackupRunRecord {
  return {
    id: 'run-1',
    startedAt: 1,
    finishedAt: 2,
    status: 'success',
    targetType: 'smb',
    endpoint: 'D:\\remote',
    counts: { settings: 1, memoryFiles: 0, projects: 0, projectFiles: 0 },
    ...overrides,
  }
}

/**
 * Build a route over fakes.
 * @param overrides - what the fake runner answers.
 * @returns the handler and the calls it observed.
 */
function route(overrides: Partial<BackupRouteDeps['runner']> & { ensure?: () => Promise<void> } = {}): {
  handler: ReturnType<typeof createBackupRoute>
  calls: string[]
} {
  const calls: string[] = []
  const state: BackupState = { running: false, history: [record()] }
  const runner = {
    state: (): BackupState => {
      calls.push('state')
      return state
    },
    test: async (): Promise<string> => {
      calls.push('test')
      return overrides.test === undefined ? 'Connection works.' : await overrides.test()
    },
    run: async (): Promise<BackupRunRecord> => {
      calls.push('run')
      return overrides.run === undefined ? record() : await overrides.run()
    },
  }
  return {
    handler: createBackupRoute({
      runner,
      history: { ensure: overrides.ensure ?? (async () => { calls.push('ensure') }) },
    }),
    calls,
  }
}

/**
 * POST one JSON body to a handler.
 * @param handler - the route under test.
 * @param body - raw body text.
 * @returns the response.
 */
async function post(handler: ReturnType<typeof createBackupRoute>, body: string): Promise<Response> {
  return await handler(new Request('http://host/api/prism.backup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }))
}

describe('backup route', () => {
  it('answers run state and history', async () => {
    const { handler, calls } = route()
    const response = await post(handler, '{"action":"state"}')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, value: { running: false, history: [record()] } })
    expect(calls).toEqual(['ensure', 'state'])
  })

  it('answers the connection probe', async () => {
    const { handler } = route()
    const response = await post(handler, '{"action":"test"}')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, value: { message: 'Connection works.' } })
  })

  it('answers a finished run', async () => {
    const { handler } = route()
    const response = await post(handler, '{"action":"run"}')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, value: record() })
  })

  it('answers a failed run with its code and status', async () => {
    const { handler } = route({
      run: async () => record({ status: 'failed', failure: { code: 'prism-backup/auth-failed', message: 'refused' } }),
    })
    const response = await post(handler, '{"action":"run"}')
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ ok: false, error: { code: 'prism-backup/auth-failed', message: 'refused' } })
  })

  it('rejects a body that is not JSON, not an object, or names no known action', async () => {
    const { handler } = route()
    for (const body of ['not json', '"text"', '{"action":"delete"}', '{}']) {
      const response = await post(handler, body)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'prism-backup/bad-request' } })
    }
  })

  it('maps a busy refusal onto 409 and an unclassified defect onto 502', async () => {
    const busy = route({ run: async () => { throw new BackupError('prism-backup/busy', 'already running') } })
    const refused = await post(busy.handler, '{"action":"run"}')
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: { code: 'prism-backup/busy' } })

    const broken = route({ test: async () => { throw new TypeError('bug') } })
    const failed = await post(broken.handler, '{"action":"test"}')
    expect(failed.status).toBe(502)
    expect(await failed.json()).toMatchObject({ error: { code: 'prism-backup/failed', message: 'The backup failed: bug' } })

    const thrownString = route({ run: async () => { throw 'plain text' } })
    const text = await post(thrownString.handler, '{"action":"run"}')
    expect(await text.json()).toMatchObject({ error: { message: 'The backup failed: plain text' } })
  })
})
