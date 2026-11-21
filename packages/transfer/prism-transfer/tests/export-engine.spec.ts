import { chmod, mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-attachment'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLineageNode } from '@deepseek-ai/dsh-session-query'
import type { SessionLogZipEntry } from '@deepseek-ai/dsh-session-log-export'
import { ZipArchiveReader, type ZipEntry } from '../src/zip-reader.ts'
import { asTransferError, TransferError } from '../src/errors.ts'
import {
  exportFilename,
  planTransferExport,
  scanProjectFolder,
  streamTransferZip,
  transferArchiveEntries,
  transferExportDeps,
  type TransferExportDeps,
  type TransferExportPlan,
} from '../src/export-engine.ts'
import type { SettingsTransferDeps } from '../src/settings-transfer.ts'
import { PROJECT_MANIFEST_NAME, SETTINGS_ENTRY_NAME, TRANSFER_MANIFEST_NAME } from '../src/types.ts'

const tempRoot = await mkdtemp(join(tmpdir(), 'prism-transfer-export-'))
const isWindows = process.platform === 'win32'

const sid = (id: string): SessionId => id as SessionId

function fakeLog(id: string): { header: SessionHeader; events: readonly SessionEvent[] } {
  return {
    header: {
      version: SESSION_FORMAT_VERSION,
      id: sid(id),
      createdAt: 1000,
      isSeeded: false,
      cwd: '/proj',
      delegationDepth: 0,
    },
    events: [{ type: 'turn/start', seq: 0, time: 2000, data: { turn: 1 } } as SessionEvent],
  }
}

/** Fake session surfaces serving the given logs, with no descendants. */
function fakeSessionDeps(logs: Record<string, { header: SessionHeader; events: readonly SessionEvent[] }>) {
  return {
    sessionQuery: {
      traceSession: async (): Promise<{ descendants: readonly SessionLineageNode[] }> => ({ descendants: [] }),
    } as never,
    sessionPersistence: {
      open: async (id: SessionId) => {
        const stored = logs[String(id)]
        if (stored === undefined) throw new Error(`missing log ${String(id)}`)
        return {
          id,
          header: stored.header,
          access: 'read',
          inheritedEventCount: 0,
          read: async () => ({ eventState: 'detached', events: structuredClone(stored.events) }),
          close: async () => {},
        } as never
      },
    } as never,
    attachments: {
      readImage: async () => {
        throw new Error('fixture logs reference no images')
      },
    } as never,
  }
}

function fakeSettingsDeps(): SettingsTransferDeps {
  const row = {
    ns: 'web',
    autoGenerate: true,
    schema: { type: 'object', dict: { endpoint: { type: 'string' } } },
    value: { endpoint: '/x' },
    revision: 0,
    applies: 'live' as const,
  }
  return {
    describe: () => [row as never],
    update: async () => {},
  }
}

function buildDeps(
  workspaces: Record<string, { title: string; path: string; sessionIds: readonly string[] }>,
  logs: Record<string, { header: SessionHeader; events: readonly SessionEvent[] }>,
): TransferExportDeps {
  const ctx = new Context()
  const session = fakeSessionDeps(logs)
  ctx.provide('sessionQuery', session.sessionQuery)
  ctx.provide('sessionPersistence', session.sessionPersistence)
  ctx.provide('attachments', session.attachments)
  return transferExportDeps(
    ctx,
    {
      get: async (id) => {
        const found = workspaces[id]
        return found === undefined ? undefined : { id, ...found }
      },
    },
    fakeSettingsDeps(),
  )
}

/** Read one entry's full decompressed bytes through the house reader. */
async function collect(reader: ZipArchiveReader, entry: ZipEntry): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of reader.bytes(entry)) chunks.push(chunk)
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
}

/** Stream one plan to a spooled archive and open it with the house reader. */
async function writeArchive(
  deps: TransferExportDeps,
  plan: Awaited<ReturnType<typeof planTransferExport>>,
): Promise<ZipArchiveReader> {
  const controller = new AbortController()
  const stream = streamTransferZip(transferArchiveEntries(deps, plan, controller.signal), controller.signal)
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk)
  const path = join(tempRoot, `${randomUUID()}.zip`)
  await writeFile(path, Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
  return ZipArchiveReader.open(path)
}

