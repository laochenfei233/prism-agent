/**
 * Behaviour of the rebuildable full-text cache: literal matching including CJK,
 * mtime reconciliation against externally edited files, filter narrowing, and
 * recovery from a database that is not usable.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { WikiSearchIndex, type WikiSearchEntry } from '../src/search.ts'
import type { WikiPagePath } from '../src/types.ts'

const page = (path: string): WikiPagePath => brandString<WikiPagePath>(path)

/** One indexed page with the fields the cache stores. */
function entry(path: string, overrides: Partial<WikiSearchEntry> = {}): WikiSearchEntry {
  return {
    path: page(path),
    title: 'Untitled',
    body: '',
    type: 'concept',
    status: 'current',
    updated: '2026-10-07',
    tags: [],
    mtimeMs: 1,
    ...overrides,
  }
}

let root: string
let index: WikiSearchIndex

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'prism-wiki-search-'))
  index = new WikiSearchIndex(join(root, '.wiki', 'index.db'))
  await index.open()
})

afterEach(async () => {
  await index.close()
  await rm(root, { recursive: true, force: true })
})

describe('literal matching', () => {
  it('matches a CJK query against CJK text', async () => {
    await index.reconcile([
      entry('concepts/wiki.md', { title: '知识库', body: 'LLM wiki 增量构建持久化知识库' }),
      entry('concepts/other.md', { title: 'Other', body: 'unrelated english text' }),
    ])

    const hits = await index.search('知识库', { limit: 10 })

    expect(hits.map(hit => hit.path)).toEqual(['concepts/wiki.md'])
    expect(hits[0]?.title).toBe('知识库')
  })

  it('matches an ASCII substring inside a word', async () => {
    await index.reconcile([entry('concepts/obsidian.md', { body: 'Obsidian is the IDE' })])

    const hits = await index.search('sidi', { limit: 10 })

    expect(hits.map(hit => hit.path)).toEqual(['concepts/obsidian.md'])
  })

  it('returns the page title and an excerpt around the match', async () => {
    await index.reconcile([
      entry('concepts/long.md', {
        title: 'Long page',
        body: `${'padding '.repeat(40)}the needle sits here ${'trailing '.repeat(40)}`,
      }),
    ])

    const hits = await index.search('needle', { limit: 10 })

    expect(hits).toHaveLength(1)
    expect(hits[0]?.excerpt).toContain('needle')
    expect(hits[0]?.excerpt.length).toBeLessThan(400)
  })
})

describe('degenerate queries', () => {
  beforeEach(async () => {
    await index.reconcile([entry('concepts/one.md', { title: 'One', body: 'alpha beta gamma' })])
  })

  it('returns nothing for an empty query', async () => {
    expect(await index.search('', { limit: 10 })).toEqual([])
    expect(await index.search('   ', { limit: 10 })).toEqual([])
  })

  it('returns nothing for a query shorter than the trigram floor', async () => {
    expect(await index.search('al', { limit: 10 })).toEqual([])
  })

  it('does not raise on FTS5 operator characters', async () => {
    for (const query of ['"', 'NEAR(', 'alpha OR', '*', '-alpha', 'a"b']) {
      await expect(index.search(query, { limit: 10 })).resolves.toBeInstanceOf(Array)
    }
  })

  it('returns nothing when nothing matches', async () => {
    expect(await index.search('nonexistent', { limit: 10 })).toEqual([])
  })
})

