/**
 * Behaviour of the vault filesystem core: layout creation and the adoption
 * guard, frontmatter parsing and validation, atomic page writes with the two
 * derived navigation files, revision conflicts, source reads, and the lint
 * report.
 */

import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  VaultFiles, WikiVaultError, extractWikiLinks, lintVault, parsePageText, revisionOf,
  serializePageText,
} from '../src/vault.ts'
import type { WikiFrontmatter, WikiPage, WikiPagePath, WikiSourcePath } from '../src/types.ts'

const page = (value: string): WikiPagePath => brandString<WikiPagePath>(value)
const source = (value: string): WikiSourcePath => brandString<WikiSourcePath>(value)

/** Complete frontmatter with every required field, overridable per test. */
function frontmatter(overrides: Partial<WikiFrontmatter> = {}): WikiFrontmatter {
  return {
    title: 'A page',
    type: 'concept',
    tags: ['alpha'],
    updated: '2026-10-07',
    status: 'current',
    sources: [],
    aliases: [],
    confidence: null,
    contradicts: [],
    ...overrides,
  }
}

/** Build a parsed page without touching the filesystem. */
function parsed(path: string, body: string, overrides: Partial<WikiFrontmatter> = {}): WikiPage {
  const text = serializePageText(frontmatter(overrides), body)
  return { path: page(path), frontmatter: frontmatter(overrides), body, revision: revisionOf(text) }
}