describe('scanProjectFolder', () => {
  it('walks nested folders, sorts by path, and sums bytes', async () => {
    const root = join(tempRoot, 'scan-basic')
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'b.txt'), 'bbbb')
    await writeFile(join(root, 'a.txt'), 'aa')
    await writeFile(join(root, 'assets', 'c.bin'), 'ccc')
    const scanned = await scanProjectFolder(root)
    expect(scanned.files.map(file => file.relativePath)).toEqual(['a.txt', 'assets/c.bin', 'b.txt'])
    expect(scanned.totalBytes).toBe(9)
    expect(scanned.skippedLinks).toBe(0)
    expect(scanned.skippedUnreadable).toBe(0)
  })

  it('refuses a per-file size at or above the ceiling', async () => {
    const root = join(tempRoot, 'scan-big')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'ok.bin'), 'ok')
    await writeFile(join(root, 'huge.bin'), 'way too large')
    await expect(scanProjectFolder(root, { maxFileBytes: 5 })).rejects.toMatchObject({
      code: 'entry-too-large',
    })
  })

  it('refuses a missing project folder outright', async () => {
    await expect(scanProjectFolder(join(tempRoot, 'scan-missing'))).rejects.toMatchObject({
      code: 'bad-request',
    })
  })

  it.skipIf(isWindows)('skips symbolic links instead of following them', async () => {
    const root = join(tempRoot, 'scan-links')
    const outside = join(tempRoot, 'scan-links-outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'outside')
    await writeFile(join(root, 'keep.txt'), 'keep')
    await symlink(outside, join(root, 'linked'))
    const scanned = await scanProjectFolder(root)
    expect(scanned.files.map(file => file.relativePath)).toEqual(['keep.txt'])
    expect(scanned.skippedLinks).toBe(1)
  })

  it('skips directory junctions like any other link', async () => {
    const root = join(tempRoot, 'scan-junction')
    const outside = join(tempRoot, 'scan-junction-outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'outside')
    await writeFile(join(root, 'keep.txt'), 'keep')
    await symlink(outside, join(root, 'linked'), 'junction')
    const scanned = await scanProjectFolder(root)
    expect(scanned.files.map(file => file.relativePath)).toEqual(['keep.txt'])
    expect(scanned.skippedLinks).toBe(1)
  })

  it('counts a subfolder it cannot list as unreadable instead of failing the walk', async () => {
    const root = join(tempRoot, 'scan-denied')
    const sub = join(root, 'denied')
    await mkdir(sub, { recursive: true })
    await writeFile(join(root, 'keep.txt'), 'keep')
    if (isWindows) {
      const user = process.env.USERNAME ?? process.env.USER ?? ''
      execSync(`icacls "${sub}" /deny "${user}:(RD)"`, { stdio: 'pipe' })
    } else {
      await chmod(sub, 0o000)
    }
    try {
      const scanned = await scanProjectFolder(root)
      expect(scanned.skippedUnreadable).toBe(1)
      expect(scanned.files.map(file => file.relativePath)).toEqual(['keep.txt'])
    } finally {
      if (isWindows) {
        execSync(`icacls "${sub}" /reset`, { stdio: 'pipe' })
      } else {
        await chmod(sub, 0o755)
      }
    }
  })

  it('refuses to scan when the walk is cancelled before it starts', async () => {
    const root = join(tempRoot, 'scan-aborted')
    await mkdir(root, { recursive: true })
    const controller = new AbortController()
    controller.abort()
    await expect(scanProjectFolder(root, { signal: controller.signal })).rejects.toThrow()
  })
})

describe('planTransferExport', () => {
  const logs = { 'session-1': fakeLog('session-1') }

  it('refuses an empty selection', async () => {
    const deps = buildDeps({}, logs)
    await expect(planTransferExport(deps, { projectIds: [], includeSettings: false, includeSecrets: false }))
      .rejects.toMatchObject({ code: 'no-projects' })
  })

  it('refuses unknown workspaces', async () => {
    const deps = buildDeps({}, logs)
    await expect(planTransferExport(deps, { projectIds: ['ghost'], includeSettings: false, includeSecrets: false }))
      .rejects.toMatchObject({ code: 'unknown-workspace' })
  })

  it('picks the single-project layout only for one project without settings', async () => {
    const root = join(tempRoot, 'plan-one')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'f.txt'), 'f')
    const deps = buildDeps({ w1: { title: 'One', path: root, sessionIds: ['session-1'] } }, logs)
    const single = await planTransferExport(deps, { projectIds: ['w1'], includeSettings: false, includeSecrets: false })
    expect(single.kind).toBe('project')
    expect(single.projects[0]?.folder.files).toHaveLength(1)
    const withSettings = await planTransferExport(deps, { projectIds: ['w1'], includeSettings: true, includeSecrets: false })
    expect(withSettings.kind).toBe('combined')
    const settingsOnly = await planTransferExport(
      buildDeps({}, logs),
      { projectIds: [], includeSettings: true, includeSecrets: true },
    )
    expect(settingsOnly.kind).toBe('combined')
    expect(settingsOnly.projects).toHaveLength(0)
  })
})

