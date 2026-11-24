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
import { MALFORMED_PAGES, writeWikiFile } from './fixtures/vault-fixtures.ts'
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

describe('layout adoption edges', () => {
  it('refuses a root that is a file', async () => {
    const filePath = join(root, 'not-a-vault')
    await writeFile(filePath, 'plain file\n', 'utf8')

    await expect(new VaultFiles(filePath).ensureLayout()).rejects.toMatchObject({ code: 'WIKI_ROOT_NOT_VAULT' })
  })

  it('refuses to read a schema the vault does not hold', async () => {
    await files.ensureLayout()
    await rm(join(root, 'AGENTS.md'), { force: true })

    await expect(files.readSchema()).rejects.toMatchObject({ code: 'WIKI_ROOT_NOT_VAULT' })
  })
})

describe('page text edges', () => {
  it('rejects a frontmatter block that is never closed', () => {
    const text = '---\ntitle: Open\ntype: concept\ntags: [x]\nupdated: 2026-10-07\nstatus: current\n\nBody without a close.\n'

    expect(() => parsePageText(text, page('concepts/open.md'))).toThrow(/closed/u)
  })

  it.each(MALFORMED_PAGES)('rejects a page with $name', ({ text, field }) => {
    expect(() => parsePageText(text, page('concepts/malformed.md'))).toThrow(new RegExp(field, 'u'))
  })

  it('skips link targets that carry no name', () => {
    expect(extractWikiLinks('See [[#anchor]], [[|display]], and [[ ]].')).toEqual([])
  })

  it('serializes an empty body with no gap below the block', () => {
    const text = serializePageText(frontmatter(), '')

    expect(text.endsWith('---\n')).toBe(true)
    expect(parsePageText(text, page('concepts/empty.md')).body).toBe('')
  })

  it('quotes scalars the parser would otherwise misread', () => {
    const text = serializePageText(frontmatter({ title: 'Alpha: "the" first' }), 'Body.')

    expect(parsePageText(text, page('concepts/quoted.md')).frontmatter.title).toBe('Alpha: "the" first')
  })
})

describe('page path and source path guards', () => {
  beforeEach(async () => {
    await files.ensureLayout()
  })

  it('refuses page paths that leave the vault or lack the suffix', async () => {
    for (const bad of ['../outside.md', 'C:/evil.md', 'concepts/./x.md', 'concepts/../evil.md', 'concepts/x.txt', '']) {
      await expect(files.readPage(page(bad))).rejects.toMatchObject({ code: 'WIKI_PAGE_NOT_FOUND' })
      expect(await files.hasPage(page(bad))).toBe(false)
    }
  })

  it('refuses a draft whose path is not a vault page path', async () => {
    await expect(files.writePage({ path: page('concepts/../evil.md'), frontmatter: frontmatter(), body: 'Body.' }, 'write'))
      .rejects.toMatchObject({ code: 'WIKI_FRONTMATTER_INVALID' })
    await expect(files.writePage({ path: page(''), frontmatter: frontmatter(), body: 'Body.' }, 'write'))
      .rejects.toMatchObject({ code: 'WIKI_FRONTMATTER_INVALID' })
  })

  it('refuses unusable raw source paths', async () => {
    for (const bad of ['', 'assets/picture.png', '../evil.md', '/abs.md', 'C:/evil.md', '..\\evil.md']) {
      await expect(files.addSource(source(bad), 'text')).rejects.toMatchObject({ code: 'WIKI_SOURCE_NOT_FOUND' })
      await expect(files.readSource(source(bad), 10)).rejects.toMatchObject({ code: 'WIKI_SOURCE_NOT_FOUND' })
    }
  })

  it('reads a source slice that ends between surrogate pairs', async () => {
    await files.addSource(source('pairs.md'), `${'x'.repeat(99)}𝌆${'y'.repeat(50)}`)

    const { text, truncated } = await files.readSource(source('pairs.md'), 100)

    expect(truncated).toBe(true)
    expect(text).toHaveLength(99)
  })

  it('lists no sources when raw/ is absent', async () => {
    await rm(join(root, 'raw'), { recursive: true, force: true })

    expect(await files.listSources()).toEqual([])
  })
})