let root: string
let files: VaultFiles

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prism-wiki-vault-'))
  files = new VaultFiles(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('layout', () => {
  it('creates the documented layout on first use', async () => {
    await files.ensureLayout()

    for (const directory of ['raw', 'raw/assets', 'wiki', 'wiki/entities', 'wiki/concepts', 'wiki/sources', 'wiki/comparisons', 'wiki/syntheses']) {
      expect((await stat(join(root, directory))).isDirectory()).toBe(true)
    }
    for (const file of ['AGENTS.md', 'index.md', 'log.md']) {
      expect((await stat(join(root, file))).isFile()).toBe(true)
    }
  })

  it('refuses to adopt a non-empty directory that is not a vault', async () => {
    await writeFile(join(root, 'unrelated.txt'), 'not a vault', 'utf8')

    await expect(files.ensureLayout()).rejects.toMatchObject({ code: 'WIKI_ROOT_NOT_VAULT' })
  })

  it('adopts a directory that already is a vault', async () => {
    await files.ensureLayout()
    await expect(files.ensureLayout()).resolves.toBeUndefined()
  })

  it('never regenerates a schema the author has edited', async () => {
    await files.ensureLayout()
    await writeFile(join(root, 'AGENTS.md'), '# House rules\n\nKeep pages short.\n', 'utf8')

    await files.ensureLayout()

    expect(await files.readSchema()).toContain('Keep pages short.')
  })

  it('seeds a schema that names the vocabulary it expects', async () => {
    await files.ensureLayout()
    const schema = await files.readSchema()

    expect(schema).toContain('entity')
    expect(schema).toContain('synthesis')
    expect(schema).toContain('current')
  })
})

describe('page text', () => {
  it('round-trips frontmatter and body', () => {
    const original = frontmatter({ tags: ['a', 'b'], sources: ['raw/one.md'], aliases: ['Alt'], confidence: 0.5 })
    const text = serializePageText(original, 'Body line.\n')
    const { frontmatter: parsedBack, body } = parsePageText(text, page('concepts/round.md'))

    expect(parsedBack.tags).toEqual(['a', 'b'])
    expect(parsedBack.sources).toEqual(['raw/one.md'])
    expect(parsedBack.aliases).toEqual(['Alt'])
    expect(parsedBack.confidence).toBeCloseTo(0.5)
    expect(body.trim()).toBe('Body line.')
  })

  it('ends serialized text with exactly one newline', () => {
    expect(serializePageText(frontmatter(), 'Body')).toMatch(/[^\n]\n$/u)
  })

  it('defaults the optional fields when they are absent', () => {
    const text = '---\ntitle: Bare\ntype: concept\ntags: [x]\nupdated: 2026-10-07\nstatus: current\n---\n\nBody\n'
    const { frontmatter: parsedBack } = parsePageText(text, page('concepts/bare.md'))

    expect(parsedBack.sources).toEqual([])
    expect(parsedBack.aliases).toEqual([])
    expect(parsedBack.contradicts).toEqual([])
    expect(parsedBack.confidence).toBeNull()
  })

  it('parses block-style list values as well as inline ones', () => {
    const text = '---\ntitle: Block\ntype: concept\ntags:\n  - one\n  - two\nupdated: 2026-10-07\nstatus: current\n---\n\nBody\n'
    const { frontmatter: parsedBack } = parsePageText(text, page('concepts/block.md'))

    expect(parsedBack.tags).toEqual(['one', 'two'])
  })

  it('rejects a page whose frontmatter is absent', () => {
    expect(() => parsePageText('no frontmatter here\n', page('concepts/none.md')))
      .toThrow(WikiVaultError)
  })

  it('rejects a page missing a required field, naming it', () => {
    const text = '---\ntitle: Partial\ntype: concept\ntags: [x]\n---\n\nBody\n'

    expect(() => parsePageText(text, page('concepts/partial.md')))
      .toThrow(/updated/u)
  })

  it('rejects an unknown page type', () => {
    const text = '---\ntitle: Odd\ntype: nonsense\ntags: [x]\nupdated: 2026-10-07\nstatus: current\n---\n\nBody\n'

    expect(() => parsePageText(text, page('concepts/odd.md'))).toThrow(WikiVaultError)
  })

  it('rejects an unknown status', () => {
    const text = '---\ntitle: Odd\ntype: concept\ntags: [x]\nupdated: 2026-10-07\nstatus: maybe\n---\n\nBody\n'

    expect(() => parsePageText(text, page('concepts/odd.md'))).toThrow(WikiVaultError)
  })
})

describe('revisions', () => {
  it('is stable for identical text and different for changed text', () => {
    expect(revisionOf('same')).toBe(revisionOf('same'))
    expect(revisionOf('same')).not.toBe(revisionOf('different'))
  })
})

describe('writing pages', () => {
  beforeEach(async () => {
    await files.ensureLayout()
  })

  it('creates a page and lists it in the catalog', async () => {
    const written = await files.writePage({ path: page('concepts/alpha.md'), frontmatter: frontmatter({ title: 'Alpha' }), body: 'Alpha body.\n' }, 'write')

    expect(written.path).toBe('concepts/alpha.md')
    expect(await files.hasPage(page('concepts/alpha.md'))).toBe(true)
    expect(await readFile(join(root, 'index.md'), 'utf8')).toContain('Alpha')
  })

  it('appends one parseable log entry per write', async () => {
    await files.writePage({ path: page('concepts/alpha.md'), frontmatter: frontmatter({ title: 'Alpha' }), body: 'Alpha.\n' }, 'write')

    const log = await readFile(join(root, 'log.md'), 'utf8')
    expect(log).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] write \| /mu)
  })

  it('updates an existing page and refreshes the catalog', async () => {
    await files.writePage({ path: page('concepts/alpha.md'), frontmatter: frontmatter({ title: 'Alpha' }), body: 'First.\n' }, 'write')
    await files.writePage({ path: page('concepts/alpha.md'), frontmatter: frontmatter({ title: 'Alpha renamed' }), body: 'Second.\n' }, 'write')

    const stored = await files.readPage(page('concepts/alpha.md'))
    expect(stored.body).toContain('Second')
    expect(await readFile(join(root, 'index.md'), 'utf8')).toContain('Alpha renamed')
  })

  it('refuses a path that disagrees with the frontmatter type', async () => {
    await expect(files.writePage({
      path: page('entities/misfiled.md'),
      frontmatter: frontmatter({ type: 'concept' }),
      body: 'Body.\n',
    }, 'write')).rejects.toMatchObject({ code: 'WIKI_FRONTMATTER_INVALID' })
  })

  it('refuses a stale revision and leaves the page untouched', async () => {
    const first = await files.writePage({ path: page('concepts/alpha.md'), frontmatter: frontmatter({ title: 'Alpha' }), body: 'Original.\n' }, 'write')

    await expect(files.writePage({
      path: page('concepts/alpha.md'),
      frontmatter: frontmatter({ title: 'Alpha' }),
      body: 'Overwritten.\n',
      expectedRevision: 'not-the-current-revision',
    }, 'write')).rejects.toMatchObject({ code: 'WIKI_REVISION_CONFLICT' })

    expect((await files.readPage(page('concepts/alpha.md'))).body).toContain('Original')
    expect(first.revision).toBe(revisionOf(serializePageText(first.frontmatter, first.body)))
  })

  it('accepts a matching revision', async () => {
    const first = await files.writePage({ path: page('concepts/alpha.md'), frontmatter: frontmatter({ title: 'Alpha' }), body: 'Original.\n' }, 'write')

    const second = await files.writePage({
      path: page('concepts/alpha.md'),
      frontmatter: frontmatter({ title: 'Alpha' }),
      body: 'Replaced.\n',
      expectedRevision: first.revision,
    }, 'write')

    expect(second.body).toContain('Replaced')
  })

  it('conflicts when a revision is expected for a page that does not exist', async () => {
    const failure = await files.writePage({
      path: page('concepts/absent.md'),
      frontmatter: frontmatter(),
      body: 'Body.\n',
      expectedRevision: 'anything',
    }, 'write').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(WikiVaultError)
    if (!(failure instanceof WikiVaultError)) throw new Error('expected a vault error')
    expect(failure.code).toBe('WIKI_REVISION_CONFLICT')
    // There is no stored page to compare against, so none is fabricated.
    expect(failure.current).toBeUndefined()
  })

  it('carries the stored page when the revision moved', async () => {
    await files.writePage({
      path: page('concepts/moved.md'),
      frontmatter: frontmatter({ title: 'Moved' }),
      body: 'Stored body.\n',
    }, 'write')

    const failure = await files.writePage({
      path: page('concepts/moved.md'),
      frontmatter: frontmatter({ title: 'Moved' }),
      body: 'Replacement.\n',
      expectedRevision: 'stale',
    }, 'write').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(WikiVaultError)
    if (!(failure instanceof WikiVaultError)) throw new Error('expected a vault error')
    expect(failure.current?.body).toContain('Stored body.')
  })

  it('reports a missing page by code', async () => {
    await expect(files.readPage(page('concepts/absent.md'))).rejects.toMatchObject({ code: 'WIKI_PAGE_NOT_FOUND' })
  })

  it('lists pages from every type directory', async () => {
    await files.writePage({ path: page('concepts/one.md'), frontmatter: frontmatter(), body: 'One.\n' }, 'write')
    await files.writePage({ path: page('entities/two.md'), frontmatter: frontmatter({ type: 'entity' }), body: 'Two.\n' }, 'write')

    const paths = (await files.listPageEntries()).map(entry => entry.page.path)
    expect(paths).toContain('concepts/one.md')
    expect(paths).toContain('entities/two.md')
  })

  it('rebuilds the catalog from frontmatter', async () => {
    await files.writePage({ path: page('concepts/one.md'), frontmatter: frontmatter({ title: 'One' }), body: 'One.\n' }, 'write')
    await writeFile(join(root, 'index.md'), '# Index\n\nhand edited\n', 'utf8')

    await files.rebuildIndex()

    expect(await readFile(join(root, 'index.md'), 'utf8')).toContain('One')
  })

  it('reports the newest log headings first', async () => {
    await files.writePage({ path: page('concepts/one.md'), frontmatter: frontmatter(), body: 'One.\n' }, 'write')
    await files.writePage({ path: page('concepts/two.md'), frontmatter: frontmatter({ title: 'Two' }), body: 'Two.\n' }, 'write')

    const tail = await files.logTail(2)
    expect(tail).toHaveLength(2)
    expect(tail[0]).toMatch(/^## \[/u)
  })
})

