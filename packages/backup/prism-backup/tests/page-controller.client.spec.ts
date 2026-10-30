/** The page controller: staged writes, secret presence, probes, runs, and clearing a secret. */

import { Context } from '@deepseek-ai/cordis'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackupSection, type BackupSettings } from '../src/client/page-controller.ts'
import type { BackupRunRecord } from '../src/types.ts'

/** One finished run the fake Host answers with. */
const RECORD: BackupRunRecord = {
  id: 'run-1',
  startedAt: 1,
  finishedAt: 2,
  status: 'success',
  targetType: 'smb',
  endpoint: 'D:\\remote',
  counts: { settings: 1, memoryFiles: 0, projects: 0, projectFiles: 0 },
}

/**
 * Build one settings scope over a fixed section.
 * @param writes - collects accepted mutations.
 * @returns the form double.
 */
function formDouble(writes: { ops: unknown[]; value?: BackupSettings } = { ops: [] }): ConfigForm<BackupSettings> {
  const snapshot: ConfigFormSnapshot<BackupSettings> = {
    status: 'ready',
    value: {
      targetType: 'smb',
      webdavUrl: '',
      s3Endpoint: '',
      s3Region: 'us-east-1',
      s3Bucket: '',
      s3PathStyle: false,
      smbPath: 'D:\\remote',
      username: '',
      s3AccessKeyId: '',
      remoteDir: 'prism-backup',
      includeSettings: true,
      includeMemory: true,
      includeProjects: false,
      projectExcludes: '.git',
      maxBackups: 10,
    },
    base: undefined,
    user: undefined,
    revision: 3,
    writable: true,
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async (field, value) => {
      writes.ops.push({ field, value })
      return true
    },
    unset: async (field) => {
      writes.ops.push({ field, cleared: true })
      return true
    },
    mutate: async (ops) => {
      writes.ops.push(ops)
      return true
    },
  }
}

/**
 * Build one mount context whose `remote.credentials` double records calls.
 * @param options - answers for describe/set/unset.
 * @returns the context and the credential double.
 */
function mount(options: {
  described?: Record<string, { configured: boolean }>
  describeFails?: boolean
  setOk?: boolean
  unsetOk?: boolean
} = {}): {
  ctx: Context
  credentials: {
    describe: ReturnType<typeof vi.fn>
    set: ReturnType<typeof vi.fn>
    unset: ReturnType<typeof vi.fn>
  }
} {
  const ctx = new Context()
  const credentials = {
    describe: vi.fn(async () => options.describeFails === true
      ? { ok: false as const, error: { code: 'gateway/internal', message: 'no provider' } }
      : { ok: true as const, value: options.described ?? {} }),
    set: vi.fn(async () => options.setOk === false
      ? { ok: false as const, error: { code: 'credentials/rejected', message: 'nope' } }
      : { ok: true as const, value: undefined }),
    unset: vi.fn(async () => options.unsetOk === false
      ? { ok: false as const, error: { code: 'credentials/rejected', message: 'unset nope' } }
      : { ok: true as const, value: undefined }),
  }
  ctx.provide('remote', { credentials })
  return { ctx, credentials }
}

/**
 * Read one request body as text.
 * @param init - the request init the page sent.
 * @returns the JSON text.
 */
function requestBody(init: RequestInit): string {
  if (typeof init.body !== 'string') throw new Error('the page must send a string body')
  return init.body
}

/**
 * Answer the plugin route for one action.
 * @param answers - how each action answers.
 * @returns the fetch double.
 */
