/**
 * Disk-level vault fixtures shared by the prism-wiki suites: hand-written page
 * files a model never produced, and search-cache database files in every state
 * the filesystem can hold.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** One malformed frontmatter document, with the field the parser must name. */
export interface MalformedPage {
  /** What makes the document malformed. */
  readonly name: string
  /** The complete file text. */
  readonly text: string
  /** The frontmatter field the failure must name. */
  readonly field: string
}

/** Frontmatter documents the parser must refuse, one per rejection reason. */
export const MALFORMED_PAGES: readonly MalformedPage[] = [
  {
    name: 'no frontmatter block',
    text: 'just body text\n',
    field: 'title',
  },
  {
    name: 'a block never closed',
    text: '---\ntitle: Open\ntype: concept\ntags: [x]\nupdated: 2026-10-07\nstatus: current\n\nBody without a closing delimiter.\n',
    field: 'closed',
  },
  {
    name: 'a missing required field',
    text: '---\ntitle: Partial\ntype: concept\ntags: [x]\n---\n\nBody.\n',
    field: 'updated',
  },
  {
    name: 'an unknown type',
    text: '---\ntitle: Odd\ntype: nonsense\ntags: [x]\nupdated: 2026-10-07\nstatus: current\n---\n\nBody.\n',
    field: 'type',
  },
  {
    name: 'an unknown status',
    text: '---\ntitle: Odd\ntype: concept\ntags: [x]\nupdated: 2026-10-07\nstatus: maybe\n---\n\nBody.\n',
    field: 'status',
  },
  {
    name: 'an empty title',
    text: '---\ntitle: ""\ntype: concept\ntags: [x]\nupdated: 2026-10-07\nstatus: current\n---\n\nBody.\n',
    field: 'title',
  },
  {
    name: 'a non-ISO updated date',
    text: '---\ntitle: Dated\ntype: concept\ntags: [x]\nupdated: October 7\nstatus: current\n---\n\nBody.\n',
    field: 'updated',
  },
  {
    name: 'a scalar where a list is required',
    text: '---\ntitle: Scalar\ntype: concept\ntags: not-a-list\nupdated: 2026-10-07\nstatus: current\n---\n\nBody.\n',
    field: 'tags',
  },
  {
    name: 'a confidence out of range',
    text: '---\ntitle: Certain\ntype: concept\ntags: [x]\nupdated: 2026-10-07\nstatus: current\nconfidence: 1.5\n---\n\nBody.\n',
    field: 'confidence',
  },
  {
    name: 'a confidence that is not a number',
    text: '---\ntitle: Vague\ntype: concept\ntags: [x]\nupdated: 2026-10-07\nstatus: current\nconfidence: high\n---\n\nBody.\n',
    field: 'confidence',
  },
]

/**
 * Write one page file under the vault's `wiki/` directory, creating its directory.
 * @param vaultRoot - the vault directory.
 * @param relative - the page path relative to `wiki/`, including the `.md` suffix.
 * @param text - the complete file text.
 * @returns the absolute path the file was written to.
 */
export async function writeWikiFile(vaultRoot: string, relative: string, text: string): Promise<string> {
  const target = join(vaultRoot, 'wiki', relative)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, text, 'utf8')
  return target
}

/**
 * Write a SQLite file that belongs to another application, so the search cache
 * must refuse it instead of deleting it.
 * @param path - the database file path to create.
 */
export function writeForeignDatabase(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA application_id = 305419896')
    db.exec('CREATE TABLE alien (id INTEGER)')
  } finally {
    db.close()
  }
}

/**
 * Write a SQLite file that carries no application id but holds tables, so the
 * search cache must refuse it instead of deleting it.
 * @param path - the database file path to create.
 */
export function writeUnbrandedDatabase(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE alien (id INTEGER)')
  } finally {
    db.close()
  }
}

/**
 * Overwrite a database path with text no SQLite reader accepts.
 * @param path - the database file path to clobber.
 */
export async function writeGarbageDatabase(path: string): Promise<void> {
  await writeFile(path, 'this is not a sqlite database', 'utf8')
}