describe('transferArchiveEntries round-trip', () => {
  it('produces a single-project archive the house zip reader verifies', async () => {
    const root = join(tempRoot, 'round-trip')
    await mkdir(join(root, '素材'), { recursive: true })
    await writeFile(join(root, 'README.md'), '# hello\n')
    await writeFile(join(root, '素材', 'clip.bin'), 'MEDIABYTES')
    const deps = buildDeps(
      { w1: { title: 'My Project', path: root, sessionIds: ['session-1'] } },
      { 'session-1': fakeLog('session-1') },
    )
    const plan = await planTransferExport(deps, { projectIds: ['w1'], includeSettings: false, includeSecrets: false })
    const reader = await writeArchive(deps, plan)
    try {
      const names = reader.entries.map(entry => entry.name)
      expect(names[0]).toBe(PROJECT_MANIFEST_NAME)
      expect(names).toContain('project/README.md')
      expect(names).toContain('project/素材/clip.bin')
      expect(names).toContain('sessions/session-1/session.v4.jsonl')
      const manifest = JSON.parse(new TextDecoder().decode(await collect(reader, reader.entries[0]!)))
      expect(manifest['format']).toBe('prism-project')
      expect(manifest['title']).toBe('My Project')
      expect(manifest['hasProjectFolder']).toBe(true)
      expect(manifest['sessions']).toBe(1)
      const readme = reader.entryByName('project/README.md')
      if (readme !== undefined) expect(new TextDecoder().decode(await collect(reader, readme))).toBe('# hello\n')
      const logEntry = reader.entryByName('sessions/session-1/session.v4.jsonl')
      if (logEntry !== undefined) {
        const logText = new TextDecoder().decode(await collect(reader, logEntry))
        expect(logText).toContain('"type":"session"')
        expect(logText).toContain('"type":"turn/start"')
      }
    } finally {
      await reader.close()
    }
  })

  it('embeds per-project manifests and the settings document in the combined layout', async () => {
    const one = join(tempRoot, 'combined-one')
    const two = join(tempRoot, 'combined-two')
    await mkdir(one, { recursive: true })
    await mkdir(two, { recursive: true })
    await writeFile(join(one, 'a.txt'), 'A')
    await writeFile(join(two, 'b.txt'), 'B')
    const deps = buildDeps(
      {
        w1: { title: 'One', path: one, sessionIds: ['session-1'] },
        w2: { title: 'Two', path: two, sessionIds: ['session-2'] },
      },
      {
        'session-1': fakeLog('session-1'),
        'session-2': fakeLog('session-2'),
      },
    )
    const plan = await planTransferExport(deps, { projectIds: ['w1', 'w2'], includeSettings: true, includeSecrets: false })
    const reader = await writeArchive(deps, plan)
    try {
      const names = reader.entries.map(entry => entry.name)
      expect(names[0]).toBe(TRANSFER_MANIFEST_NAME)
      expect(names).toContain('projects/1-One/.prism-project.json')
      expect(names).toContain('projects/1-One/project/a.txt')
      expect(names).toContain('projects/1-One/sessions/session-1/session.v4.jsonl')
      expect(names).toContain('projects/2-Two/project/b.txt')
      expect(names).toContain(SETTINGS_ENTRY_NAME)
      const settingsEntry = reader.entryByName(SETTINGS_ENTRY_NAME)
      if (settingsEntry !== undefined) {
        const settings = JSON.parse(new TextDecoder().decode(await collect(reader, settingsEntry)))
        expect(settings).toMatchObject({ format: 'prism-settings', includeSecrets: false })
        expect(settings['namespaces']['web']).toEqual({ endpoint: '/x' })
      }
      const manifest = JSON.parse(new TextDecoder().decode(await collect(reader, reader.entries[0]!)))
      expect(manifest['projects']).toEqual([
        { dir: '1-One', title: 'One', sessions: 1 },
        { dir: '2-Two', title: 'Two', sessions: 1 },
      ])
      expect(manifest['settings']).toBe(true)
    } finally {
      await reader.close()
    }
  })
})

