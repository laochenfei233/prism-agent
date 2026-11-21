/** Destination rules and the copy walk behind one relocation. */

import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DataError } from '../src/errors.ts'
import { copyHome, discardPartialCopy, prepareTarget, resolveTarget } from '../src/relocate.ts'

const roots: string[] = []

/**
 * A throwaway directory tree.
 * @param prefix - name prefix that names the test.
 * @returns the created absolute root.
 */
async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `prism-data-${prefix}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('resolveTarget', () => {
  const home = join(tmpdir(), 'prism-home', 'data')

  it('accepts an absolute destination beside the home', () => {
    expect(resolveTarget(home, join(tmpdir(), 'prism-home', 'moved'))).toBe(join(tmpdir(), 'prism-home', 'moved'))
  })

  it.each([
    ['a relative path', 'relative/data'],
    ['the home itself', home],
    ['a path inside the home', join(home, 'sessions')],
    ['a path containing the home', join(tmpdir(), 'prism-home')],
  ])('refuses %s', (_label, requested) => {
    expect(() => resolveTarget(home, requested)).toThrow(DataError)
    expect(() => resolveTarget(home, requested)).toThrow(/destination/i)
  })
})

describe('prepareTarget', () => {
  it('accepts a missing destination and an empty directory', async () => {
    const root = await scratch('prepare')
    await expect(prepareTarget(join(root, 'absent'))).resolves.toBeUndefined()
    const empty = join(root, 'empty')
    await mkdir(empty)
    await expect(prepareTarget(empty)).resolves.toBeUndefined()
  })

  it('refuses a destination that already holds something', async () => {
    const root = await scratch('prepare-busy')
    const occupied = join(root, 'occupied')
    await mkdir(occupied)
    await writeFile(join(occupied, 'file.txt'), 'x')
    await expect(prepareTarget(occupied)).rejects.toMatchObject({ code: 'prism-data/target-not-empty' })
  })

  it('refuses a destination that is a file', async () => {
    const root = await scratch('prepare-file')
    const file = join(root, 'file.txt')
    await writeFile(file, 'x')
    await expect(prepareTarget(file)).rejects.toMatchObject({ code: 'prism-data/target-not-empty' })
  })
})

describe('copyHome', () => {
  it('copies files, recreates links, and skips the rebuildable cache', async () => {
    const root = await scratch('copy')
    const source = join(root, 'home')
    const target = join(root, 'moved')
    await mkdir(join(source, 'sessions'), { recursive: true })
    await mkdir(join(source, 'cache', 'spool'), { recursive: true })
    await writeFile(join(source, '.credentials.yaml'), 'key: value\n')
    await writeFile(join(source, 'sessions', 'one.jsonl'), '{"seq":1}\n')
    await writeFile(join(source, 'cache', 'spool', 'old.zip'), 'skip me')
    const linkTarget = join(root, 'plugin')
    await mkdir(linkTarget)
    await symlink(linkTarget, join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    const report = await copyHome(source, target)

    expect(report.files).toBe(2)
    expect(report.bytes).toBe('key: value\n'.length + '{"seq":1}\n'.length)
    expect(report.skippedLinks).toEqual([])
    await expect(readFile(join(target, '.credentials.yaml'), 'utf8')).resolves.toBe('key: value\n')
    await expect(readFile(join(target, 'sessions', 'one.jsonl'), 'utf8')).resolves.toBe('{"seq":1}\n')
    await expect(stat(join(target, 'cache'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(target, 'linked'))).resolves.toBeDefined()
    await expect(readlink(join(target, 'linked'))).resolves.toMatch(/plugin$/)
  })

  it('reports a dangling link instead of failing the copy', async () => {
    const root = await scratch('copy-dangling')
    const source = join(root, 'home')
    const target = join(root, 'moved')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'kept.txt'), 'kept')
    const missing = join(root, 'gone')
    await symlink(missing, join(source, 'broken'), process.platform === 'win32' ? 'junction' : 'dir')

    const report = await copyHome(source, target)

    expect(report.files).toBe(1)
    expect(report.skippedLinks).toEqual([join(source, 'broken')])
    await expect(readFile(join(target, 'kept.txt'), 'utf8')).resolves.toBe('kept')
  })

  it('leaves a partial destination removable after a failure', async () => {
    const root = await scratch('copy-partial')
    const partial = join(root, 'partial')
    await mkdir(partial)
    await writeFile(join(partial, 'half.txt'), 'x')
    await discardPartialCopy(partial)
    await expect(stat(partial)).rejects.toMatchObject({ code: 'ENOENT' })
    // Removing an absent destination is not an error either.
    await expect(discardPartialCopy(partial)).resolves.toBeUndefined()
  })
})