function routeFetch(answers: {
  state?: () => Promise<unknown>
  run?: () => Promise<unknown>
  test?: () => Promise<unknown>
} = {}): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(requestBody(init)) as { action: string }
    const answer = answers[body.action as 'state' | 'run' | 'test']
    const value = answer === undefined ? { ok: true, value: { running: false, history: [] } } : await answer()
    return new Response(JSON.stringify(value), { status: 200 })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createBackupSection', () => {
  it('reads stored-password presence and run state on mount', async () => {
    const { ctx, credentials } = mount({
      described: { PRISM_BACKUP_WEBDAV_PASSWORD: { configured: true } },
    })
    const fetchMock = routeFetch()
    vi.stubGlobal('fetch', fetchMock)
    const face = createBackupSection(ctx, formDouble())
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalled() })
    expect(credentials.describe).toHaveBeenCalledWith([
      'PRISM_BACKUP_WEBDAV_PASSWORD', 'PRISM_BACKUP_SMB_PASSWORD', 'PRISM_BACKUP_S3_SECRET_KEY',
    ])
    await vi.waitFor(() => {
      expect(face.hooks.backupRun.getSnapshot().secrets['webdav-password']).toBe(true)
    })
    expect(face.hooks.backupRun.getSnapshot().secrets['smb-password']).toBe(false)
  })

  it('keeps every password unconfigured when the credential surface refuses the read', async () => {
    const { ctx } = mount({ describeFails: true })
    vi.stubGlobal('fetch', routeFetch())
    const face = createBackupSection(ctx, formDouble())
    await vi.waitFor(() => { expect(face.hooks.backupForm.getSnapshot().fields.smbPath.text.endsWith('remote')).toBe(true) })
    expect(face.hooks.backupRun.getSnapshot().secrets).toEqual({
      'webdav-password': false, 'smb-password': false, 's3-secret-key': false,
    })
  })

  it('renders a false switch as its own draft text', async () => {
    const { ctx } = mount()
    vi.stubGlobal('fetch', routeFetch())
    const face = createBackupSection(ctx, formDouble())
    await vi.waitFor(() => {
      expect(face.hooks.backupForm.getSnapshot().fields.includeProjects.text).toBe('false')
    })
  })

  it('stages field edits and writes them on save', async () => {
    const { ctx } = mount()
    vi.stubGlobal('fetch', routeFetch())
    const writes = { ops: [] as unknown[] }
    const face = createBackupSection(ctx, formDouble(writes))
    face.edit('smbPath', '/new/path')
    face.edit('includeProjects', 'true')
    expect(face.hooks.backupForm.getSnapshot().dirty).toBe(true)
    face.save()
    await vi.waitFor(() => { expect(writes.ops.length).toBeGreaterThan(0) })
    expect(JSON.stringify(writes.ops)).toContain('/new/path')
  })

  it('writes a staged password through the credential surface', async () => {
    const { ctx, credentials } = mount()
    vi.stubGlobal('fetch', routeFetch())
    const face = createBackupSection(ctx, formDouble())
    face.edit('webdavPassword', 'hunter2')
    face.save()
    await vi.waitFor(() => { expect(credentials.set).toHaveBeenCalledWith('PRISM_BACKUP_WEBDAV_PASSWORD', 'hunter2') })
  })

  it('reports a refused password write as a failed save', async () => {
    const { ctx } = mount({ setOk: false })
    vi.stubGlobal('fetch', routeFetch())
    const face = createBackupSection(ctx, formDouble())
    face.edit('webdavPassword', 'hunter2')
    face.save()
    await vi.waitFor(() => { expect(face.hooks.backupForm.getSnapshot().failed).toBe(true) })
  })

  it('blocks a save whose boolean draft is not a boolean', async () => {
    const { ctx } = mount()
    vi.stubGlobal('fetch', routeFetch())
    const face = createBackupSection(ctx, formDouble())
    face.edit('includeMemory', 'maybe')
    expect(face.hooks.backupForm.getSnapshot().invalid).toBe(true)
    face.save()
    expect(face.hooks.backupRun.getSnapshot().notice).toBeUndefined()
  })

  it('runs the connection probe and shows its sentence', async () => {
    const { ctx } = mount()
    vi.stubGlobal('fetch', routeFetch({ test: async () => ({ ok: true, value: { message: 'All good.' } }) }))
    const face = createBackupSection(ctx, formDouble())
    face.test()
    await vi.waitFor(() => {
      expect(face.hooks.backupRun.getSnapshot().notice).toEqual({ tone: 'ok', text: 'All good.' })
    })
  })

  it('shows a refused probe as an error notice', async () => {
    const { ctx } = mount()
    vi.stubGlobal('fetch', routeFetch({
      test: async () => ({ ok: false, error: { code: 'prism-backup/auth-failed', message: 'refused' } }),
    }))
    const face = createBackupSection(ctx, formDouble())
    face.test()
    await vi.waitFor(() => {
      expect(face.hooks.backupRun.getSnapshot().notice).toEqual({ tone: 'error', text: 'refused' })
    })
  })

  it('follows a run to completion and refreshes history', async () => {
    const { ctx } = mount()
    const fetchMock = routeFetch({
      state: async () => ({ ok: true, value: { running: false, history: [RECORD] } }),
      run: async () => ({ ok: true, value: RECORD }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const face = createBackupSection(ctx, formDouble())
    face.run()
    expect(face.hooks.backupRun.getSnapshot().running).toBe(true)
    await vi.waitFor(() => {
      expect(face.hooks.backupRun.getSnapshot().notice).toEqual({ tone: 'ok', text: 'runOk' })
      expect(face.hooks.backupRun.getSnapshot().running).toBe(false)
      expect(face.hooks.backupRun.getSnapshot().history).toEqual([RECORD])
    })
  })

  it('polls the run state while a run is in flight', async () => {
    const { ctx } = mount()
    const states = { count: 0, settled: false }
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { action: string }
      if (body.action === 'run') {
        await new Promise(resolve => setTimeout(resolve, 1200))
        states.settled = true
        return new Response(JSON.stringify({ ok: true, value: RECORD }), { status: 200 })
      }
      states.count += 1
      return new Response(JSON.stringify({
        ok: true, value: { running: !states.settled, history: states.settled ? [RECORD] : [] },
      }), { status: 200 })
    }))
    const face = createBackupSection(ctx, formDouble())
    face.run()
    await vi.waitFor(() => { expect(states.count).toBeGreaterThan(0) }, { timeout: 3000 })
    await vi.waitFor(() => { expect(face.hooks.backupRun.getSnapshot().running).toBe(false) }, { timeout: 3000 })
  })

  it('follows a run that was already active when the page opened', async () => {
    const { ctx } = mount()
    const states = { count: 0, settled: false }
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      requestBody(init)
      states.count += 1
      if (states.count > 2) states.settled = true
      return new Response(JSON.stringify({
        ok: true,
        value: { running: !states.settled, phase: { detail: 'Uploading' }, history: states.settled ? [RECORD] : [] },
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const face = createBackupSection(ctx, formDouble())
    await vi.waitFor(() => { expect(face.hooks.backupRun.getSnapshot().running).toBe(true) }, { timeout: 3000 })
    expect(face.hooks.backupRun.getSnapshot().phase).toBe('Uploading')
    await vi.waitFor(() => { expect(face.hooks.backupRun.getSnapshot().running).toBe(false) }, { timeout: 4000 })
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2)
  })

  it('stops polling when the plugin unloads', async () => {
    const { ctx } = mount()
    const states = { count: 0 }
    vi.stubGlobal('fetch', vi.fn(async () => {
      states.count += 1
      return new Response(JSON.stringify({ ok: true, value: { running: true, history: [] } }), { status: 200 })
    }))
    createBackupSection(ctx, formDouble())
    // The mount read plus at least one interval tick proves the timer ran.
    await vi.waitFor(() => { expect(states.count).toBeGreaterThan(1) }, { timeout: 4000 })
    await ctx.fiber.dispose()
    const afterDispose = states.count
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(states.count).toBe(afterDispose)
  })

  it('stops polling when the settle-time read fails', async () => {
    const { ctx } = mount()
    const calls = { run: 0, state: 0 }
    const actions: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { action: string }
      actions.push(body.action)
      if (body.action === 'run') {
        calls.run += 1
        return new Response(JSON.stringify({ ok: true, value: RECORD }), { status: 200 })
      }
      calls.state += 1
      return new Response('unavailable', { status: 503 })
    }))
    const face = createBackupSection(ctx, formDouble())
    await vi.waitFor(() => { expect(calls.state).toBeGreaterThan(0) }, { timeout: 3000 })
    await vi.waitFor(() => { expect(calls.run).toBe(0) }, { timeout: 1000 })
    face.run()
    await vi.waitFor(() => { expect(calls.run).toBeGreaterThan(0) }, { timeout: 3000 })
    expect(actions.filter(action => action === 'run')).toHaveLength(1)
    // Let the settle-time follow-up read land before counting.
    await new Promise(resolve => setTimeout(resolve, 150))
    const after = calls.state
    await new Promise(resolve => setTimeout(resolve, 1200))
    // The run settled, so nothing polls even though every read failed.
    expect(calls.state).toBe(after)
  })

  it('shows a failed run as an error notice', async () => {
    const { ctx } = mount()
    vi.stubGlobal('fetch', routeFetch({
      run: async () => ({ ok: false, error: { code: 'prism-backup/upload-failed', message: 'server said no' } }),
    }))
    const face = createBackupSection(ctx, formDouble())
    face.run()
    await vi.waitFor(() => {
      expect(face.hooks.backupRun.getSnapshot().notice).toEqual({ tone: 'error', text: 'server said no' })
    })
  })

  it('clears a stored password and reports a refusal', async () => {
    const ok = mount()
    vi.stubGlobal('fetch', routeFetch())
    const face = createBackupSection(ok.ctx, formDouble())
    face.clearSecret('s3-secret-key')
    await vi.waitFor(() => { expect(ok.credentials.unset).toHaveBeenCalledWith('PRISM_BACKUP_S3_SECRET_KEY') })

    const refused = mount({ unsetOk: false })
    const failed = createBackupSection(refused.ctx, formDouble())
    failed.clearSecret('smb-password')
    await vi.waitFor(() => {
      expect(failed.hooks.backupRun.getSnapshot().notice).toEqual({ tone: 'error', text: 'unset nope' })
    })
  })

  it('refuses a state answer whose shape it does not trust', async () => {
    const { ctx } = mount()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, value: {} }), { status: 200 })))
    const face = createBackupSection(ctx, formDouble())
    await vi.waitFor(() => {
      expect(face.hooks.backupRun.getSnapshot().running).toBe(false)
      expect(face.hooks.backupRun.getSnapshot().history).toEqual([])
    })
  })

  it('keeps only history records whose fields it can trust', async () => {
    const { ctx } = mount()
    const good = {
      ...RECORD,
      archiveName: 'prism-backup-20260101-000000.zip',
      sizeBytes: 12,
      counts: { settings: 1, memoryFiles: 2, projects: 3, projectFiles: 4 },
      failure: { code: 'prism-backup/auth-failed', message: 'refused' },
    }
    const badCode = { ...RECORD, id: 'bad-code', failure: { code: 'other/code', message: 'x' } }
    const badShape = { ...RECORD, id: 7 }
    const badStatus = { ...RECORD, id: 'bad-status', status: 'partial' }
    const sparseCounts = { ...RECORD, id: 'sparse', counts: {} }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      value: { running: false, history: [good, badCode, badShape, badStatus, 'text', sparseCounts] },
    }), { status: 200 })))
    const face = createBackupSection(ctx, formDouble())
    await vi.waitFor(() => { expect(face.hooks.backupRun.getSnapshot().history.length).toBe(3) })
    const history = face.hooks.backupRun.getSnapshot().history
    expect(history[0]).toMatchObject({ failure: { code: 'prism-backup/auth-failed' }, sizeBytes: 12 })
    expect(history[1]?.failure).toBeUndefined()
    expect(history[2]).toMatchObject({ counts: { settings: 0, memoryFiles: 0, projects: 0, projectFiles: 0 } })
  })

  it('refuses a run answer that is not an object', async () => {
    const { ctx } = mount()
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(requestBody(init)) as { action: string }
      if (body.action === 'run') return new Response(JSON.stringify({ ok: true, value: null }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, value: { running: false, history: [] } }), { status: 200 })
    }))
    const face = createBackupSection(ctx, formDouble())
    face.run()
    await vi.waitFor(() => {
      expect(face.hooks.backupRun.getSnapshot().notice).toEqual({ tone: 'error', text: 'unreachable' })
    })
  })

  it('refuses a test answer whose message is not text', async () => {
    const { ctx } = mount()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, value: { message: 7 } }), { status: 200 })))
    const face = createBackupSection(ctx, formDouble())
    face.test()
    await vi.waitFor(() => {
      expect(face.hooks.backupRun.getSnapshot().notice).toEqual({ tone: 'error', text: 'unreachable' })
    })
  })

  it('refuses a test answer without a sentence', async () => {
    const { ctx } = mount()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, value: null }), { status: 200 })))
    const face = createBackupSection(ctx, formDouble())
    face.test()
    await vi.waitFor(() => {
      expect(face.hooks.backupRun.getSnapshot().notice).toEqual({ tone: 'error', text: 'unreachable' })
    })
  })

  it('survives an unreachable service while mounting', async () => {
    const { ctx } = mount()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    const face = createBackupSection(ctx, formDouble())
    await vi.waitFor(() => { expect(face.hooks.backupForm.getSnapshot().fields.smbPath.text).toBe('D:\\remote') })
    face.test()
    await vi.waitFor(() => { expect(face.hooks.backupRun.getSnapshot().testing).toBe(false) })
  })

  it('treats a thrown non-Error as its message text', async () => {
    const { ctx } = mount()
    vi.stubGlobal('fetch', vi.fn(() => { throw 'offline' }))
    const face = createBackupSection(ctx, formDouble())
    face.test()
    await vi.waitFor(() => {
      expect(face.hooks.backupRun.getSnapshot().notice).toEqual({ tone: 'error', text: 'offline' })
    })
  })

  it('treats a non-JSON answer as an HTTP failure notice', async () => {
    const { ctx } = mount()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 503 })))
    const face = createBackupSection(ctx, formDouble())
    face.test()
    await vi.waitFor(() => {
      expect(face.hooks.backupRun.getSnapshot().notice).toEqual({ tone: 'error', text: 'unreachable' })
    })
  })
})
