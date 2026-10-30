/** Collection: which files enter the archive, which sources are absent, and what is skipped. */

import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ARCHIVE_ROOT, planBackup, projectPathsOf } from '../src/collect.ts'
import type { BackupContent } from '../src/config.ts'

const roots: string[] = []

/**
 * Build one throwaway Harness home and project root.
 * @returns the temp directory.
 */
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prism-backup-collect-'))
  roots.push(root)
  return root
}

/**
 * Write one file, creating its directory.
 * @param path - absolute destination.
 * @param text - file contents.
 */
async function put(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

/** The default content selection, with the harness home's real layout. */
function content(overrides: Partial<BackupContent> = {}): BackupContent {
  return {
    settings: true,
    memory: true,
    projects: true,
    excludes: new Set(['.git', 'node_modules']),
    maxBackups: 10,
    remoteDir: 'prism-backup',
    ...overrides,
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('projectPathsOf', () => {
  it('reads registry paths in document order', () => {
    const warnings: string[] = []
    const paths = projectPathsOf(JSON.stringify({
      tables: { workspaces: { a: { path: '/work/one' }, b: { path: '/work/two' }, c: {} } },
    }), warnings)
    expect(paths).toEqual(['/work/one', '/work/two'])
    expect(warnings).toEqual([])
  })

  it('reports a malformed registry instead of failing the backup', () => {
    const warnings: string[] = []
    expect(projectPathsOf('{not json', warnings)).toEqual([])
    expect(warnings[0]).toMatch(/workspace registry unreadable/u)
  })

  it('treats a registry without workspace tables as empty', () => {
    expect(projectPathsOf('42', [])).toEqual([])
    expect(projectPathsOf('{"tables":null}', [])).toEqual([])
    expect(projectPathsOf('{"tables":{"workspaces":7}}', [])).toEqual([])
  })
})

describe('planBackup', () => {
  it('collects configuration, memory, the registry, and project files', async () => {
    const home = await tempRoot()
    const project = join(home, 'projects', 'alpha')
    await put(join(home, 'cordis.patch.yml'), 'home: true\n')
    await put(join(home, '.env'), 'KEY=1\n')
    await put(join(home, 'storages', 'prism_memory', 'records', 'mem_1.json'), '{}')
    await put(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { w: { path: project } } } }))
    await put(join(project, 'src', 'main.ts'), 'export {}\n')
    await put(join(project, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
    await put(join(project, '.git', 'config'), 'x')

    const plan = await planBackup({ home, content: content() })
    const paths = plan.members.map(member => member.archivePath).sort()
    expect(paths).toEqual([
      `${ARCHIVE_ROOT}/memory/prism_memory/records/mem_1.json`,
      `${ARCHIVE_ROOT}/projects/0-alpha/src/main.ts`,
      `${ARCHIVE_ROOT}/settings/env`,
      `${ARCHIVE_ROOT}/settings/home-cordis.patch.yml`,
      `${ARCHIVE_ROOT}/workspace/registry.json`,
    ])
    expect(plan.counts).toEqual({ settings: 2, memoryFiles: 1, projects: 1, projectFiles: 1 })
    expect(plan.absent).toEqual([join(home, '.credentials.yaml')])
  })

  it('includes the profile patch under its own member name', async () => {
    const home = await tempRoot()
    const profilePatch = join(home, 'profiles', 'web', 'cordis.patch.yml')
    await put(profilePatch, 'row: 1\n')
    const plan = await planBackup({ home, profilePatch, content: content({ memory: false, projects: false }) })
    expect(plan.members.map(member => member.archivePath)).toContain(`${ARCHIVE_ROOT}/settings/profile-cordis.patch.yml`)
  })

  it('records absent sources when a switch asks for something this machine lacks', async () => {
    const home = await tempRoot()
    const plan = await planBackup({ home, content: content() })
    expect(plan.counts).toEqual({ settings: 0, memoryFiles: 0, projects: 0, projectFiles: 0 })
    expect(plan.absent).toEqual(expect.arrayContaining([
      join(home, 'cordis.patch.yml'),
      join(home, 'storages', 'prism_memory'),
      join(home, 'storages', 'workspace.json'),
    ]))
  })

  it('skips links inside a registered project and warns about them', async () => {
    const home = await tempRoot()
    const project = join(home, 'p')
    const target = join(home, 'outside')
    await put(join(project, 'real.txt'), 'x')
    await put(join(target, 'secret.txt'), 'y')
    await put(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { w: { path: project } } } }))
    // A junction needs no elevation on Windows; POSIX symlinks cover the other platforms.
    await symlink(target, join(project, 'link'), 'junction').catch(() => symlink(target, join(project, 'link')))
    const plan = await planBackup({
      home,
      content: content({ settings: false, memory: false, projects: true, excludes: new Set() }),
    })
    const names = plan.members.map(member => member.archivePath)
    expect(names.sort()).toEqual([
      `${ARCHIVE_ROOT}/projects/0-p/real.txt`,
      `${ARCHIVE_ROOT}/workspace/registry.json`,
    ])
    expect(plan.warnings.some(warning => warning.startsWith('skipped link'))).toBe(true)
  })

  it('sorts members by archive path when one folder holds several files', async () => {
    const home = await tempRoot()
    const project = join(home, 'many')
    await put(join(project, 'b.txt'), 'b')
    await put(join(project, 'a.txt'), 'a')
    await put(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { w: { path: project } } } }))
    const plan = await planBackup({ home, content: content({ settings: false, memory: false }) })
    const projectMembers = plan.members.filter(member => member.archivePath.includes('/projects/'))
    expect(projectMembers.map(member => member.archivePath)).toEqual([
      `${ARCHIVE_ROOT}/projects/0-many/a.txt`,
      `${ARCHIVE_ROOT}/projects/0-many/b.txt`,
    ])
  })

  it('warns about a malformed registry document and archives it anyway', async () => {
    const home = await tempRoot()
    await put(join(home, 'storages', 'workspace.json'), '{not json')
    const plan = await planBackup({ home, content: content({ settings: false, memory: false }) })
    expect(plan.warnings.some(warning => warning.startsWith('workspace registry unreadable'))).toBe(true)
    expect(plan.members.map(member => member.archivePath)).toEqual([`${ARCHIVE_ROOT}/workspace/registry.json`])
  })

  it('ignores registry entries that are not objects or repeat a folder', async () => {
    const home = await tempRoot()
    const project = join(home, 'dup')
    await put(join(project, 'one.txt'), '1')
    await put(join(home, 'storages', 'workspace.json'), JSON.stringify({
      tables: { workspaces: { a: { path: project }, b: { path: project }, c: 7, d: {} } },
    }))
    const plan = await planBackup({ home, content: content({ settings: false, memory: false }) })
    expect(plan.counts.projects).toBe(1)
    expect(plan.members.filter(member => member.archivePath.includes('/projects/'))).toHaveLength(1)
  })

  it('refuses a configured settings source that is not a regular file', async () => {
    const home = await tempRoot()
    await mkdir(join(home, '.env'))
    await expect(planBackup({ home, content: content({ memory: false, projects: false }) }))
      .rejects.toThrow(/\.env is not a regular file/u)
  })

  it('warns about a registered folder that no longer exists', async () => {
    const home = await tempRoot()
    const missing = join(home, 'gone')
    await put(join(home, 'storages', 'workspace.json'), JSON.stringify({ tables: { workspaces: { w: { path: missing } } } }))
    const plan = await planBackup({ home, content: content({ settings: false, memory: false }) })
    expect(plan.warnings).toContain(`project folder missing: ${missing}`)
    expect(plan.counts.projects).toBe(0)
  })
})