describe('raw sources', () => {
  beforeEach(async () => {
    await files.ensureLayout()
  })

  it('registers a source and reads it back', async () => {
    await files.addSource(source('gist-llm-wiki.md'), 'Source text here.')

    const { text, truncated } = await files.readSource(source('gist-llm-wiki.md'), 1000)

    expect(text).toContain('Source text here')
    expect(truncated).toBe(false)
  })

  it('truncates a source read at the requested bound', async () => {
    await files.addSource(source('long.md'), 'x'.repeat(500))

    const { text, truncated } = await files.readSource(source('long.md'), 100)

    expect(text).toHaveLength(100)
    expect(truncated).toBe(true)
  })

  it('refuses to overwrite an existing source', async () => {
    await files.addSource(source('kept.md'), 'first')

    await expect(files.addSource(source('kept.md'), 'second')).rejects.toBeInstanceOf(WikiVaultError)
    expect((await files.readSource(source('kept.md'), 100)).text).toBe('first')
  })

  it('reports a missing source by code', async () => {
    await expect(files.readSource(source('absent.md'), 100)).rejects.toMatchObject({ code: 'WIKI_SOURCE_NOT_FOUND' })
  })

  it('lists sources without the assets directory', async () => {
    await files.addSource(source('one.md'), 'one')
    await mkdir(join(root, 'raw', 'assets'), { recursive: true })
    await writeFile(join(root, 'raw', 'assets', 'picture.png'), 'binary', 'utf8')

    expect(await files.listSources()).toEqual(['one.md'])
  })
})