describe('frontmatter validation on write', () => {
  beforeEach(async () => {
    await files.ensureLayout()
  })

  it.each([
    ['an empty title', { title: '   ' }],
    ['an unknown type', { type: 'nonsense' }],
    ['an unknown status', { status: 'maybe' }],
    ['a non-ISO date', { updated: 'October 7' }],
    ['a confidence below zero', { confidence: -0.5 }],
    ['a confidence above one', { confidence: 1.5 }],
    ['a non-finite confidence', { confidence: Number.NaN }],
  ])('refuses a draft with %s', async (_name, overrides: Partial<WikiFrontmatter>) => {
    await expect(files.writePage({
      path: page('concepts/bad.md'), frontmatter: frontmatter(overrides), body: 'Body.',
    }, 'write')).rejects.toMatchObject({ code: 'WIKI_FRONTMATTER_INVALID' })
  })

  it('refuses a write over a page path held by a directory and leaves no temporary', async () => {
    await mkdir(join(root, 'wiki', 'concepts', 'solid.md'))

    await expect(files.writePage({
      path: page('concepts/solid.md'), frontmatter: frontmatter(), body: 'Body.',
    }, 'write')).rejects.toThrow()

    const names = await readdir(join(root, 'wiki', 'concepts'))
    expect(names.filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('reports a read of a directory held under a page path', async () => {
    await mkdir(join(root, 'wiki', 'concepts', 'solid.md'))

    await expect(files.readPage(page('concepts/solid.md'))).rejects.toMatchObject({ code: 'EISDIR' })
  })
})

describe('the vault walk', () => {
  beforeEach(async () => {
    await files.ensureLayout()
  })

  it('skips dotfiles and files without the page suffix', async () => {
    await writeWikiFile(root, 'concepts/.secret.md', '---\ntitle: S\ntype: concept\ntags: []\nupdated: 2026-10-07\nstatus: current\n---\n\nS.\n')
    await writeWikiFile(root, 'concepts/notes.txt', 'not a page\n')

    const paths = (await files.listPageEntries()).map(entry => entry.page.path)

    expect(paths).not.toContain('concepts/.secret.md')
    expect(paths).not.toContain('concepts/notes.txt')
  })

  it('refuses to enumerate a vault whose wiki directory is gone', async () => {
    await rm(join(root, 'wiki'), { recursive: true, force: true })

    await expect(files.listPageEntries()).rejects.toMatchObject({ code: 'WIKI_ROOT_NOT_VAULT' })
  })

  it('names an unparsable page in the catalog under Needs attention', async () => {
    await writeWikiFile(root, 'concepts/broken.md', 'not a page at all\n')

    await files.rebuildIndex()

    const index = await readFile(join(root, 'index.md'), 'utf8')
    expect(index).toContain('Needs attention')
    expect(index).toContain('concepts/broken.md')
  })

  it('quotes no summary for a body that opens with nothing quotable', async () => {
    await files.writePage({
      path: page('concepts/heading.md'),
      frontmatter: frontmatter({ title: 'Headed' }),
      body: ' \n\n# Only a heading\n',
    }, 'write')

    const index = await readFile(join(root, 'index.md'), 'utf8')

    expect(index).toContain('Headed')
    expect(index).not.toContain('Only a heading')
  })

  it('clips a long summary at a word boundary', async () => {
    await files.writePage({
      path: page('concepts/wordy.md'), frontmatter: frontmatter({ title: 'Wordy' }), body: 'word '.repeat(60),
    }, 'write')

    expect(await readFile(join(root, 'index.md'), 'utf8')).toMatch(/word word[^\n]*\.\.\./u)
  })

  it('clips a summary that is one unbroken word', async () => {
    await files.writePage({
      path: page('concepts/unbroken.md'), frontmatter: frontmatter({ title: 'Unbroken' }), body: 'x'.repeat(300),
    }, 'write')

    expect(await readFile(join(root, 'index.md'), 'utf8')).toContain(`${'x'.repeat(157)}...`)
  })
})

describe('the derived log', () => {
  beforeEach(async () => {
    await files.ensureLayout()
  })

  it('seeds the log heading when appending to an emptied log', async () => {
    await writeFile(join(root, 'log.md'), '   \n', 'utf8')

    await files.appendLog('note', 'first entry')

    expect(await readFile(join(root, 'log.md'), 'utf8')).toMatch(/^# Log\n\n## \[/u)
  })

  it('returns no headings for a non-positive limit or an absent log', async () => {
    await files.writePage({ path: page('concepts/one.md'), frontmatter: frontmatter(), body: 'One.\n' }, 'write')
    expect(await files.logTail(0)).toEqual([])

    await rm(join(root, 'log.md'), { force: true })
    expect(await files.logTail(3)).toEqual([])
  })
})

describe('lint report edges', () => {
  it('ignores a link a page writes to itself', () => {
    const report = lintVault([parsed('concepts/alpha.md', 'See [[Alpha]].')], [])

    expect(report.findings.filter(finding => finding.kind === 'broken-link')).toEqual([])
    expect(report.findings.some(finding => finding.kind === 'orphan-page')).toBe(true)
  })

  it('resolves links written as paths, suffixes, and aliases', () => {
    const pages = [
      parsed('concepts/alpha.md', 'Body.', { title: 'Alpha', aliases: ['Alpha One'] }),
      parsed('concepts/beta.md', 'See [[Alpha One]], [[concepts/alpha]], [[Alpha.md]], [[wiki/concepts/alpha.md]], [[./alpha]].', { title: 'Beta' }),
    ]

    const report = lintVault(pages, [])

    expect(report.findings.filter(finding => finding.kind === 'broken-link')).toEqual([])
    expect(report.findings.some(finding => finding.kind === 'orphan-page' && finding.page === 'concepts/alpha.md')).toBe(false)
    expect(report.findings.some(finding => finding.kind === 'orphan-page' && finding.page === 'concepts/beta.md')).toBe(true)
  })

  it('skips empty alias keys and repeated stems', () => {
    const pages = [
      parsed('concepts/dup.md', 'Body.', { title: 'Dup', aliases: [''] }),
      parsed('entities/dup.md', 'Body.', { title: 'Dup two' }),
    ]

    const report = lintVault(pages, [])

    expect(report.pages).toBe(2)
    expect(report.findings.filter(finding => finding.kind === 'broken-link')).toEqual([])
  })

  it('orders same-kind findings by page whichever way they were built', () => {
    const pages = [
      parsed('concepts/zulu.md', 'Body.'),
      parsed('concepts/mike.md', 'Body.'),
      parsed('concepts/alpha.md', 'Body.'),
    ]

    const report = lintVault(pages, [])

    const orphans = report.findings.filter(finding => finding.kind === 'orphan-page')
    expect(orphans.map(finding => finding.page)).toEqual(['concepts/alpha.md', 'concepts/mike.md', 'concepts/zulu.md'])
  })

  it('deduplicates repeated and empty source citations', () => {
    const pages = [parsed('concepts/a.md', 'Body.', { sources: ['raw/one.md', 'raw/one.md', ''] })]

    const report = lintVault(pages, [source(''), source('one.md')])

    expect(report.findings.filter(finding => finding.kind === 'missing-source')).toEqual([])
  })

  it('reports contradictions that resolve nowhere, target self, repeat, or lack reciprocity', () => {
    const ghost = lintVault([parsed('concepts/a.md', 'Body.', { contradicts: ['concepts/ghost.md'] })], [])
    expect(ghost.findings.some(finding => finding.detail.includes('resolves to no page'))).toBe(true)

    const self = lintVault([parsed('concepts/a.md', 'Body.', { contradicts: ['concepts/a.md'] })], [])
    expect(self.findings.filter(finding => finding.kind === 'contradiction')).toEqual([])

    const twice = lintVault([
      parsed('concepts/a.md', 'Body.', { contradicts: ['concepts/b.md', 'concepts/b.md'] }),
      parsed('concepts/b.md', 'Body.', { contradicts: ['concepts/a.md'] }),
    ], [])
    expect(twice.findings.filter(finding => finding.kind === 'contradiction')).toEqual([])

    const oneSided = lintVault([
      parsed('concepts/a.md', 'Body.', { contradicts: ['concepts/b.md'] }),
      parsed('concepts/b.md', 'Body.', { contradicts: ['concepts/ghost.md'] }),
    ], [])
    expect(oneSided.findings.some(finding => finding.detail.includes('does not name this page back'))).toBe(true)
  })

  it('matches overview pages at the root and reports misfiled ones', () => {
    const good = lintVault([parsed('overview.md', 'Body.', { type: 'overview' })], [])
    expect(good.findings.filter(finding => finding.kind === 'frontmatter')).toEqual([])

    const misfiled = lintVault([parsed('concepts/overview.md', 'Body.', { type: 'overview' })], [])
    expect(misfiled.findings.some(finding => finding.detail.includes('"wiki/"'))).toBe(true)

    const loose = lintVault([parsed('loose.md', 'Body.')], [])
    expect(loose.findings.some(finding => finding.kind === 'frontmatter')).toBe(true)
  })

  it('resolves a page whose path carries no suffix', () => {
    const pages = [parsed('concepts/bare', 'Body.'), parsed('concepts/linker.md', 'See [[bare]].')]

    const report = lintVault(pages, [])

    expect(report.findings.filter(finding => finding.kind === 'broken-link')).toEqual([])
  })
})

describe('frontmatter reader edges', () => {
  it('ignores comments and unrecognized lines, and reads block lists', () => {
    const text = [
      '---',
      '# a comment line',
      'title: Commented',
      'just some prose',
      'type: concept',
      'tags:',
      '  - one',
      'updated: 2026-10-07',
      'status: current',
      '---',
      '',
      'Body.',
      '',
    ].join('\n')

    const { frontmatter: read } = parsePageText(text, page('concepts/commented.md'))

    expect(read.title).toBe('Commented')
    expect(read.tags).toEqual(['one'])
    expect(read.confidence).toBeNull()
  })

  it('reads a bare key with no items as an empty scalar', () => {
    const text = '---\ntitle:\ntype: concept\ntags: [x]\nupdated: 2026-10-07\nstatus: current\n---\n\nBody.\n'

    expect(() => parsePageText(text, page('concepts/bare.md'))).toThrow(/"title"/u)
  })

  it('reads an unclosed bracket as a scalar and refuses it as a list', () => {
    const text = '---\ntitle: Bracket\ntype: concept\ntags: [one, two\nupdated: 2026-10-07\nstatus: current\n---\n\nBody.\n'

    expect(() => parsePageText(text, page('concepts/bracket.md'))).toThrow(/"tags"/u)
  })

  it('splits quoted list items on commas and removes one quote layer', () => {
    const text = '---\ntitle: Quoted\ntype: concept\ntags: ["a, b", \'c\', d, "e\\"f", x, , y]\nupdated: 2026-10-07\nstatus: current\n---\n\nBody.\n'

    const { frontmatter: read } = parsePageText(text, page('concepts/quoted-list.md'))

    expect(read.tags).toEqual(['a, b', 'c', 'd', 'e"f', 'x', 'y'])
  })

  it('reads a bare list key with no items as an empty list', () => {
    const text = '---\ntitle: Bare list\ntype: concept\ntags:\nupdated: 2026-10-07\nstatus: current\n---\n\nBody.\n'

    const { frontmatter: read } = parsePageText(text, page('concepts/bare-list.md'))

    expect(read.tags).toEqual([])
  })

  it('keeps a mismatched quote as written', () => {
    const text = '---\ntitle: Mixed\ntype: concept\ntags: ["a\']\nupdated: 2026-10-07\nstatus: current\n---\n\nBody.\n'

    const { frontmatter: read } = parsePageText(text, page('concepts/mixed-quote.md'))

    expect(read.tags).toEqual(['"a\''])
  })

  it('refuses a confidence written as a list', () => {
    const text = '---\ntitle: Listed\ntype: concept\ntags: [x]\nupdated: 2026-10-07\nstatus: current\nconfidence: [0.5]\n---\n\nBody.\n'

    expect(() => parsePageText(text, page('concepts/listed.md'))).toThrow(/"confidence"/u)
  })

  it('refuses a title written as a list and missing tags', () => {
    const listed = '---\ntitle: [A, B]\ntype: concept\ntags: [x]\nupdated: 2026-10-07\nstatus: current\n---\n\nBody.\n'
    expect(() => parsePageText(listed, page('concepts/title-list.md'))).toThrow(/"title"/u)

    const noTags = '---\ntitle: No tags\ntype: concept\nupdated: 2026-10-07\nstatus: current\n---\n\nBody.\n'
    expect(() => parsePageText(noTags, page('concepts/no-tags.md'))).toThrow(/"tags"/u)
  })
})
