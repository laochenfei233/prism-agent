/** Archive production: members, manifest, size, and the streamed-file path. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { MANIFEST_PATH, writeArchive, type BackupManifest } from '../src/archive.ts'
import type { PlannedMember } from '../src/collect.ts'

const roots: string[] = []

/**
 * Build one throwaway directory.
 * @returns its absolute path.
 */
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prism-backup-archive-'))
  roots.push(root)
  return root
}

/** The manifest every test writes. */
function manifest(): BackupManifest {
  return {
    format: 1,
    createdAt: '2026-10-30T12:00:00.000Z',
    app: 'Prism Agent',
    version: '0.0.0-test',
    platform: 'test',
    counts: { settings: 1, memoryFiles: 0, projects: 0, projectFiles: 0 },
    bytes: { settings: 5, memory: 0, projects: 0 },
    absent: ['/home/.env'],
    warnings: ['skipped link /x'],
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('writeArchive', () => {
  it('writes every member plus the manifest and reports the file size', async () => {
    const root = await tempRoot()
    const first: PlannedMember = { path: join(root, 'a.txt'), archivePath: 'prism-backup/settings/a.txt', size: 5 }
    const second: PlannedMember = { path: join(root, 'b.json'), archivePath: 'prism-backup/memory/b.json', size: 2 }
    const members = [first, second]
    await writeFile(first.path, 'hello', 'utf8')
    await writeFile(second.path, '{}', 'utf8')
    const destination = join(root, 'out.zip')
    const result = await writeArchive(members, manifest(), destination)
    expect(result.entries).toBe(3)
    expect(result.sizeBytes).toBeGreaterThan(0)

    const archive = unzipSync(new Uint8Array(await readFile(destination)))
    expect(Object.keys(archive).sort()).toEqual([
      MANIFEST_PATH,
      'prism-backup/memory/b.json',
      'prism-backup/settings/a.txt',
    ])
    expect(new TextDecoder().decode(archive['prism-backup/settings/a.txt'])).toBe('hello')
    const written = JSON.parse(new TextDecoder().decode(archive[MANIFEST_PATH])) as BackupManifest
    expect(written).toEqual(manifest())
  })

  it('writes an empty member as a zero-length entry', async () => {
    const root = await tempRoot()
    const empty = join(root, 'empty.txt')
    await writeFile(empty, '', 'utf8')
    const destination = join(root, 'out.zip')
    await writeArchive([{ path: empty, archivePath: 'prism-backup/settings/empty.txt', size: 0 }], manifest(), destination)
    const archive = unzipSync(new Uint8Array(await readFile(destination)))
    expect(archive['prism-backup/settings/empty.txt']).toHaveLength(0)
  })

  it('honors write backpressure while streaming a large member', async () => {
    const root = await tempRoot()
    const big = join(root, 'big.bin')
    await writeFile(big, randomBytes(4 * 1024 * 1024))
    const destination = join(root, 'out.zip')
    const result = await writeArchive(
      [{ path: big, archivePath: 'prism-backup/projects/0/big.bin', size: 4 * 1024 * 1024 }],
      manifest(),
      destination,
    )
    expect(result.sizeBytes).toBeGreaterThan(4 * 1024 * 1024)
    const archive = unzipSync(new Uint8Array(await readFile(destination)))
    expect(archive['prism-backup/projects/0/big.bin']).toHaveLength(4 * 1024 * 1024)
  })

  it('fails loud when a member cannot be read', async () => {
    const root = await tempRoot()
    const destination = join(root, 'out.zip')
    await expect(writeArchive(
      [{ path: join(root, 'missing.txt'), archivePath: 'prism-backup/settings/missing.txt', size: 0 }],
      manifest(),
      destination,
    )).rejects.toThrow(/ENOENT/u)
  })
})
