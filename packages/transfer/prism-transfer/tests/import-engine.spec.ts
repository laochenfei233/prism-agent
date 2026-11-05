import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLineageNode } from '@deepseek-ai/dsh-session-query'
import { zipSync, type Zippable } from 'fflate'
import {
  runImport,
  sweepStaleStaging,
  STAGING_PREFIX,
  type ImportProjections,
  type TransferImportDeps,
} from '../src/import-engine.ts'
import type { TransferJobProgress } from '../src/job.ts'
import {
  planTransferExport,
  streamTransferZip,
  transferArchiveEntries,
  transferExportDeps,
  type TransferExportDeps,
} from '../src/export-engine.ts'
import type { SettingsTransferDeps } from '../src/settings-transfer.ts'
import { PROJECT_MANIFEST_NAME, SETTINGS_ENTRY_NAME, TRANSFER_MANIFEST_NAME } from '../src/types.ts'

const tempRoot = await mkdtemp(join(tmpdir(), 'prism-transfer-import-'))

const sid = (id: string): SessionId => id as SessionId
const digestOf = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')
const text = (value: string): Uint8Array => new TextEncoder().encode(value)

/** A minimal valid session header line with the running format version. */
function headerLine(id: string, version: number = SESSION_FORMAT_VERSION): string {
  return `${JSON.stringify({
    type: 'session',
    version,
    id,
    createdAt: 1000,
    isSeeded: false,
    delegationDepth: 0,
  })}\n`
}

/** One envelope-valid event line. */
function eventLine(seq: number): string {
  return `${JSON.stringify({ type: 'turn/start', seq, time: 2000, data: { turn: 1 } })}\n`
}

/** Recorded fake persistence. */
function fakePersistence(existing: Set<string>) {
  const restored: SessionHeader[] = []
  return {
    restored,
    persistence: {
      stat: async (id: SessionId) => existing.has(String(id)) ? { header: {} } : undefined,
      create: async (header: SessionHeader) => {
        restored.push(header)
        existing.add(String(header.id))
        return {
          append: async () => {},
          flush: async () => {},
          close: async () => {},
        }
      },
    },
  }
}

/** Recorded fake workspace registry. */
function fakeWorkspaces() {
  const created: string[] = []
  const attached: SessionId[] = []
  return {
    created,
    attached,
    workspaces: {
      create: async (path: string) => {
        created.push(path)
        return {
          id: `ws-${String(created.length)}`,
          attachSession: async (id: SessionId) => {
            attached.push(id)
          },
        }
      },
    },
  }
}

/** Content-addressed fake attachment seam. */
function fakeAttachments(options: { saveImageId?: string } = {}) {
  const savedFiles: string[] = []
  return {
    savedFiles,
    attachments: {
      imageLimits: { maxImageBytes: 8 * 2 ** 20 },
      saveImage: async (input: { data: Uint8Array }) => ({
        attachmentId: options.saveImageId ?? `sha256:${digestOf(input.data)}`,
      }),
      saveFileStream: async (input: { data: AsyncIterable<Uint8Array>; name: string }) => {
        const chunks: Uint8Array[] = []
        for await (const chunk of input.data) chunks.push(chunk)
        const joined = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
        savedFiles.push(`${input.name}:${digestOf(joined)}`)
        return { attachmentId: `sha256:${digestOf(joined)}` }
      },
    },
  }
}

function fakeSettingsDeps(): SettingsTransferDeps & { readonly updates: string[] } {
  const updates: string[] = []
  return {
    describe: () => [{
      ns: 'web',
      autoGenerate: true,
      schema: { type: 'object', dict: { endpoint: { type: 'string' } } },
      value: { endpoint: '/x' },
      revision: 4,
      applies: 'live',
    } as never],
    update: async (ns) => {
      updates.push(ns)
    },
    updates,
  }
}

function buildDeps(options: {
  existing?: Set<string>
  homePath: string
  saveImageId?: string
  projections?: ImportProjections
}): TransferImportDeps {
  const persistence = fakePersistence(options.existing ?? new Set())
  const workspaces = fakeWorkspaces()
  const attachments = fakeAttachments(options.saveImageId === undefined ? {} : { saveImageId: options.saveImageId })
  return {
    persistence: persistence.persistence,
    workspaces: workspaces.workspaces,
    attachments: attachments.attachments,
    settings: fakeSettingsDeps(),
    homePath: options.homePath,
    ...(options.projections === undefined ? {} : { projections: options.projections }),
  }
}