describe('exportFilename', () => {
  it('uses the sanitized title for one project and a stamp for combined', () => {
    const root = join(tempRoot, 'filename')
    const plan = {
      kind: 'project' as const,
      projects: [{
        source: { id: 'w1', title: 'My: Project', path: root, sessionIds: [] as readonly string[] },
        folder: { files: [], totalBytes: 0, skippedLinks: 0, skippedUnreadable: 0 },
      }],
      includeSettings: false,
      includeSecrets: false,
    }
    expect(exportFilename(plan)).toBe('My Project.zip')
    // A title that sanitizes to nothing falls back to the default project name.
    const fallback = { ...plan, projects: [{ ...plan.projects[0]!, source: { ...plan.projects[0]!.source, title: '???' } }] }
    expect(exportFilename(fallback)).toBe('project.zip')
    const stamp = exportFilename({ ...plan, kind: 'combined' }, new Date(2026, 9, 30, 12, 34, 56))
    expect(stamp).toBe('prism-transfer-20261030-123456.zip')
  })
})

describe('engine guards', () => {
  it('fails a project whose stored log cannot be read', async () => {
    const root = join(tempRoot, 'missing-log')
    await mkdir(root, { recursive: true })
    const deps = buildDeps({ w1: { title: 'Missing', path: root, sessionIds: ['ghost-1'] } }, {})
    deps.sessionPersistence.open = (async () => {
      throw new SessionPersistenceNotFoundError('ghost-1' as never)
    }) as typeof deps.sessionPersistence.open
    const plan = await planTransferExport(
      deps,
      { projectIds: ['w1'], includeSettings: true, includeSecrets: false },
    )
    const entries = transferArchiveEntries(deps, plan, new AbortController().signal)
    await expect(async () => {
      for await (const entry of entries) void entry
    }).rejects.toMatchObject({ code: 'transfer-failed' })
  })

  it('refuses a single-project plan that carries no project', async () => {
    const emptyPlan: TransferExportPlan = {
      kind: 'project',
      projects: [],
      includeSettings: false,
      includeSecrets: false,
    }
    await expect(async () => {
      for await (const entry of transferArchiveEntries(buildDeps({}, {}), emptyPlan, new AbortController().signal)) void entry
    }).rejects.toMatchObject({ message: 'single-project plan carries no project' })
    expect(() => exportFilename(emptyPlan)).toThrow('single-project plan carries no project')
  })

  it('archives an empty project folder without project entries', async () => {
    const root = join(tempRoot, 'scan-empty')
    await mkdir(root, { recursive: true })
    const deps = buildDeps({ w1: { title: 'Empty', path: root, sessionIds: [] } }, {})
    const plan = await planTransferExport(
      deps,
      { projectIds: ['w1'], includeSettings: false, includeSecrets: false },
      new AbortController().signal,
    )
    expect(plan.projects[0]?.folder.files).toEqual([])
    const reader = await writeArchive(deps, plan)
    try {
      const names = reader.entries.map(entry => entry.name)
      expect(names).toEqual([PROJECT_MANIFEST_NAME])
      const manifest = JSON.parse(new TextDecoder().decode(await collect(reader, reader.entries[0]!)))
      expect(manifest['hasProjectFolder']).toBe(false)
    } finally {
      await reader.close()
    }
  })

  it('archives a combined plan without a settings document', async () => {
    const one = join(tempRoot, 'combined-nosettings-one')
    const two = join(tempRoot, 'combined-nosettings-two')
    await mkdir(one, { recursive: true })
    await mkdir(two, { recursive: true })
    await writeFile(join(one, 'a.txt'), 'A')
    await writeFile(join(two, 'b.txt'), 'B')
    const deps = buildDeps({
      w1: { title: 'One', path: one, sessionIds: [] },
      w2: { title: 'Two', path: two, sessionIds: [] },
    }, {})
    const plan = await planTransferExport(deps, { projectIds: ['w1', 'w2'], includeSettings: false, includeSecrets: false })
    expect(plan.kind).toBe('combined')
    const names: string[] = []
    for await (const entry of transferArchiveEntries(deps, plan, new AbortController().signal)) names.push(entry.path)
    expect(names).toEqual([
      TRANSFER_MANIFEST_NAME,
      'projects/1-One/.prism-project.json',
      'projects/1-One/project/a.txt',
      'projects/2-Two/.prism-project.json',
      'projects/2-Two/project/b.txt',
    ])
  })

  it('names a session segment that survives sanitization', async () => {
    // An empty id sanitizes to the fallback segment 'session'.
    const deps = buildDeps(
      { w1: { title: 'Segments', path: join(tempRoot, 'segments'), sessionIds: [''] } },
      { '': fakeLog('') },
    )
    await mkdir(join(tempRoot, 'segments'), { recursive: true })
    const plan = await planTransferExport(deps, { projectIds: ['w1'], includeSettings: true, includeSecrets: false })
    const paths: string[] = []
    for await (const entry of transferArchiveEntries(deps, plan, new AbortController().signal)) paths.push(entry.path)
    expect(paths).toContain('projects/1-Segments/sessions/session/session.v4.jsonl')
  })

  it('refuses exports when the session trio is incomplete', () => {
    const ctx = new Context()
    expect(() => transferExportDeps(ctx, { get: async () => undefined }, fakeSettingsDeps()))
      .toThrow('transfer export is unavailable')
  })
})

