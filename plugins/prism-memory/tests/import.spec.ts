/**
 * Reading another tool's memory files.
 *
 * Two properties matter more than coverage here. A file written for a different
 * tool must not be able to make the importer fail or read without bound, so a
 * missing root, an unreadable directory, and an oversized file are ordinary
 * outcomes. And what comes out must be claims rather than an index: fenced code,
 * tables, link lists, and heading introducers are structure, not knowledge.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectMemoryFiles, IMPORT_SOURCE_IDS, parseMemoryClaims } from '../src/import.ts'

const trees: string[] = []
afterEach(async () => {
  await Promise.all(trees.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** An empty temporary directory this spec owns. */
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prism-memory-import-'))
  trees.push(root)
  return root
}

describe('parsing a foreign memory file', () => {
  it('reads bullet lines and paragraphs as claims', () => {
    const claims = parseMemoryClaims(
      ['- The release script refuses to run from a dirty tree.', 'The index is rebuilt on the first search.'].join('\n'),
      { defaultLayer: 'project' },
    )
    expect(claims.map(claim => claim.text)).toEqual([
      'The release script refuses to run from a dirty tree',
      'The index is rebuilt on the first search',
    ])
  })

  it('takes the layer from the heading that governs the section', () => {
    const claims = parseMemoryClaims(
      [
        '# User preferences',
        '- Prefers short answers without preamble.',
        '## Rules',
        '- Never push directly to the shared branch.',
        '## Pitfalls',
        '- The build cache survives a rebuild and hides the change.',
      ].join('\n'),
      { defaultLayer: 'project' },
    )
    expect(claims.map(claim => claim.layer)).toEqual(['user', 'rule', 'lesson'])
  })

  it('falls back to the source layer when a heading names none', () => {
    const claims = parseMemoryClaims('# Overview\n- The workspace keeps every plugin outside it.', { defaultLayer: 'project' })
    expect(claims[0]?.layer).toBe('project')
    expect(parseMemoryClaims('# Overview\n- The workspace keeps every plugin outside it.', { defaultLayer: 'user' })[0]?.layer)
      .toBe('user')
  })

  it('skips structure that is not a claim', () => {
    const claims = parseMemoryClaims(
      [
        '```sh',
        'never run the release script from a dirty tree',
        '```',
        '| column | value |',
        '- [a link](https://example.com)',
        'Overview:',
        '',
        'What must never happen here?',
        'short',
      ].join('\n'),
      { defaultLayer: 'fact' },
    )
    expect(claims).toEqual([])
  })

  it('bounds the claims one file contributes', () => {
    const content = Array.from({ length: 40 }, (_, index) => `- A durable statement numbered ${index}.`).join('\n')
    expect(parseMemoryClaims(content, { defaultLayer: 'fact', maxClaims: 5 })).toHaveLength(5)
    expect(parseMemoryClaims(content, { defaultLayer: 'fact' })).toHaveLength(20)
  })
})

describe('discovering files', () => {
  it('walks the named layout and reads the extensions it understands', async () => {
    const home = await scratch()
    await mkdir(join(home, '.claude', 'memory'), { recursive: true })
    await writeFile(join(home, '.claude', 'memory', 'notes.md'), '- The corpus is held in memory.')
    await writeFile(join(home, '.claude', 'memory', 'raw.jsonl'), '{"ignored":true}')
    await writeFile(join(home, '.claude', 'CLAUDE.md'), '# Rules\n- Never commit credentials.')

    const files = await collectMemoryFiles(['claude-code'], { home, cwd: null })
    expect(files.map(file => file.path.split(/[\\/]/).pop()).sort()).toEqual(['CLAUDE.md', 'notes.md'])
    expect(files.every(file => file.defaultLayer === 'user')).toBe(true)
  })

  it('does not descend into dependency or version-control directories', async () => {
    const home = await scratch()
    await mkdir(join(home, '.claude', 'memory', 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(home, '.claude', 'memory', 'node_modules', 'pkg', 'README.md'), '- A vendored claim.')
    expect(await collectMemoryFiles(['claude-code'], { home, cwd: null })).toEqual([])
  })

  it('skips a layout this user does not have', async () => {
    const home = await scratch()
    expect(await collectMemoryFiles(['claude-code'], { home, cwd: null })).toEqual([])
  })

  it('reads the calling workspace only when it has one', async () => {
    const cwd = await scratch()
    await writeFile(join(cwd, 'AGENTS.md'), '# Rules\n- Never commit credentials.')
    expect(await collectMemoryFiles(['workspace'], { home: cwd, cwd: null })).toEqual([])
    const files = await collectMemoryFiles(['workspace'], { home: cwd, cwd })
    expect(files).toHaveLength(1)
    expect(files[0]?.defaultLayer).toBe('project')
  })

  it('bounds how many files one import reads', async () => {
    const home = await scratch()
    await mkdir(join(home, '.claude', 'memory'), { recursive: true })
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(home, '.claude', 'memory', `note-${index}.md`), `- Claim number ${index}.`)
    }
    expect(await collectMemoryFiles(['claude-code'], { home, cwd: null }, { maxFiles: 3 })).toHaveLength(3)
  })

  it('refuses a layout it does not know rather than reading nothing', async () => {
    const home = await scratch()
    await expect(collectMemoryFiles(['not-a-layout'], { home, cwd: null })).rejects.toThrow(/unknown memory import source/)
    expect(IMPORT_SOURCE_IDS).toContain('claude-code')
    expect(IMPORT_SOURCE_IDS).toContain('workspace')
  })
})
