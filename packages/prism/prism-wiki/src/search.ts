/**
 * Rebuildable full-text cache over the pages of a wiki vault.
 *
 * The FTS5 table is never authoritative: rows are reproduced from the page
 * entries the caller hands in, and a database file that is missing, foreign, or
 * unusable is replaced instead of reported. `node:sqlite` is imported on first
 * use so a process that never searches never loads it.
 *
 * @module @prism/prism-wiki/search
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { mkdir, open, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  WikiPagePath,
  WikiPageStatus,
  WikiPageType,
  WikiSearchFilter,
  WikiSearchHit,
} from './types.ts'

/** Database path that keeps the cache in memory instead of on disk. */
const MEMORY_PATH = ':memory:'

/** SQLite `application_id` marking a file as this index's own cache. */
const WIKI_SEARCH_APPLICATION_ID = 0x50574b31

/** Derived-index version; a file carrying any other version is reset in place. */
const WIKI_SEARCH_SCHEMA_VERSION = 1

/** Longest excerpt the index returns, in Unicode code points. */
const EXCERPT_MAX_CHARACTERS = 200

/** Marker showing that an excerpt was cut out of a longer body. */
const ELLIPSIS = '…'

/** Shortest query the trigram tokenizer can match. */
const TRIGRAM_MIN_LENGTH = 3

/** Separator between the literal terms of one query. */
const QUERY_SEPARATOR = /\s+/u

/**
 * Derived schema. `trigram` indexes every three-character sequence, which is the
 * only built-in tokenizer that matches Chinese text; the default `unicode61`
 * treats a whole CJK run as one token and returns no hits for a substring query.
 * `path` and `mtime_ms` are carried unindexed for row lookup and reconciliation.
 */