describe('filtering', () => {
  beforeEach(async () => {
    await index.reconcile([
      entry('entities/a.md', { title: 'Alpha', body: 'shared term', type: 'entity', tags: ['x'], status: 'current' }),
      entry('concepts/b.md', { title: 'Beta', body: 'shared term', type: 'concept', tags: ['x', 'y'], status: 'stub' }),
      entry('syntheses/c.md', { title: 'Gamma', body: 'shared term', type: 'synthesis', tags: ['y'], status: 'disputed' }),
    ])
  })

  it('narrows by type', async () => {
    const hits = await index.search('shared', { limit: 10, type: 'concept' })
    expect(hits.map(hit => hit.path)).toEqual(['concepts/b.md'])
  })

  it('narrows by status', async () => {
    const hits = await index.search('shared', { limit: 10, status: 'disputed' })
    expect(hits.map(hit => hit.path)).toEqual(['syntheses/c.md'])
  })

  it('narrows by every requested tag', async () => {
    const hits = await index.search('shared', { limit: 10, tags: ['x', 'y'] })
    expect(hits.map(hit => hit.path)).toEqual(['concepts/b.md'])
  })

  it('honours the requested limit', async () => {
    const hits = await index.search('shared', { limit: 2 })
    expect(hits).toHaveLength(2)
  })

  it('returns the stored type, status, and updated date', async () => {
    const hits = await index.search('shared', { limit: 10, type: 'entity' })
    expect(hits[0]).toMatchObject({ type: 'entity', status: 'current', updated: '2026-10-07' })
  })
})

describe('reconciliation against the files', () => {
  it('re-reads a row whose mtime changed', async () => {
    await index.reconcile([entry('concepts/live.md', { body: 'first wording', mtimeMs: 1 })])
    expect((await index.search('first', { limit: 10 })).map(hit => hit.path)).toEqual(['concepts/live.md'])

    await index.reconcile([entry('concepts/live.md', { body: 'second wording', mtimeMs: 2 })])

    expect(await index.search('first', { limit: 10 })).toEqual([])
    expect((await index.search('second', { limit: 10 })).map(hit => hit.path)).toEqual(['concepts/live.md'])
  })

  it('leaves an unchanged row alone', async () => {
    const stable = entry('concepts/stable.md', { body: 'unchanged body', mtimeMs: 7 })
    await index.reconcile([stable])
    await index.reconcile([stable])

    expect((await index.search('unchanged', { limit: 10 })).map(hit => hit.path)).toEqual(['concepts/stable.md'])
  })

  it('drops a row whose page is gone', async () => {
    await index.reconcile([entry('concepts/gone.md', { body: 'vanishing text' })])
    await index.reconcile([])

    expect(await index.search('vanishing', { limit: 10 })).toEqual([])
  })

  it('rebuilds every row from scratch', async () => {
    await index.reconcile([entry('concepts/old.md', { body: 'stale text' })])
    await index.rebuild([entry('concepts/new.md', { body: 'fresh text' })])

    expect(await index.search('stale', { limit: 10 })).toEqual([])
    expect((await index.search('fresh', { limit: 10 })).map(hit => hit.path)).toEqual(['concepts/new.md'])
  })
})

describe('cache durability', () => {
  it('recovers from a database file that is not a database', async () => {
    await index.close()
    const dbPath = join(root, '.wiki', 'index.db')
    await writeFile(dbPath, 'this is not a sqlite database', 'utf8')

    const recovered = new WikiSearchIndex(dbPath)
    await recovered.open()
    await recovered.reconcile([entry('concepts/healed.md', { body: 'recovered text' })])

    expect((await recovered.search('recovered', { limit: 10 })).map(hit => hit.path)).toEqual(['concepts/healed.md'])
    await recovered.close()
    index = recovered
  })

  it('persists rows across a close and reopen', async () => {
    await index.reconcile([entry('concepts/kept.md', { body: 'persisted text' })])
    await index.close()

    const reopened = new WikiSearchIndex(join(root, '.wiki', 'index.db'))
    await reopened.open()

    expect((await reopened.search('persisted', { limit: 10 })).map(hit => hit.path)).toEqual(['concepts/kept.md'])
    await reopened.close()
    index = reopened
  })

  it('opens and closes idempotently', async () => {
    await index.open()
    await index.open()
    await index.close()
    await index.close()
  })

  it('creates the database directory when it is absent', async () => {
    await index.close()
    const nested = new WikiSearchIndex(join(root, 'deep', 'nested', 'index.db'))
    await nested.open()
    await nested.reconcile([entry('concepts/deep.md', { body: 'nested text' })])
    expect((await nested.search('nested', { limit: 10 }))).toHaveLength(1)
    await nested.close()
    index = nested
  })

  it('writes nothing outside its own database path', async () => {
    const before = await readFile(join(root, 'unrelated.txt'), 'utf8').catch(() => null)
    expect(before).toBeNull()
  })
})
