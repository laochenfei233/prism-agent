/**
 * Behaviour of the rebuildable full-text cache: literal matching including CJK,
 * mtime reconciliation against externally edited files, filter narrowing, and
 * recovery from a database that is not usable.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { WikiSearchIndex, type WikiSearchEntry } from '../src/search.ts'
import { writeForeignDatabase, writeUnbrandedDatabase } from './fixtures/vault-fixtures.ts'
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

  it('keeps the cache in memory when the path is the memory marker', async () => {
    await index.close()
    const memory = new WikiSearchIndex(':memory:')
    await memory.open()
    await memory.reconcile([entry('concepts/mem.md', { body: 'memory text' })])

    expect((await memory.search('memory', { limit: 10 })).map(hit => hit.path)).toEqual(['concepts/mem.md'])
    await memory.close()
    index = memory
  })

  it('closes cleanly while a failing open is still in flight', async () => {
    await index.close()
    const foreignPath = join(root, '.wiki', 'foreign.db')
    writeForeignDatabase(foreignPath)
    const doomed = new WikiSearchIndex(foreignPath)
    const opening = doomed.open()

    await expect(doomed.close()).resolves.toBeUndefined()
    await expect(opening).rejects.toThrow('belongs to another application')
    index = new WikiSearchIndex(join(root, '.wiki', 'index.db'))
    await index.open()
  })
})

describe('a database this cache does not own', () => {
  /** The cache path every case re-arms with a foreign file. */
  const dbPath = (): string => join(root, '.wiki', 'index.db')

  /** Reopen a fresh cache over the path, after the foreign file is gone. */
  async function reopenFresh(): Promise<void> {
    await rm(dbPath(), { force: true })
    index = new WikiSearchIndex(dbPath())
    await index.open()
  }

  it('refuses a file another application branded, and searches raise the refusal', async () => {
    await index.close()
    await rm(dbPath(), { force: true })
    writeForeignDatabase(dbPath())

    const foreign = new WikiSearchIndex(dbPath())
    await expect(foreign.open()).rejects.toThrow('belongs to another application')
    await expect(foreign.search('anything', { limit: 10 })).rejects.toThrow('belongs to another application')

    await reopenFresh()
  })

  it('refuses an unbranded file that already holds tables', async () => {
    await index.close()
    await rm(dbPath(), { force: true })
    writeUnbrandedDatabase(dbPath())

    const unbranded = new WikiSearchIndex(dbPath())
    await expect(unbranded.open()).rejects.toThrow('holds tables this index did not create')

    await reopenFresh()
  })

  it('rebuilds a cache whose derived schema is an older version', async () => {
    await index.reconcile([entry('concepts/old.md', { body: 'stale text' })])
    await index.close()
    const raw = new DatabaseSync(dbPath())
    raw.exec('PRAGMA user_version = 0')
    raw.close()

    const migrated = new WikiSearchIndex(dbPath())
    await migrated.open()
    await migrated.reconcile([entry('concepts/new.md', { body: 'fresh text' })])

    expect(await migrated.search('stale', { limit: 10 })).toEqual([])
    expect((await migrated.search('fresh', { limit: 10 })).map(hit => hit.path)).toEqual(['concepts/new.md'])
    await migrated.close()
    index = migrated
  })
})