const WIKI_PAGES_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages USING fts5(
  title,
  body,
  tags,
  type,
  status,
  updated,
  path UNINDEXED,
  mtime_ms UNINDEXED,
  tokenize = 'trigram'
)`

/** Insert covering every column of `wiki_pages`. */
const INSERT_PAGE_SQL = 'INSERT INTO wiki_pages (title, body, tags, type, status, updated, path, mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'

/** Removal addressed by page identity. */
const DELETE_PAGE_SQL = 'DELETE FROM wiki_pages WHERE path = ?'

/** Columns a hit needs before ranking and limiting. */
const SELECT_HIT_COLUMNS = 'SELECT path, title, type, status, updated, body FROM wiki_pages'

/** One page as the index stores it. */
export interface WikiSearchEntry {
  /** Vault-relative page identity. */
  readonly path: WikiPagePath
  /** Human-facing page title. */
  readonly title: string
  /** Markdown body with the frontmatter block removed. */
  readonly body: string
  /** Page kind. */
  readonly type: WikiPageType
  /** Whether the page's claims still stand. */
  readonly status: WikiPageStatus
  /** ISO calendar date of the last write. */
  readonly updated: string
  /** Lowercase recall tags. */
  readonly tags: readonly string[]
  /** File mtime; the index re-reads a row only when this changes. */
  readonly mtimeMs: number
}

/**
 * One selected `wiki_pages` row, including the body the excerpt is taken from.
 * Declared as a type alias so it stays assignable from SQLite's result records.
 */
type StoredHitRow = {
  path: string
  title: string
  type: string
  status: string
  updated: string
  body: string
}

/** An escaped FTS5 expression and the literal terms it searches for. */
type MatchQuery = {
  /** Expression safe to bind to `MATCH`. */
  expression: string
  /** Literal terms of the query, used to place the excerpt. */
  terms: readonly string[]
}

/** A file at the index path that this cache did not create and must not delete. */
class ForeignDatabaseError extends Error {
  /**
   * @param path - Database path holding the foreign file.
   * @param reason - What the file holds instead of this index's schema.
   */
  constructor(path: string, reason: string) {
    super(`wiki search cache at "${path}" ${reason}`)
    this.name = 'ForeignDatabaseError'
  }
}

/**
 * SQLite FTS5 cache over vault pages. Safe to construct without opening.
 */
export class WikiSearchIndex {
  private readonly databasePath: string
  private database: DatabaseSync | null = null
  private opening: Promise<DatabaseSync> | null = null

  /**
   * @param dbPath - Absolute path of the cache database, or `:memory:`.
   */
  constructor(readonly dbPath: string) {
    this.databasePath = dbPath === MEMORY_PATH ? MEMORY_PATH : resolve(dbPath)
  }

  /**
   * Open the database, importing `node:sqlite` on first use. Idempotent.
   * @returns A promise that settles once the handle is open and its schema is current.
   */
  async open(): Promise<void> {
    await this.ensureDatabase()
  }

  /**
   * Bring the index in line with these entries: upsert rows whose mtime changed,
   * delete rows whose page is gone.
   * @param entries - Current pages, each carrying the mtime of its file.
   * @returns A promise that settles once the index matches the entries.
   */
  async reconcile(entries: readonly WikiSearchEntry[]): Promise<void> {
    await this.run((db) => {
      const stored = readStoredMtimes(db)
      const present = new Set<string>(entries.map(entry => entry.path))
      const removed = [...stored.keys()].filter(path => !present.has(path))
      const changed = entries.filter(entry => stored.get(entry.path) !== entry.mtimeMs)
      db.exec('BEGIN')
      try {
        const remove = db.prepare(DELETE_PAGE_SQL)
        for (const path of removed) remove.run(path)
        const insert = db.prepare(INSERT_PAGE_SQL)
        for (const entry of changed) {
          remove.run(entry.path)
          writeEntry(insert, entry)
        }
        db.exec('COMMIT')
      } catch (error: unknown) {
        db.exec('ROLLBACK')
        throw error
      }
    })
  }

  /**
   * Drop and rebuild every row from these entries.
   * @param entries - Current pages, replacing whatever the index held.
   * @returns A promise that settles once the index holds exactly these entries.
   */
  async rebuild(entries: readonly WikiSearchEntry[]): Promise<void> {
    await this.run((db) => {
      db.exec('BEGIN')
      try {
        db.exec('DELETE FROM wiki_pages')
        const insert = db.prepare(INSERT_PAGE_SQL)
        for (const entry of entries) writeEntry(insert, entry)
        db.exec('COMMIT')
      } catch (error: unknown) {
        db.exec('ROLLBACK')
        throw error
      }
    })
  }

  /**
   * Ranked hits for a literal query, narrowed by the filter.
   * @param query - Literal query text; FTS5 operators in it are searched for, not applied.
   * @param filter - Kind, tag, and status narrowing plus the result cap.
   * @returns Ranked hits, never more than `filter.limit`, and empty when the query cannot match.
   */
  async search(query: string, filter: WikiSearchFilter): Promise<readonly WikiSearchHit[]> {
    const match = buildMatchQuery(query)
    const limit = Math.floor(filter.limit)
    if (match === null || !Number.isFinite(limit) || limit <= 0) return []
    try {
      return await this.run(db => selectHits(db, match, filter, limit))
    } catch (error: unknown) {
      // A cache that stays unusable yields no hits; anything else is this module's own failure.
      if (!isSqliteError(error)) throw error
      return []
    }
  }

  /**
   * Close the database. Idempotent.
   * @returns A promise that settles once the handle is closed.
   */
  async close(): Promise<void> {
    const pending = this.opening
    // An open that failed leaves nothing to close; its error already reached its own caller.
    if (pending !== null) await pending.catch(() => null)
    const db = this.database
    this.database = null
    if (db !== null) db.close()
  }

  private async ensureDatabase(): Promise<DatabaseSync> {
    if (this.database !== null) return this.database
    const pending = this.opening ?? this.openWithRecovery()
    this.opening = pending
    try {
      return await pending
    } finally {
      this.opening = null
    }
  }

  private async openWithRecovery(): Promise<DatabaseSync> {
    try {
      return await this.openDatabase()
    } catch (error: unknown) {
      if (error instanceof ForeignDatabaseError) throw error
      await this.discardDatabase()
      return await this.openDatabase()
    }
  }

  private async openDatabase(): Promise<DatabaseSync> {
    const path = this.databasePath
    if (path !== MEMORY_PATH) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await createDatabaseFile(path)
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path)
    try {
      initializeSchema(db, path)
    } catch (error: unknown) {
      closeQuietly(db)
      throw error
    }
    this.database = db
    return db
  }

  private async discardDatabase(): Promise<void> {
    const db = this.database
    this.database = null
    if (db !== null) closeQuietly(db)
    const path = this.databasePath
    if (path === MEMORY_PATH) return
    await rm(path, { force: true })
    await rm(`${path}-wal`, { force: true })
    await rm(`${path}-shm`, { force: true })
  }

  /**
   * Run one SQLite operation, replacing the file once when SQLite reports that
   * it cannot be read, and retrying the operation exactly once.
   */
  private async run<T>(operation: (db: DatabaseSync) => T): Promise<T> {
    const db = await this.ensureDatabase()
    try {
      return operation(db)
    } catch (error: unknown) {
      if (!isSqliteError(error)) throw error
      await this.discardDatabase()
      return operation(await this.openDatabase())
    }
  }
}

/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files retain their modes, and errors other than `EEXIST` propagate.
 * @param path - Resolved database path.
 * @returns A promise that settles once the file exists.
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Close a handle that recovery is about to replace.
 * @param db - Handle to close.
 */
function closeQuietly(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    // The file is discarded next; a failed close leaves no handle to reuse.
  }
}

/**
 * Apply the application id, the derived schema, and its version to an open handle.
 * @param db - Handle opened on `path`.
 * @param path - Database path, named in the refusal of a foreign file.
 */
function initializeSchema(db: DatabaseSync, path: string): void {
  const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
  const { user_version: userVersion } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (applicationId !== 0 && applicationId !== WIKI_SEARCH_APPLICATION_ID) {
    throw new ForeignDatabaseError(path, 'belongs to another application')
  }
  const userTables = listUserTables(db)
  if (applicationId === 0 && userTables.length > 0) {
    throw new ForeignDatabaseError(path, 'holds tables this index did not create')
  }
  if (applicationId === WIKI_SEARCH_APPLICATION_ID && userVersion !== WIKI_SEARCH_SCHEMA_VERSION) {
    resetDerivedSchema(db, userTables)
  }
  db.exec(`PRAGMA application_id = ${WIKI_SEARCH_APPLICATION_ID}`)
  db.exec(WIKI_PAGES_DDL)
  db.exec(`PRAGMA user_version = ${WIKI_SEARCH_SCHEMA_VERSION}`)
}

/**
 * User tables present in the file.
 * @param db - Open handle.
 * @returns Table names, excluding SQLite's own.
 */
function listUserTables(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ name: string }>
  return rows.map(row => row.name)
}

/**
 * Drop the tables of an older derived schema so the current one can be created.
 * @param db - Open handle.
 * @param userTables - Tables to drop, as listed by {@link listUserTables}.
 */
function resetDerivedSchema(db: DatabaseSync, userTables: readonly string[]): void {
  for (const name of userTables) db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`)
  db.exec('PRAGMA user_version = 0')
}