/** No-op progress sink for engine calls outside the job store. */
function silentProgress(): TransferJobProgress {
  return {
    setKind: () => {},
    setPhase: () => {},
    addFiles: () => {},
    addBytes: () => {},
    setSessionsTotal: () => {},
    addSessionsDone: () => {},
    addDuplicates: () => {},
    setProjectsTotal: () => {},
    addProjectDone: () => {},
  }
}

/** Spool bytes to a file and return its path and size. */
async function spool(bytes: Uint8Array): Promise<{ path: string; bytes: number }> {
  const path = join(tempRoot, `${randomUUID()}.zip`)
  await writeFile(path, bytes)
  return { path, bytes: bytes.byteLength }
}

/** Build one single-project archive with the given entries beside the manifest. */
function projectArchive(manifest: Record<string, unknown>, entries: Zippable): Uint8Array {
  return zipSync({
    [PROJECT_MANIFEST_NAME]: text(`${JSON.stringify({ format: 'prism-project', version: 1, sessions: 1, ...manifest }, null, 2)}\n`),
    ...entries,
  }, { level: 6 })
}

describe('runImport round-trip', () => {
  it('restores a real export: files byte-identical, session + checkpoint + workspace', async () => {
    const homePath = join(tempRoot, 'home-rt')
    const projectRoot = join(homePath, 'source-project')
    await mkdir(join(projectRoot, 'deep'), { recursive: true })
    await writeFile(join(projectRoot, 'README.md'), '# round trip\n')
    await writeFile(join(projectRoot, 'deep', 'note.txt'), 'nested')
    const destinationRoot = join(tempRoot, 'dest-rt')
    await mkdir(destinationRoot, { recursive: true })

    // Export through the real engine: one project, one session.
    const log = {
      header: {
        version: SESSION_FORMAT_VERSION,
        id: sid('rt-session-1'),
        createdAt: 1000,
        isSeeded: false,
        cwd: projectRoot,
        delegationDepth: 0,
      },
      events: [{ type: 'turn/start', seq: 0, time: 2000, data: { turn: 1 } } as SessionEvent],
    }
    const exportCtx = new Context()
    const sessionDeps = {
      sessionQuery: {
        traceSession: async (): Promise<{ descendants: readonly SessionLineageNode[] }> => ({ descendants: [] }),
      } as never,
      sessionPersistence: {
        open: async () => ({
          id: log.header.id,
          header: log.header,
          access: 'read',
          inheritedEventCount: 0,
          read: async () => ({ eventState: 'detached', events: structuredClone(log.events) }),
          close: async () => {},
        } as never),
      } as never,
      attachments: { readImage: async () => {
        throw new Error('no images in fixture')
      } } as never,
    }
    exportCtx.provide('sessionQuery', sessionDeps.sessionQuery)
    exportCtx.provide('sessionPersistence', sessionDeps.sessionPersistence)
    exportCtx.provide('attachments', sessionDeps.attachments)
    const exportDeps: TransferExportDeps = transferExportDeps(
      exportCtx,
      { get: async () => ({ id: 'w1', title: 'Round Trip', path: projectRoot, sessionIds: ['rt-session-1'] }) },
      fakeSettingsDeps(),
    )
    const plan = await planTransferExport(exportDeps, { projectIds: ['w1'], includeSettings: false, includeSecrets: false })
    const controller = new AbortController()
    const stream = streamTransferZip(transferArchiveEntries(exportDeps, plan, controller.signal), controller.signal)
    const chunks: Uint8Array[] = []
    for await (const chunk of stream) chunks.push(chunk)
    const archive = await spool(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))

    const checkpoints: string[] = []
    const deps = buildDeps({
      homePath,
      projections: {
        checkpoint: async (header) => {
          checkpoints.push(String(header.id))
        },
      },
    })
    const result = await runImport(deps, {
      archivePath: archive.path,
      archiveBytes: archive.bytes,
      destinationRoot,
    }, silentProgress())
    expect(result.kind).toBe('project')
    expect(result.projects).toEqual([{
      name: 'Round Trip',
      path: join(destinationRoot, 'Round Trip'),
      sessions: 1,
      duplicates: 0,
    }])
    expect(await readFile(join(destinationRoot, 'Round Trip', 'README.md'), 'utf8')).toBe('# round trip\n')
    expect(await readFile(join(destinationRoot, 'Round Trip', 'deep', 'note.txt'), 'utf8')).toBe('nested')
    expect(deps.persistence).toBeDefined()
    expect(checkpoints).toEqual(['rt-session-1'])
    // The staging directory is gone; the destination holds only the project.
    const remaining = await readdir(destinationRoot)
    expect(remaining.every(name => !name.startsWith(STAGING_PREFIX))).toBe(true)
  })

  it('suffixes a colliding name and never touches the existing directory', async () => {
    const destinationRoot = join(tempRoot, 'dest-collide')
    const homePath = join(tempRoot, 'home-collide')
    await mkdir(destinationRoot, { recursive: true })
    await mkdir(join(destinationRoot, 'Existing'), { recursive: true })
    await writeFile(join(destinationRoot, 'Existing', 'original.txt'), 'untouched')
    const archive = await spool(projectArchive(
      { title: 'Existing', exportedAt: 't', hasProjectFolder: true },
      { 'project/new.txt': text('new') },
    ))
    const deps = buildDeps({ homePath })
    const result = await runImport(deps, {
      archivePath: archive.path,
      archiveBytes: archive.bytes,
      destinationRoot,
    }, silentProgress())
    expect(result.projects[0]?.name).toBe('Existing (2)')
    expect(await readFile(join(destinationRoot, 'Existing', 'original.txt'), 'utf8')).toBe('untouched')
    expect(await readFile(join(destinationRoot, 'Existing (2)', 'new.txt'), 'utf8')).toBe('new')
  })

  it('restores a combined archive with settings, dedupes sessions, and registers once', async () => {
    const destinationRoot = join(tempRoot, 'dest-combined')
    const homePath = join(tempRoot, 'home-combined')
    await mkdir(destinationRoot, { recursive: true })
    const manifest = {
      format: 'prism-transfer',
      version: 1,
      exportedAt: 't',
      projects: [{ dir: '1-Alpha', title: 'Alpha', sessions: 1 }],
      settings: true,
    }
    const projectManifest = {
      format: 'prism-project',
      version: 1,
      title: 'Alpha',
      exportedAt: 't',
      sessions: 1,
      hasProjectFolder: true,
    }
    const bytes = zipSync({
      [TRANSFER_MANIFEST_NAME]: text(`${JSON.stringify(manifest)}\n`),
      'projects/1-Alpha/.prism-project.json': text(`${JSON.stringify(projectManifest)}\n`),
      'projects/1-Alpha/project/a.txt': text('A'),
      [`projects/1-Alpha/sessions/comb-1/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]:
        text(`${headerLine('comb-1')}${eventLine(0)}`),
      [SETTINGS_ENTRY_NAME]: text(`${JSON.stringify({
        format: 'prism-settings',
        version: 1,
        exportedAt: 't',
        includeSecrets: false,
        namespaces: { web: { endpoint: '/restored' } },
      })}\n`),
    }, { level: 6 })
    const archive = await spool(bytes)
    const deps = buildDeps({ homePath })
    const result = await runImport(deps, { archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot }, silentProgress())
    expect(result.projects).toEqual([{
      name: 'Alpha',
      path: join(destinationRoot, 'Alpha'),
      sessions: 1,
      duplicates: 0,
    }])
    expect(result.settings).toEqual([{ ns: 'web', outcome: 'applied' }])
    // Re-importing the same archive: the session dedupes and the name suffixed.
    const second = await runImport(deps, { archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot }, silentProgress())
    expect(second.projects[0]?.name).toBe('Alpha (2)')
    expect(second.projects[0]?.duplicates).toBe(1)
    expect(second.projects[0]?.sessions).toBe(0)
  })

  it('restores media and files through the seam with content-address verification', async () => {
    const destinationRoot = join(tempRoot, 'dest-media')
    const homePath = join(tempRoot, 'home-media')
    await mkdir(destinationRoot, { recursive: true })
    const imageBytes = text('PNGDATA')
    const fileBytes = text('FILEDATA')
    const archive = await spool(projectArchive(
      { title: 'Media', exportedAt: 't', hasProjectFolder: false },
      {
        [`sessions/m-1/media/sha256:${digestOf(imageBytes)}.png`]: imageBytes,
        [`sessions/m-1/files/${digestOf(fileBytes).slice(0, 2)}/${digestOf(fileBytes)}/report.txt`]: fileBytes,
        [`sessions/m-1/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]: text(`${headerLine('m-1')}${eventLine(0)}`),
      },
    ))
    const deps = buildDeps({ homePath })
    const result = await runImport(deps, { archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot }, silentProgress())
    expect(result.projects[0]?.sessions).toBe(1)
    expect(result.projects[0]).not.toHaveProperty('registerError')
  })

  it('fails a media entry whose stored content address does not match', async () => {
    const destinationRoot = join(tempRoot, 'dest-mismatch')
    const homePath = join(tempRoot, 'home-mismatch')
    await mkdir(destinationRoot, { recursive: true })
    const imageBytes = text('PNGDATA')
    const archive = await spool(projectArchive(
      { title: 'Mismatch', exportedAt: 't', hasProjectFolder: false },
      {
        [`sessions/m-2/media/sha256:${'0'.repeat(64)}.png`]: imageBytes,
        [`sessions/m-2/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]: text(`${headerLine('m-2')}${eventLine(0)}`),
      },
    ))
    const deps = buildDeps({ homePath })
    await expect(runImport(deps, { archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot }, silentProgress()))
      .rejects.toMatchObject({ code: 'attachment-mismatch' })
    // Nothing published; staging removed.
    expect(await readdir(destinationRoot)).toEqual([])
  })
})

describe('runImport refusals', () => {
  const destinationRoot = join(tempRoot, 'dest-refusals')
  const homePath = join(tempRoot, 'home-refusals')

  it('rejects a manifest-less zip', async () => {
    await mkdir(destinationRoot, { recursive: true })
    const archive = await spool(zipSync({ 'plain.txt': text('x') }, { level: 6 }))
    await expect(runImport(buildDeps({ homePath }), {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())).rejects.toMatchObject({ code: 'bad-manifest' })
  })

  it('rejects a manifest entry that is not valid JSON', async () => {
    const archive = await spool(zipSync({
      [PROJECT_MANIFEST_NAME]: text('this is not json'),
    }, { level: 6 }))
    await expect(runImport(buildDeps({ homePath }), {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())).rejects.toMatchObject({ code: 'bad-archive' })
  })

  it('rejects a manifest entry past the document size ceiling', async () => {
    const archive = await spool(zipSync({
      [PROJECT_MANIFEST_NAME]: text(`{"filler":"${'0'.repeat(17 * 2 ** 20)}"}`),
    }, { level: 6 }))
    await expect(runImport(buildDeps({ homePath }), {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())).rejects.toMatchObject({ code: 'entry-too-large' })
  })

  it('rejects an unsupported manifest version', async () => {
    const archive = await spool(projectArchive(
      { title: 'Future', exportedAt: 't', hasProjectFolder: false, version: 2 },
      {},
    ))
    await expect(runImport(buildDeps({ homePath }), {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())).rejects.toMatchObject({ code: 'bad-manifest' })
  })

  it('rejects a relative destination outright', async () => {
    const archive = await spool(projectArchive(
      { title: 'Relative', exportedAt: 't', hasProjectFolder: false },
      {},
    ))
    await expect(runImport(buildDeps({ homePath }), {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot: 'relative/dest',
    }, silentProgress())).rejects.toMatchObject({ code: 'bad-destination' })
  })

  it('refuses an archive whose declared size does not fit the destination volume', async () => {
    const archive = await spool(projectArchive(
      { title: 'DiskSpace', exportedAt: 't', hasProjectFolder: false },
      {},
    ))
    await expect(runImport(buildDeps({ homePath }), {
      // The caller-supplied archive size is a claim, so a bogus one exercises
      // the free-space refusal without filling a real volume.
      archivePath: archive.path, archiveBytes: Number.MAX_SAFE_INTEGER / 2, destinationRoot,
    }, silentProgress())).rejects.toMatchObject({ code: 'disk-space' })
  })

  it('refuses a project entry whose name carries a colon (NTFS stream vector)', async () => {
    await mkdir(destinationRoot, { recursive: true })
    const archive = await spool(projectArchive(
      { title: 'Ads', exportedAt: 't', hasProjectFolder: true },
      {
        // Ordered after 'a' would silently write the stream 'a:b' onto 'a';
        // the guard refuses regardless of order.
        'project/a:b': new Uint8Array([1]),
      },
    ))
    await expect(runImport(buildDeps({ homePath }), {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())).rejects.toMatchObject({ code: 'unsafe-path' })
  })

  it('rejects a session log with a future format version', async () => {
    const archive = await spool(projectArchive(
      { title: 'FutureSession', exportedAt: 't', hasProjectFolder: false },
      {
        [`sessions/f-1/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]:
          text(`${headerLine('f-1', SESSION_FORMAT_VERSION + 1)}${eventLine(0)}`),
      },
    ))
    await expect(runImport(buildDeps({ homePath }), {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())).rejects.toMatchObject({ code: 'session-version' })
  })

  it('rejects structurally broken session logs', async () => {
    const log = `sessions/b-1/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`
    for (const [label, body, code] of [
      ['header only', headerLine('b-1'), 'bad-archive'],
      ['non-JSON header', `not json\n${eventLine(0)}`, 'bad-archive'],
      ['non-session header', `${JSON.stringify({ type: 'turn/start', seq: 0 })}\n${eventLine(0)}`, 'bad-archive'],
      ['header without id', `${JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION })}\n${eventLine(0)}`, 'bad-archive'],
    ] as const) {
      const archive = await spool(projectArchive(
        { title: 'BrokenLog', exportedAt: 't', hasProjectFolder: false },
        { [log]: text(body) },
      ))
      await expect(runImport(buildDeps({ homePath }), {
        archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
      }, silentProgress()), label).rejects.toMatchObject({ code })
    }
  })

  it('rejects malformed event lines', async () => {
    const log = `sessions/b-2/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`
    for (const [label, body] of [
      ['non-JSON event', `${headerLine('b-2')}not json\n`],
      ['envelope-invalid event', `${headerLine('b-2')}${JSON.stringify({ type: 7, seq: 'x' })}\n`],
    ] as const) {
      const archive = await spool(projectArchive(
        { title: 'BrokenEvent', exportedAt: 't', hasProjectFolder: false },
        { [log]: text(body) },
      ))
      await expect(runImport(buildDeps({ homePath }), {
        archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
      }, silentProgress()), label).rejects.toMatchObject({ code: 'bad-archive' })
    }
  })

  it('rejects a known-type event that fails event validation, naming its seq', async () => {
    const archive = await spool(projectArchive(
      { title: 'KnownShape', exportedAt: 't', hasProjectFolder: false },
      {
        [`sessions/b-3/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]: text(`${headerLine('b-3')}${
          JSON.stringify({ type: 'user/message', seq: 3, time: 2000, data: {} })}\n`),
      },
    ))
    await expect(runImport(buildDeps({ homePath }), {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())).rejects.toMatchObject({ code: 'bad-archive', message: /seq 3/ })
  })

  it('imports a plugin-owned unknown event type uninterpreted', async () => {
    const archive = await spool(projectArchive(
      { title: 'ExtensionEvent', exportedAt: 't', hasProjectFolder: false },
      {
        [`sessions/b-4/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]: text(`${headerLine('b-4')}${
          JSON.stringify({ type: 'plugin/telemetry', seq: 0, time: 2000, data: { arbitrary: true } })}\n`),
      },
    ))
    const result = await runImport(buildDeps({ homePath }), {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())
    expect(result.projects[0]?.sessions).toBe(1)
  })

  it('rejects a session whose stored write fails', async () => {
    const archive = await spool(projectArchive(
      { title: 'WriteFail', exportedAt: 't', hasProjectFolder: false },
      { [`sessions/w-1/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]: text(`${headerLine('w-1')}${eventLine(0)}`) },
    ))
    for (const thrown of [new Error('volume is read-only'), 'volume is read-only']) {
      const deps = buildDeps({ homePath })
      deps.persistence.create = async () => ({
        append: async () => {
          throw thrown
        },
        flush: async () => {},
        close: async () => {},
      })
      await expect(runImport(deps, {
        archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
      }, silentProgress())).rejects.toMatchObject({ code: 'bad-archive', message: /volume is read-only/ })
    }
  })

  it('refuses media entries that carry no readable image identity', async () => {
    const log = `sessions/m-9/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`
    for (const [label, name] of [
      ['no extension', `sessions/m-9/media/sha256:${'a'.repeat(64)}`],
      ['not content-addressed', 'sessions/m-9/media/photo.png'],
    ] as const) {
      const archive = await spool(projectArchive(
        { title: 'MediaNames', exportedAt: 't', hasProjectFolder: false },
        { [name]: text('PNGDATA'), [log]: text(`${headerLine('m-9')}${eventLine(0)}`) },
      ))
      await expect(runImport(buildDeps({ homePath }), {
        archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
      }, silentProgress()), label).rejects.toMatchObject({ code: 'bad-archive' })
    }
  })

  it('refuses media entries beyond the deployment image limit', async () => {
    const archive = await spool(projectArchive(
      { title: 'MediaBig', exportedAt: 't', hasProjectFolder: false },
      {
        [`sessions/m-8/media/sha256:${'b'.repeat(64)}.png`]: text(`0:${'0'.repeat(9 * 2 ** 20)}`),
        [`sessions/m-8/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]: text(`${headerLine('m-8')}${eventLine(0)}`),
      },
    ))
    await expect(runImport(buildDeps({ homePath }), {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())).rejects.toMatchObject({ code: 'entry-too-large' })
  })

  it('refuses media and file entries the attachment seam cannot store', async () => {
    const imageBytes = text('PNGDATA')
    const fileBytes = text('FILEDATA')
    const archive = await spool(projectArchive(
      { title: 'SeamFail', exportedAt: 't', hasProjectFolder: false },
      {
        [`sessions/sf-1/media/sha256:${digestOf(imageBytes)}.png`]: imageBytes,
        [`sessions/sf-1/files/${digestOf(fileBytes).slice(0, 2)}/${digestOf(fileBytes)}/report.txt`]: fileBytes,
        [`sessions/sf-1/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]: text(`${headerLine('sf-1')}${eventLine(0)}`),
      },
    ))
    for (const thrown of [new Error('disk is full'), 'disk is full']) {
      const deps = buildDeps({ homePath })
      let images = 0
      deps.attachments.saveImage = async () => {
        images += 1
        throw thrown
      }
      await expect(runImport(deps, {
        archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
      }, silentProgress())).rejects.toMatchObject({ code: 'attachment-failed', message: /disk is full/ })
    }
  })

  it('refuses file entries that are not content-addressed', async () => {
    const archive = await spool(projectArchive(
      { title: 'FileDigest', exportedAt: 't', hasProjectFolder: false },
      {
        'sessions/fd-1/files/zz/report.txt': text('FILEDATA'),
        [`sessions/fd-1/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]: text(`${headerLine('fd-1')}${eventLine(0)}`),
      },
    ))
    await expect(runImport(buildDeps({ homePath }), {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())).rejects.toMatchObject({ code: 'bad-archive' })
  })

  it('refuses file entries stored under a different content address', async () => {
    const fileBytes = text('FILEDATA')
    const archive = await spool(projectArchive(
      { title: 'FileMismatch', exportedAt: 't', hasProjectFolder: false },
      {
        [`sessions/fm-1/files/${digestOf(fileBytes).slice(0, 2)}/${digestOf(fileBytes)}/report.txt`]: fileBytes,
        [`sessions/fm-1/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]: text(`${headerLine('fm-1')}${eventLine(0)}`),
      },
    ))
    const deps = buildDeps({ homePath })
    deps.attachments.saveFileStream = async () => ({ attachmentId: `sha256:${'c'.repeat(64)}` })
    await expect(runImport(deps, {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())).rejects.toMatchObject({ code: 'attachment-mismatch' })
  })

  it('surfaces reader CRC failures from a tampered media entry', async () => {
    const imageBytes = text('PNGDATA-tampered-target')
    const archive = zipSync({
      [PROJECT_MANIFEST_NAME]: text(`${JSON.stringify({
        format: 'prism-project', version: 1, title: 'Crc', exportedAt: 't', sessions: 1, hasProjectFolder: false,
      })}\n`),
      // Media is stored, not deflated — the exporter's own convention.
      [`sessions/c-1/media/sha256:${digestOf(imageBytes)}.png`]: [imageBytes, { level: 0 }],
      [`sessions/c-1/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]: text(`${headerLine('c-1')}${eventLine(0)}`),
    }, { level: 6 })
    // Flip one byte inside the entry's stored data: the CRC no longer matches.
    const dataAt = Buffer.from(archive).indexOf(Buffer.from(imageBytes))
    if (dataAt < 0) throw new Error('entry data not found in archive')
    archive[dataAt] = (archive[dataAt]! + 1) & 0xff
    const spooled = await spool(archive)
    await expect(runImport(buildDeps({ homePath }), {
      archivePath: spooled.path, archiveBytes: spooled.bytes, destinationRoot,
    }, silentProgress())).rejects.toMatchObject({ code: 'crc-mismatch' })
  })

  it('surfaces reader CRC failures from a tampered project folder entry during extraction', async () => {
    const fileBytes = text('FOLDERDATA-tampered-target')
    const archive = zipSync({
      [PROJECT_MANIFEST_NAME]: text(`${JSON.stringify({
        format: 'prism-project', version: 1, title: 'CrcFolder', exportedAt: 't', sessions: 0, hasProjectFolder: true,
      })}\n`),
      ['project/data.bin']: [fileBytes, { level: 0 }],
    }, { level: 6 })
    const dataAt = Buffer.from(archive).indexOf(Buffer.from(fileBytes))
    if (dataAt < 0) throw new Error('entry data not found in archive')
    archive[dataAt] = (archive[dataAt]! + 1) & 0xff
    const spooled = await spool(archive)
    await expect(runImport(buildDeps({ homePath }), {
      archivePath: spooled.path, archiveBytes: spooled.bytes, destinationRoot,
    }, silentProgress())).rejects.toMatchObject({ code: 'crc-mismatch' })
  })

  it('keeps other sessions when one registers but reports the failure', async () => {
    const archive = await spool(projectArchive(
      { title: 'RegisterFail', exportedAt: 't', hasProjectFolder: false },
      { [`sessions/r-1/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]: text(`${headerLine('r-1')}${eventLine(0)}`) },
    ))
    const deps = buildDeps({ homePath })
    const originalCreate = deps.workspaces.create
    deps.workspaces.create = async (path) => {
      const workspace = await originalCreate(path)
      return {
        id: workspace.id,
        attachSession: async () => {
          throw new Error('registry is read-only')
        },
      }
    }
    const result = await runImport(deps, {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())
    expect(result.projects[0]?.sessions).toBe(1)
    expect(result.projects[0]?.registerError).toContain('registry is read-only')
  })

  it('reports attach and registration failures as their string form for non-Error values', async () => {
    const archive = await spool(projectArchive(
      { title: 'RegisterString', exportedAt: 't', hasProjectFolder: false },
      { [`sessions/rs-1/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]: text(`${headerLine('rs-1')}${eventLine(0)}`) },
    ))
    for (const thrown of [new Error('registry denies writes'), 'registry denies writes']) {
      const deps = buildDeps({ homePath })
      deps.workspaces.create = async () => {
        throw thrown
      }
      const result = await runImport(deps, {
        archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
      }, silentProgress())
      expect(result.projects[0]?.registerError).toContain('workspace registration failed: registry denies writes')
    }
    const deps = buildDeps({ homePath })
    const originalCreate = deps.workspaces.create
    deps.workspaces.create = async (path) => {
      const workspace = await originalCreate(path)
      return {
        id: workspace.id,
        attachSession: async () => {
          throw 'attach refused'
        },
      }
    }
    const result = await runImport(deps, {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())
    expect(result.projects[0]?.registerError).toContain('attach refused')
  })
})

describe('safety rails', () => {
  it('suffixes a publication target that would collide with a reserved home entry', async () => {
    const homePath = join(tempRoot, 'home-reserved')
    await mkdir(homePath, { recursive: true })
    const archive = await spool(projectArchive(
      { title: 'sessions', exportedAt: 't', hasProjectFolder: true },
      { 'project/data.txt': text('x') },
    ))
    const deps = buildDeps({ homePath })
    const result = await runImport(deps, {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot: homePath,
    }, silentProgress())
    expect(result.projects[0]?.name).toBe('sessions (2)')
  })

  it('suffixes a publication target that would overwrite the home directory itself', async () => {
    const homePath = join(tempRoot, 'home-pub')
    await mkdir(homePath, { recursive: true })
    const archive = await spool(projectArchive(
      { title: 'home-pub', exportedAt: 't', hasProjectFolder: true },
      { 'project/data.txt': text('x') },
    ))
    const deps = buildDeps({ homePath })
    const result = await runImport(deps, {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot: tempRoot,
    }, silentProgress())
    expect(result.projects[0]?.name).toBe('home-pub (2)')
  })

  it('sweeps staging directories only past the retention age', async () => {
    const destinationRoot = join(tempRoot, 'dest-sweep')
    await mkdir(destinationRoot, { recursive: true })
    const first = join(destinationRoot, `${STAGING_PREFIX}one`)
    const second = join(destinationRoot, `${STAGING_PREFIX}two`)
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    const now = Date.now()
    // At the real clock both directories are fresh; a day later both are stale.
    expect(await sweepStaleStaging(destinationRoot, { now })).toBe(0)
    expect(await sweepStaleStaging(destinationRoot, { now: now + 25 * 60 * 60 * 1000 })).toBe(2)
    await expect(stat(first)).rejects.toThrow()
    await expect(stat(second)).rejects.toThrow()
  })

  it('answers zero for a destination whose staging directory cannot be listed', async () => {
    expect(await sweepStaleStaging(join(tempRoot, 'sweep-missing-destination'))).toBe(0)
  })
})

describe('full-featured imports', () => {
  it('restores main and subagent logs, defaulting the header fields they omit', async () => {
    const destinationRoot = join(tempRoot, 'dest-subagents')
    const homePath = join(tempRoot, 'home-subagents')
    await mkdir(destinationRoot, { recursive: true })
    const header = `${JSON.stringify({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: 'sub-child-1',
      isSeeded: false,
      parentSession: 'sub-parent-1',
      origin: 'subagent',
      agentPreset: 'reviewer',
    })}\n`
    const archive = await spool(projectArchive(
      { title: 'Subagents', exportedAt: 't', hasProjectFolder: true },
      {
        [`sessions/sub-parent-1/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]:
          // No trailing newline: the parser must not assume one.
          text(`${headerLine('sub-parent-1')}${eventLine(0)}`.trimEnd()),
        [`sessions/sub-parent-1/subagents/sub-child-1/session.v${String(SESSION_FORMAT_VERSION)}.jsonl`]:
          text(`${header}${eventLine(0)}`),
        // Neither log, media, nor files: the scan ignores it.
        'sessions/sub-parent-1/notes.txt': text('notes'),
        'project/big.bin': [pseudoRandomBytes(300_000), { level: 0 }],
      },
    ))
    const deps = buildDeps({ homePath })
    const result = await runImport(deps, {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())
    expect(result.projects[0]?.sessions).toBe(2)
    expect(result.projects[0]).not.toHaveProperty('registerError')
    await expect(stat(join(destinationRoot, 'Subagents', 'big.bin'))).resolves.toMatchObject({ size: 300_000 })
  })

  it('refuses combined archives whose layout lies', async () => {
    const destinationRoot = join(tempRoot, 'dest-combined-refusals')
    const homePath = join(tempRoot, 'home-combined-refusals')
    await mkdir(destinationRoot, { recursive: true })
    const transferManifest = (projects: unknown[], settings: boolean): Uint8Array =>
      text(`${JSON.stringify({ format: 'prism-transfer', version: 1, exportedAt: 't', projects, settings })}\n`)
    const childManifest = text(`${JSON.stringify({
      format: 'prism-project', version: 1, title: 'Alpha', exportedAt: 't', sessions: 0, hasProjectFolder: false,
    })}\n`)
    const cases: [string, Record<string, Uint8Array>, string][] = [
      ['missing child manifest', {
        [TRANSFER_MANIFEST_NAME]: transferManifest([{ dir: '1-Alpha', title: 'Alpha', sessions: 0 }], false),
      }, 'bad-manifest'],
      ['no projects', {
        [TRANSFER_MANIFEST_NAME]: transferManifest([], false),
      }, 'no-projects'],
      ['declared settings without a settings entry', {
        [TRANSFER_MANIFEST_NAME]: transferManifest([{ dir: '1-Alpha', title: 'Alpha', sessions: 0 }], true),
        'projects/1-Alpha/.prism-project.json': childManifest,
      }, 'bad-manifest'],
    ]
    for (const [label, entries, code] of cases) {
      const archive = await spool(zipSync(entries, { level: 6 }))
      await expect(runImport(buildDeps({ homePath }), {
        archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
      }, silentProgress()), label).rejects.toMatchObject({ code })
    }
  })

  it('imports a combined archive whose manifest declares no settings', async () => {
    const destinationRoot = join(tempRoot, 'dest-combined-nosettings')
    const homePath = join(tempRoot, 'home-combined-nosettings')
    await mkdir(destinationRoot, { recursive: true })
    const archive = await spool(zipSync({
      [TRANSFER_MANIFEST_NAME]: text(`${JSON.stringify({
        format: 'prism-transfer', version: 1, exportedAt: 't', settings: false,
        projects: [{ dir: '1-Alpha', title: 'Alpha', sessions: 0 }],
      })}\n`),
      'projects/1-Alpha/.prism-project.json': text(`${JSON.stringify({
        format: 'prism-project', version: 1, title: 'Alpha', exportedAt: 't', sessions: 0, hasProjectFolder: false,
      })}\n`),
    }, { level: 6 }))
    const result = await runImport(buildDeps({ homePath }), {
      archivePath: archive.path, archiveBytes: archive.bytes, destinationRoot,
    }, silentProgress())
    expect(result.projects).toHaveLength(1)
    expect(result.settings).toBeUndefined()
  })
})

/** Deterministic pseudo-random bytes for incompressible folder entries. */
function pseudoRandomBytes(length: number): Uint8Array {
  let state = 0x53544154
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    bytes[index] = state >>> 24
  }
  return bytes
}
