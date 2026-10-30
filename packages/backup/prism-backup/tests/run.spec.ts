/** Run pipeline: single-flight, phases, rotation, history, and failure classification. */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import type { BackupHistory } from '../src/history.ts'
import { BackupRunner, archiveName, archiveStamp } from '../src/run.ts'
import type { BackupRunRecord, BackupSecretId } from '../src/types.ts'

const roots: string[] = []

/**
 * Build one throwaway Harness home with a memory record.
 * @returns the home path.
 */
async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'prism-backup-run-'))
  roots.push(home)
  await mkdir(join(home, 'storages', 'prism_memory', 'records'), { recursive: true })
  await writeFile(join(home, 'storages', 'prism_memory', 'records', 'mem_1.json'), '{}', 'utf8')
  return home
}

/** History kept in memory for one test. */
class MemoryHistory implements BackupHistory {
  readonly records: BackupRunRecord[] = []
  async ensure(): Promise<void> {}
  list(): readonly BackupRunRecord[] {
    return [...this.records].sort((left, right) => right.startedAt - left.startedAt)
  }

  async append(record: BackupRunRecord): Promise<void> {
    this.records.push(record)
  }
}

/** A remote store that records calls and can fail on demand. */
class FakeTransport {
  readonly endpoint = 'D:\remote'
  readonly uploads: { readonly path: string; readonly key: string }[] = []
  readonly removals: string[] = []
  listed: readonly string[] = []
  failUpload: Error | undefined
  failRemove: Error | undefined
  onUpload: (() => Promise<void>) | undefined
  testMessage = 'Connection works.'

  async test(): Promise<string> {
    return this.testMessage
  }

  async upload(path: string, key: string): Promise<void> {
    await this.onUpload?.()
    if (this.failUpload !== undefined) throw this.failUpload
    this.uploads.push({ path, key })
  }

  async list(): Promise<readonly string[]> {
    return this.listed
  }

  async remove(key: string): Promise<void> {
    if (this.failRemove !== undefined) throw this.failRemove
    this.removals.push(key)
  }
}

/**
 * Build one runner over a fake transport.
 * @param overrides - configuration and transport overrides.
 * @returns the runner, its transport, and its history.
 */