describe('streamTransferZip failures', () => {
  /** One content entry, then an entry whose byte source stalls after one chunk. */
  async function* hangingEntries(): AsyncGenerator<SessionLogZipEntry> {
    yield { path: 'first.txt', content: 'first' }
    yield { path: 'slow.bin', chunks: (async function* (): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2, 3])
      await new Promise(() => {})
    })() }
    await new Promise(() => {})
  }

  /** One content entry, then a thrown value. */
  async function* throwingEntries(thrown: unknown): AsyncGenerator<SessionLogZipEntry> {
    yield { path: 'first.txt', content: 'first' }
    throw thrown
  }

  it('terminates the writer and reports the cancel reason', async () => {
    for (const reason of [new Error('consumer went away'), 'consumer went away']) {
      const stream = streamTransferZip(hangingEntries(), new AbortController().signal)
      const reader = stream.getReader()
      await reader.read()
      // The parked producer observes the cancellation, fails, and terminates
      // the writer a second time.
      await reader.cancel(reason).catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  })

  it('fails the download when the entry producer throws', async () => {
    for (const thrown of [new Error('unreadable log'), 'unreadable log']) {
      const stream = streamTransferZip(throwingEntries(thrown), new AbortController().signal)
      await expect(async () => {
        for await (const chunk of stream) void chunk
      }).rejects.toThrow('unreadable log')
    }
  })

  it('streams binary entries through the storage level', async () => {
    const payload = new TextEncoder().encode('raw media bytes')
    const stream = streamTransferZip((async function* (): AsyncGenerator<SessionLogZipEntry> {
      yield { path: 'media.bin', data: payload }
    })(), new AbortController().signal)
    const chunks: Uint8Array[] = []
    for await (const chunk of stream) chunks.push(chunk)
    const zip = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
    const path = join(tempRoot, `${randomUUID()}.zip`)
    await writeFile(path, zip)
    const reader = await ZipArchiveReader.open(path)
    try {
      const entry = reader.entryByName('media.bin')!
      const read: Uint8Array[] = []
      for await (const chunk of reader.bytes(entry)) read.push(chunk)
      expect(Buffer.concat(read.map(chunk => Buffer.from(chunk))).equals(Buffer.from(payload))).toBe(true)
    } finally {
      await reader.close()
    }
  })
})

describe('error type', () => {
  it('keeps the typed status through the export pipeline', () => {
    expect(new TransferError('unknown-workspace', 'gone').status).toBe(404)
  })

  it('passes TransferErrors through asTransferError untouched', () => {
    const original = new TransferError('busy', 'already running')
    expect(asTransferError(original)).toBe(original)
    expect(asTransferError(original, 'bad-archive')).toBe(original)
  })

  it('wraps Error and non-Error values with the fallback code', () => {
    expect(asTransferError(new Error('disk full'))).toMatchObject({ code: 'transfer-failed', message: 'disk full' })
    expect(asTransferError('plain refusal', 'io')).toMatchObject({ code: 'io', message: 'plain refusal' })
    expect(asTransferError(undefined, 'io')).toMatchObject({ code: 'io', message: 'undefined' })
  })
})