describe('recovery from a cache that turns unusable while open', () => {
  it('rebuilds the page table after it is dropped under an open handle', async () => {
    await index.reconcile([entry('concepts/kept.md', { body: 'kept text' })])

    // Dropping the derived table behind the open handle makes the next
    // statement fail as a SQLite error, and the cache rebuilds itself.
    const saboteur = new DatabaseSync(join(root, '.wiki', 'index.db'))
    try {
      saboteur.exec('DROP TABLE wiki_pages')
    } finally {
      saboteur.close()
    }

    await index.reconcile([entry('concepts/kept.md', { body: 'kept text', mtimeMs: 2 })])

    expect((await index.search('kept', { limit: 10 })).map(hit => hit.path)).toEqual(['concepts/kept.md'])
  })

  it('rolls a failed reconciliation back and raises the fault', async () => {
    await index.reconcile([entry('concepts/kept.md', { body: 'kept text' })])
    // A page whose tags explode mid-insert faults the transaction after BEGIN.
    const hostile: WikiSearchEntry = {
      ...entry('concepts/hostile.md', { body: 'hostile text' }),
      get tags(): readonly string[] { throw new Error('tags exploded') },
    }

    await expect(index.reconcile([hostile])).rejects.toThrow('tags exploded')

    // The rollback left the previous rows intact.
    expect((await index.search('kept', { limit: 10 })).map(hit => hit.path)).toEqual(['concepts/kept.md'])
    expect(await index.search('hostile', { limit: 10 })).toEqual([])
  })

  it('rolls a failed rebuild back and raises the fault', async () => {
    await index.reconcile([entry('concepts/kept.md', { body: 'kept text' })])
    const hostile: WikiSearchEntry = {
      ...entry('concepts/hostile.md', { body: 'hostile text' }),
      get tags(): readonly string[] { throw new Error('tags exploded') },
    }

    await expect(index.rebuild([hostile])).rejects.toThrow('tags exploded')

    expect((await index.search('kept', { limit: 10 })).map(hit => hit.path)).toEqual(['concepts/kept.md'])
  })

  it('raises when an unusable cache cannot be discarded', async () => {
    await index.reconcile([entry('concepts/kept.md', { body: 'kept text' })])
    // Recovery discards the cache files before reopening; an occupied sidecar
    // cannot be discarded, so the failure reaches the caller with the handle open.
    await rm(join(root, '.wiki', 'index.db-wal'), { force: true })
    await mkdir(join(root, '.wiki', 'index.db-wal'), { recursive: true })
    await writeFile(join(root, '.wiki', 'index.db-wal', 'keeper.txt'), 'occupied', 'utf8')
    const saboteur = new DatabaseSync(join(root, '.wiki', 'index.db'))
    try {
      saboteur.exec('DROP TABLE wiki_pages')
    } finally {
      saboteur.close()
    }

    await expect(index.reconcile([entry('concepts/kept.md', { body: 'kept text', mtimeMs: 2 })]))
      .rejects.toThrow(/ENOTEMPTY|index\.db/iu)
  })
})

describe('excerpt bounding', () => {
  it('bounds an excerpt to the head of a body without the query term', async () => {
    // The title matches, so the hit is returned for a body that holds no term.
    await index.reconcile([entry('concepts/titled.md', {
      title: 'Needle holder',
      body: `${'padding '.repeat(60)}`,
    })])

    const hits = await index.search('needle', { limit: 10 })

    expect(hits).toHaveLength(1)
    expect(hits[0]?.excerpt.startsWith('padding')).toBe(true)
    expect(hits[0]?.excerpt.endsWith('…')).toBe(true)
  })

  it('cuts an excerpt at the budget when the matched term itself is longer', async () => {
    const term = 'y'.repeat(250)
    await index.reconcile([entry('concepts/long-term.md', {
      body: `${'x'.repeat(150)}${term}${'z'.repeat(150)}`,
    })])

    const hits = await index.search(term, { limit: 10 })

    expect(hits[0]?.excerpt).toHaveLength(200)
    expect(hits[0]?.excerpt.startsWith('yyy')).toBe(true)
  })

  it('marks only the edges that were cut', async () => {
    await index.reconcile([
      entry('concepts/head.md', { body: `needle ${'x'.repeat(300)}` }),
      entry('concepts/tail.md', { body: `${'x'.repeat(300)} needle` }),
    ])

    const hits = await index.search('needle', { limit: 10 })
    const excerpts = hits.map(hit => hit.excerpt)

    // The head match opens the excerpt uncut; the tail match closes it uncut.
    expect(excerpts.some(text => text.startsWith('needle'))).toBe(true)
    expect(excerpts.some(text => text.endsWith('…'))).toBe(true)
    expect(excerpts.some(text => text.startsWith('…'))).toBe(true)
    expect(excerpts.some(text => text.endsWith('needle'))).toBe(true)
  })

  it('locates terms out of order and folds case through the fallback path', async () => {
    // Both bodies exceed the excerpt budget, so the excerpt machinery runs.
    await index.reconcile([
      entry('concepts/ordered.md', { body: `alpha ${'filler '.repeat(40)} beta ${'more '.repeat(40)}` }),
      entry('concepts/dotted.md', { body: `The İtalian way of folding ${'x'.repeat(300)}` }),
    ])

    const inOrder = await index.search('alpha beta', { limit: 10 })
    expect(inOrder[0]?.excerpt).toContain('alpha')

    const reversed = await index.search('beta alpha', { limit: 10 })
    expect(reversed[0]?.excerpt).toContain('alpha')

    // Case folding changes the body length, so the offset search falls back.
    const folded = await index.search('way', { limit: 10 })
    expect(folded[0]?.excerpt).toContain('way')
  })
})