function harness(overrides: {
  section?: Record<string, unknown>
  history?: MemoryHistory
  home?: string
  staging?: string
} = {}): { runner: BackupRunner; transport: FakeTransport; history: MemoryHistory; staging: string } {
  const transport = new FakeTransport()
  const history = overrides.history ?? new MemoryHistory()
  const staging = overrides.staging ?? ''
  const readSecret = async (id: BackupSecretId): Promise<string | undefined> => (id === 'smb-password' ? 'pw' : undefined)
  return {
    runner: new BackupRunner({
      home: overrides.home ?? '',
      stagingDir: staging,
      version: '0.0.0-test',
      platform: 'test',
      config: Config({ targetType: 'smb', smbPath: 'D:\\remote', ...overrides.section }),
      readSecret,
      history,
      transport: () => transport,
      now: () => new Date('2026-10-30T12:34:56.000Z'),
    }),
    transport,
    history,
    staging,
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('archive naming', () => {
  it('stamps UTC to the second', () => {
    const instant = new Date('2026-10-30T12:34:56.000Z')
    expect(archiveStamp(instant)).toBe('20261030-123456')
    expect(archiveName(instant)).toBe('prism-backup-20261030-123456.zip')
  })
})

describe('BackupRunner', () => {
  it('archives, uploads under the remote directory, records the run, and cleans staging', async () => {
    const home = await tempHome()
    const staging = join(home, 'cache', 'backups')
    const { runner, transport, history } = harness({ home, staging })
    const record = await runner.run()
    expect(record.status).toBe('success')
    expect(record.counts).toEqual({ settings: 0, memoryFiles: 1, projects: 0, projectFiles: 0 })
    expect(record.archiveName).toBe('prism-backup-20261030-123456.zip')
    expect(record.sizeBytes).toBeGreaterThan(0)
    expect(transport.uploads).toHaveLength(1)
    expect(transport.uploads.at(0)?.key).toBe('prism-backup/prism-backup-20261030-123456.zip')
    expect(history.records).toHaveLength(1)
    await expect(readdir(staging)).resolves.toEqual([])
    expect(runner.state().running).toBe(false)
    expect(runner.state().history).toEqual(history.list())
  })

  it('deletes the oldest archives beyond the retention, never the new one', async () => {
    const home = await tempHome()
    const { runner, transport } = harness({
      home,
      staging: join(home, 'cache'),
      section: { maxBackups: 3 },
    })
    transport.listed = [
      'prism-backup-20260101-000000.zip',
      'prism-backup-20260102-000000.zip',
      'prism-backup-20260103-000000.zip',
      'prism-backup-20260104-000000.zip',
      'prism-backup-20261030-123456.zip',
      'notes.txt',
    ]
    await runner.run()
    // Four old archives exist plus the new one; three survive, so two oldest go.
    expect(transport.removals).toEqual([
      'prism-backup/prism-backup-20260101-000000.zip',
      'prism-backup/prism-backup-20260102-000000.zip',
    ])
  })

  it('keeps every archive when retention is zero', async () => {
    const home = await tempHome()
    const { runner, transport } = harness({ home, staging: join(home, 'cache'), section: { maxBackups: 0 } })
    transport.listed = ['prism-backup-20200101-000000.zip', 'prism-backup-20200102-000000.zip']
    await runner.run()
    expect(transport.removals).toEqual([])
  })

  it('records a failed run with the upload failure and still cleans staging', async () => {
    const home = await tempHome()
    const staging = join(home, 'cache')
    const { runner, transport, history } = harness({ home, staging })
    transport.failUpload = new Error('server said no')
    const record = await runner.run()
    expect(record).toMatchObject({
      status: 'failed',
      archiveName: 'prism-backup-20261030-123456.zip',
      failure: { code: 'prism-backup/upload-failed' },
    })
    expect(record.failure?.message).toMatch(/server said no/u)
    expect(history.records).toHaveLength(1)
    await expect(readdir(staging)).resolves.toEqual([])
  })

  it('refuses a second run while one is in flight and reports its phase', async () => {
    const home = await tempHome()
    const { runner, transport } = harness({ home, staging: join(home, 'cache') })
    let release: () => void = () => {}
    transport.onUpload = async () => {
      await new Promise<void>((resolve) => { release = resolve })
    }
    const first = runner.run()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(runner.state().running).toBe(true)
    expect(runner.state().phase?.phase).toBe('upload')
    await expect(runner.run()).rejects.toMatchObject({ code: 'prism-backup/busy' })
    release()
    await expect(first).resolves.toMatchObject({ status: 'success' })
    expect(runner.state().phase).toBeUndefined()
  })

  it('records a failed run when an old archive cannot be deleted', async () => {
    const home = await tempHome()
    const { runner, transport } = harness({ home, staging: join(home, 'cache'), section: { maxBackups: 1 } })
    transport.listed = ['prism-backup-20200101-000000.zip']
    transport.failRemove = new Error('locked')
    const record = await runner.run()
    expect(record.status).toBe('failed')
    expect(record.failure?.code).toBe('prism-backup/upload-failed')
    expect(record.failure?.message).toMatch(/Deleting old archive/u)
  })

  it('leaves the remote directory flat when it is empty', async () => {
    const home = await tempHome()
    const { runner, transport } = harness({ home, staging: join(home, 'cache'), section: { remoteDir: '', maxBackups: 1 } })
    transport.listed = ['prism-backup-20200101-000000.zip']
    await runner.run()
    expect(transport.uploads.at(0)?.key).toBe('prism-backup-20261030-123456.zip')
    expect(transport.removals).toEqual(['prism-backup-20200101-000000.zip'])
  })

  it('fails before starting work when the target is half configured', async () => {
    const home = await tempHome()
    const { runner, transport } = harness({ home, staging: join(home, 'cache'), section: { smbPath: '' } })
    await expect(runner.run()).rejects.toMatchObject({ code: 'prism-backup/not-configured' })
    await expect(runner.test()).rejects.toMatchObject({ code: 'prism-backup/not-configured' })
    expect(transport.uploads).toEqual([])
    expect(transport.removals).toEqual([])
  })

  it('answers the connection test with the transport sentence', async () => {
    const home = await tempHome()
    const { runner, transport } = harness({ home, staging: join(home, 'cache') })
    transport.testMessage = 'All good.'
    await expect(runner.test()).resolves.toBe('All good.')
  })
})