/**
 * Quote a table name read from `sqlite_master` for use in DDL.
 * @param value - Table name.
 * @returns The name as a quoted SQL identifier.
 */
function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * Stored mtime per page identity, read once per reconcile pass.
 * @param db - Open handle.
 * @returns Page identity to stored file mtime.
 */
function readStoredMtimes(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare('SELECT path, mtime_ms FROM wiki_pages').all() as Array<{ path: string; mtime_ms: number }>
  return new Map(rows.map((row): [string, number] => [row.path, row.mtime_ms]))
}

/**
 * Bind one page to the insert statement.
 * @param insert - Prepared insert over every `wiki_pages` column.
 * @param entry - Page to store.
 */
function writeEntry(insert: StatementSync, entry: WikiSearchEntry): void {
  insert.run(
    entry.title,
    entry.body,
    entry.tags.join(' '),
    entry.type,
    entry.status,
    entry.updated,
    entry.path,
    entry.mtimeMs,
  )
}

/**
 * Escape a literal query as an FTS5 expression.
 * @param query - Query text as the caller typed it.
 * @returns The escaped expression with its terms, or null when the query cannot match anything.
 */
function buildMatchQuery(query: string): MatchQuery | null {
  const literal = query.trim()
  // A trigram phrase shorter than three characters has no token to match.
  if (literal.length < TRIGRAM_MIN_LENGTH) return null
  const terms = literal.split(QUERY_SEPARATOR)
  return { expression: terms.map(quoteTerm).join(' AND '), terms }
}

/**
 * Quote one term as an FTS5 phrase so its text is searched for rather than applied.
 * @param term - Literal term.
 * @returns A double-quoted phrase with embedded quotes doubled.
 */
function quoteTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`
}

/**
 * Rank and select the rows matching one query.
 * @param db - Open handle.
 * @param match - Escaped query expression and its terms.
 * @param filter - Kind, tag, and status narrowing.
 * @param limit - Maximum hits, already known to be a positive integer.
 * @returns Ranked hits carrying an excerpt of each body.
 */
function selectHits(
  db: DatabaseSync,
  match: MatchQuery,
  filter: WikiSearchFilter,
  limit: number,
): readonly WikiSearchHit[] {
  const clauses = ['wiki_pages MATCH ?']
  const parameters: Array<string | number> = [match.expression]
  if (filter.type !== undefined) {
    clauses.push('type = ?')
    parameters.push(filter.type)
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?')
    parameters.push(filter.status)
  }
  for (const tag of filter.tags ?? []) {
    clauses.push("(' ' || tags || ' ') LIKE ? ESCAPE '!'")
    parameters.push(`% ${escapeLikePattern(tag)} %`)
  }
  parameters.push(limit)
  const sql = `${SELECT_HIT_COLUMNS} WHERE ${clauses.join(' AND ')} ORDER BY bm25(wiki_pages) LIMIT ?`
  const rows = db.prepare(sql).all(...parameters) as StoredHitRow[]
  return rows.map(row => ({
    path: brandString<WikiPagePath>(row.path),
    title: row.title,
    type: row.type as WikiPageType,
    status: row.status as WikiPageStatus,
    updated: row.updated,
    excerpt: buildExcerpt(row.body, match.terms),
  }))
}

/**
 * Escape the LIKE metacharacters of a tag so it matches as plain text.
 * @param value - Tag text.
 * @returns The tag with `!`, `%`, and `_` escaped for `ESCAPE '!'`.
 */
function escapeLikePattern(value: string): string {
  return value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')
}

/**
 * Bound an excerpt around the first query term the body contains.
 * @param body - Complete page body.
 * @param terms - Literal query terms.
 * @returns Body text within the character budget, marking each cut edge with an ellipsis.
 */
function buildExcerpt(body: string, terms: readonly string[]): string {
  const characters = Array.from(body)
  if (characters.length <= EXCERPT_MAX_CHARACTERS) return body
  const located = locateFirstTerm(body, terms)
  if (located === null) {
    return `${characters.slice(0, EXCERPT_MAX_CHARACTERS - 1).join('')}${ELLIPSIS}`
  }
  if (located.length >= EXCERPT_MAX_CHARACTERS) {
    return characters.slice(located.offset, located.offset + EXCERPT_MAX_CHARACTERS).join('')
  }
  const content = EXCERPT_MAX_CHARACTERS - 2
  const offset = located.offset - Math.floor((content - located.length) / 2)
  const start = Math.max(0, Math.min(offset, characters.length - content))
  const end = Math.min(characters.length, start + content)
  const prefix = start > 0 ? ELLIPSIS : ''
  const suffix = end < characters.length ? ELLIPSIS : ''
  return `${prefix}${characters.slice(start, end).join('').trim()}${suffix}`
}

/**
 * Find the earliest query term in a body.
 * @param body - Complete page body.
 * @param terms - Literal query terms.
 * @returns The first match's code-point offset and length, or null when the body holds none of them.
 */
function locateFirstTerm(body: string, terms: readonly string[]): { offset: number; length: number } | null {
  let first: { offset: number; length: number } | null = null
  for (const term of terms) {
    const offset = countCodePoints(body, findTermOffset(body, term))
    if (offset < 0) continue
    if (first === null || offset < first.offset) first = { offset, length: Array.from(term).length }
  }
  return first
}

/**
 * Locate one term in a body, folding case as the tokenizer does.
 * @param body - Complete page body.
 * @param term - Literal term.
 * @returns The code-unit offset of the term, or -1 when it is absent.
 */
function findTermOffset(body: string, term: string): number {
  const loweredBody = body.toLowerCase()
  const loweredTerm = term.toLowerCase()
  if (loweredBody.length === body.length && loweredTerm.length === term.length) {
    return loweredBody.indexOf(loweredTerm)
  }
  // Case folding changed a length, so the lowered offsets no longer address the body.
  return body.indexOf(term)
}

/**
 * Convert a code-unit offset into a code-point offset.
 * @param body - Complete page body.
 * @param offset - Code-unit offset, or a negative value to pass through.
 * @returns The number of code points before `offset`.
 */
function countCodePoints(body: string, offset: number): number {
  if (offset <= 0) return offset
  return Array.from(body.slice(0, offset)).length
}

/**
 * Whether an error came from SQLite rather than from this module.
 * @param error - Caught value.
 * @returns True when SQLite raised the error.
 */
function isSqliteError(error: unknown): boolean {
  return error instanceof Error && errorCode(error) === 'ERR_SQLITE_ERROR'
}

/**
 * Read the string `code` an error carries.
 * @param error - Error to inspect.
 * @returns The code, or undefined when the error carries none.
 */
function errorCode(error: Error): string | undefined {
  if (!('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}