describe('wikilinks', () => {
  it('extracts targets, de-duplicated and without alias or anchor suffixes', () => {
    const body = 'See [[Alpha]], [[Alpha|the first]], [[Beta#section]], and [[Alpha]].'

    expect(extractWikiLinks(body)).toEqual(['Alpha', 'Beta'])
  })

  it('returns nothing for a body without links', () => {
    expect(extractWikiLinks('plain text')).toEqual([])
  })
})

describe('the lint report', () => {
  it('reports an orphan page nothing links to', () => {
    const report = lintVault([parsed('concepts/lonely.md', 'No links here.')], [])

    expect(report.findings.some(finding => finding.kind === 'orphan-page' && finding.page === 'concepts/lonely.md')).toBe(true)
  })

  it('does not report a page another page links to', () => {
    const pages = [
      parsed('concepts/alpha.md', 'See [[Beta]].', { title: 'Alpha' }),
      parsed('concepts/beta.md', 'See [[Alpha]].', { title: 'Beta' }),
    ]

    const report = lintVault(pages, [])

    expect(report.findings.some(finding => finding.kind === 'orphan-page')).toBe(false)
  })

  it('reports a link that resolves to no page', () => {
    const report = lintVault([parsed('concepts/alpha.md', 'See [[Nowhere]].')], [])

    expect(report.findings.some(finding => finding.kind === 'broken-link' && finding.page === 'concepts/alpha.md')).toBe(true)
  })

  it('reports a repeatedly referenced name that has no page', () => {
    const pages = [
      parsed('concepts/a.md', 'See [[Ghost]].'),
      parsed('concepts/b.md', 'See [[Ghost]].'),
      parsed('concepts/c.md', 'See [[Ghost]].'),
    ]

    const report = lintVault(pages, [])

    expect(report.findings.some(finding => finding.kind === 'missing-page')).toBe(true)
  })

  it('reports a raw source no page cites', () => {
    const report = lintVault([parsed('concepts/a.md', 'Body.')], [source('unread.md')])

    expect(report.findings.some(finding => finding.kind === 'unintegrated-source')).toBe(true)
  })

  it('reports a cited source that does not exist', () => {
    const report = lintVault([parsed('concepts/a.md', 'Body.', { sources: ['raw/ghost.md'] })], [])

    expect(report.findings.some(finding => finding.kind === 'missing-source' && finding.page === 'concepts/a.md')).toBe(true)
  })

  it('reports a one-way contradiction and accepts a reciprocal one', () => {
    const oneWay = lintVault([
      parsed('concepts/a.md', 'Body.', { contradicts: ['concepts/b.md'] }),
      parsed('concepts/b.md', 'Body.'),
    ], [])
    expect(oneWay.findings.some(finding => finding.kind === 'contradiction')).toBe(true)

    const mutual = lintVault([
      parsed('concepts/a.md', 'Body.', { contradicts: ['concepts/b.md'] }),
      parsed('concepts/b.md', 'Body.', { contradicts: ['concepts/a.md'] }),
    ], [])
    expect(mutual.findings.some(finding => finding.kind === 'contradiction')).toBe(false)
  })

  it('reports a page filed in the wrong directory', () => {
    const report = lintVault([parsed('entities/misfiled.md', 'Body.', { type: 'concept' })], [])

    expect(report.findings.some(finding => finding.kind === 'frontmatter')).toBe(true)
  })

  it('counts what it examined', () => {
    const report = lintVault([parsed('concepts/a.md', 'Body.')], [source('one.md'), source('two.md')])

    expect(report.pages).toBe(1)
    expect(report.sources).toBe(2)
  })

  it('reports nothing for a healthy vault', () => {
    const pages = [
      parsed('concepts/a.md', 'See [[B]].', { title: 'A', sources: ['raw/one.md'] }),
      parsed('concepts/b.md', 'See [[A]].', { title: 'B', sources: ['raw/one.md'] }),
    ]

    const report = lintVault(pages, [source('one.md')])

    expect(report.findings).toEqual([])
  })
})

describe('concurrent writers', () => {
  beforeEach(async () => {
    await files.ensureLayout()
  })

  it('keeps every log entry when pages are written at once', async () => {
    const writes = Array.from({ length: 8 }, (_, index) => files.writePage({
      path: page(`concepts/concurrent-${index}.md`),
      frontmatter: frontmatter({ title: `Concurrent ${index}` }),
      body: `Body ${index}.\n`,
    }, 'write'))

    await expect(Promise.all(writes)).resolves.toHaveLength(8)

    const log = await readFile(join(root, 'log.md'), 'utf8')
    expect(log.split('\n').filter(line => line.startsWith('## ['))).toHaveLength(8)
  })

  it('keeps every entry when the log is appended at once', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => files.appendLog('note', `entry ${index}`)))

    const log = await readFile(join(root, 'log.md'), 'utf8')
    expect(log.split('\n').filter(line => line.startsWith('## ['))).toHaveLength(12)
  })

  it('leaves no temporary file behind after concurrent writes', async () => {
    await Promise.all(Array.from({ length: 4 }, (_, index) => files.writePage({
      path: page(`concepts/temp-${index}.md`),
      frontmatter: frontmatter(),
      body: `Body ${index}.\n`,
    }, 'write')))

    const names = await readdir(join(root, 'wiki', 'concepts'))
    expect(names.filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('still reports a stale revision when the stored page cannot be parsed', async () => {
    await writeFile(join(root, 'wiki', 'concepts', 'unparsable.md'), 'not a page at all\n', 'utf8')

    await expect(files.writePage({
      path: page('concepts/unparsable.md'),
      frontmatter: frontmatter(),
      body: 'Replacement.\n',
      expectedRevision: 'anything',
    }, 'write')).rejects.toMatchObject({ code: 'WIKI_REVISION_CONFLICT' })
  })
})

describe('a malformed page', () => {
  beforeEach(async () => {
    await files.ensureLayout()
    await files.writePage({
      path: page('concepts/healthy.md'),
      frontmatter: frontmatter({ title: 'Healthy' }),
      body: 'Healthy body.\n',
    }, 'write')
    await writeFile(
      join(root, 'wiki', 'concepts', 'broken.md'),
      '---\ntitle: Broken\ntype: concept\ntags: [x]\n---\n\nBody.\n',
      'utf8',
    )
  })

  it('does not abort the vault-wide enumeration', async () => {
    const paths = (await files.listPageEntries()).map(entry => entry.page.path)

    expect(paths).toContain('concepts/healthy.md')
    expect(paths).not.toContain('concepts/broken.md')
  })

  it('is named by listUnreadablePages', async () => {
    const unreadable = await files.listUnreadablePages()

    expect(unreadable.map(entry => entry.path)).toEqual(['concepts/broken.md'])
    expect(unreadable[0]?.message).toContain('updated')
  })

  it('is reported by the lint report', async () => {
    const report = lintVault(
      (await files.listPageEntries()).map(entry => entry.page),
      await files.listSources(),
      await files.listUnreadablePages(),
    )

    expect(report.findings.some(finding => finding.kind === 'frontmatter' && finding.page === 'concepts/broken.md')).toBe(true)
  })

  it('is still refused by readPage', async () => {
    await expect(files.readPage(page('concepts/broken.md'))).rejects.toMatchObject({ code: 'WIKI_FRONTMATTER_INVALID' })
  })
})
