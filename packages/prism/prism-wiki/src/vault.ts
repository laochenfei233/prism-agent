/**
 * Filesystem core of the markdown knowledge vault.
 *
 * The module owns the vault directory, the page frontmatter format, atomic page
 * writes, the two derived navigation files, and the vault-wide link relations
 * and lint report. It reads and writes with `node:fs/promises` directly because
 * the vault sits outside the session workspace and is touched by trusted plugin
 * code; the sandbox around the model's own file tools does not apply here. The
 * module has no Cordis dependency and calls no model.
 *
 * @module @prism/prism-wiki/vault
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { Dirent } from 'node:fs'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  WikiFrontmatter,
  WikiLintFinding,
  WikiLintKind,
  WikiLintReport,
  WikiPage,
  WikiPageDraft,
  WikiPagePath,
  WikiPageStatus,
  WikiPageType,
  WikiSourcePath,
} from './types.ts'

/** Every page kind, in the order the catalog and the lint report use. */
const PAGE_TYPES: readonly WikiPageType[] = ['overview', 'entity', 'concept', 'source', 'comparison', 'synthesis']

/** Every page status. */
const PAGE_STATUSES: readonly WikiPageStatus[] = ['current', 'stub', 'superseded', 'disputed']

/** The directory each non-overview page kind is filed in, relative to `wiki/`. */
const PAGE_TYPE_DIRECTORIES: Readonly<Record<Exclude<WikiPageType, 'overview'>, string>> = {
  entity: 'entities',
  concept: 'concepts',
  source: 'sources',
  comparison: 'comparisons',
  synthesis: 'syntheses',
}

/** The catalog heading for each page kind. */
const PAGE_TYPE_HEADINGS: Readonly<Record<WikiPageType, string>> = {
  overview: 'Overview',
  entity: 'Entities',
  concept: 'Concepts',
  source: 'Sources',
  comparison: 'Comparisons',
  synthesis: 'Syntheses',
}

/** The order findings are sorted in, matching the declaration order of `WikiLintKind`. */
const LINT_KIND_ORDER: readonly WikiLintKind[] = [
  'orphan-page',
  'broken-link',
  'missing-page',
  'unintegrated-source',
  'missing-source',
  'frontmatter',
  'contradiction',
]

/** How many distinct pages must ask for a missing name before the lint report raises it. */
const MISSING_PAGE_THRESHOLD = 3

/** Longest body summary the generated catalog quotes from a page. */
const SUMMARY_MAX_CHARS = 160

/** The date format `updated` must use. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Directory names under `raw/` that hold attachments rather than sources. */
const ASSET_DIRECTORIES: ReadonlySet<string> = new Set(['assets'])

/** The heading an empty log file carries, before its first dated entry. */
const LOG_HEADING = '# Log'

/** Error codes this module raises. */
export type WikiVaultErrorCode =
  | 'WIKI_ROOT_NOT_VAULT'
  | 'WIKI_PAGE_NOT_FOUND'
  | 'WIKI_SOURCE_NOT_FOUND'
  | 'WIKI_FRONTMATTER_INVALID'
  | 'WIKI_REVISION_CONFLICT'

/** One vault failure, carrying the class of failure callers branch on. */
export class WikiVaultError extends Error {
  /**
   * @param message - what failed, naming the page, source, or frontmatter field at fault.
   * @param code - the class of failure.
   * @param current - the stored page, present when a revision conflict refused a write so the caller can compare.
   */
  constructor(message: string, readonly code: WikiVaultErrorCode, readonly current?: WikiPage) {
    super(message)
    this.name = 'WikiVaultError'
  }
}

/** One page plus the file mtime a search index reconciles against. */
export interface VaultPageEntry {
  /** The parsed page. */
  readonly page: WikiPage
  /** Modification time of the page file, in milliseconds since the epoch. */
  readonly mtimeMs: number
}

/** The schema seeded at `<vaultRoot>/AGENTS.md` on first use. */
export const VAULT_SCHEMA_TEMPLATE = `# Wiki schema

This file is the vault's own schema. It is seeded once and never regenerated, so edit it as this wiki's conventions
change: the human and the model co-own it.

## Categories

- \`entities/\` - one page per durable thing: a person, project, product, organization, or tool.
- \`concepts/\` - one page per idea, method, or term that outlives any single source.
- \`sources/\` - one page per ingested raw source, recording what it says and how far it is trusted.
- \`comparisons/\` - one page per decision between alternatives, carrying its criteria and its outcome.
- \`syntheses/\` - one page per conclusion drawn across several pages.
- \`overview.md\` - the single front door: what this wiki covers and where to start.

## What earns a page

Write a page when the subject is likely to be referenced again by name. A fact that belongs to exactly one page stays
on that page. Two pages that keep contradicting each other are a comparison, not two entities.

## Page files

A page lives at \`wiki/<directory>/<slug>.md\`. The slug is lowercase and hyphen-separated. Keep it stable: to rename a
page, add the old slug to \`aliases\` instead of moving the file. Open the body with one paragraph saying what the
subject is, because the generated index quotes that paragraph.

## Frontmatter

Every page opens with a flat YAML block:

\`\`\`yaml
---
title: The page's human-facing name
type: entity
status: current
updated: 2026-01-31
tags: [retrieval, ranking]
aliases: [Other Name]
sources: [notes/paper.md]
confidence: 0.8
contradicts: [concepts/other-page.md]
---
\`\`\`

\`title\`, \`type\`, \`tags\`, \`updated\`, and \`status\` are required; the rest are optional. \`type\` is one of \`entity\`,
\`concept\`, \`source\`, \`comparison\`, \`synthesis\`, or \`overview\`, and it fixes the directory the file lives in. Lists
are written either as \`[a, b]\` or as indented \`- a\` items.

## Citing a source

Keep every raw input under \`raw/\` unchanged and cite it by its path relative to \`raw/\` in \`sources\`. Name the source
in the sentence that uses it. When two pages disagree, record the disagreement in both pages' \`contradicts\` so the
health report stops asking about it.

## Linking

Link with \`[[name]]\`, using the file's slug without \`.md\`, its path relative to \`wiki/\`, or one of its aliases. A
link to a page that does not exist yet is a request for one; the health report lists names that three or more pages
ask for.

## Syntheses

Open a synthesis with the conclusion, then the evidence in the order that supports it, then what would change the
conclusion. Cite the pages it draws on and never restate one in full.

## Derived files

\`index.md\` is regenerated from page frontmatter and \`log.md\` receives one line per write. Neither is edited by hand.
`

/** One raw frontmatter value before validation. */
type RawField =
  | { readonly kind: 'scalar'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly string[] }

/**
 * Extract the target names of every `[[wikilink]]` in a markdown body, in order, de-duplicated.
 * The display text of `[[target|display]]` and the heading of `[[target#heading]]` are dropped.
 * Two spellings that differ only in case count as one target, keeping the first spelling.
 * @param body - markdown with the frontmatter block removed.
 * @returns the link targets, in first-appearance order.
 */
export function extractWikiLinks(body: string): readonly string[] {
  const pattern = /\[\[([^\[\]]+)\]\]/g
  const seen = new Set<string>()
  const links: string[] = []
  for (const match of body.matchAll(pattern)) {
    const target = linkTarget(match[1] ?? '')
    if (target === '') continue
    const key = target.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    links.push(target)
  }
  return links
}

/**
 * Parse and validate one page's file text.
 * A required field that is missing or malformed raises `WIKI_FRONTMATTER_INVALID`
 * with the field name in the message. Optional fields that are absent default to
 * an empty list, or to null for `confidence`.
 * @param text - the complete file text, frontmatter block included.
 * @param path - the page identity the text was read from, used in error messages.
 * @returns the validated frontmatter and the body with the frontmatter block removed.
 * @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID`.
 */
export function parsePageText(text: string, path: WikiPagePath): { frontmatter: WikiFrontmatter; body: string } {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if ((lines[0] ?? '').trim() !== '---') {
    throw invalidField(path, 'title', 'is missing because the file has no frontmatter block')
  }
  const closing = closingDelimiterIndex(lines)
  if (closing < 0) {
    throw new WikiVaultError(`${path}: frontmatter block is not closed by a --- line`, 'WIKI_FRONTMATTER_INVALID')
  }
  const fields = readFrontmatterFields(lines.slice(1, closing))
  const frontmatter = readFrontmatter(fields, path)
  const body = lines.slice(closing + 1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
  return { frontmatter, body }
}

/**
 * Render one page's complete file text, including the YAML frontmatter block.
 * Optional fields are written only when they carry a value, and lists are always
 * written in the inline form the parser also reads.
 * @param frontmatter - the validated frontmatter to store.
 * @param body - markdown stored below the frontmatter block.
 * @returns the file text, ending with exactly one trailing newline.
 */
export function serializePageText(frontmatter: WikiFrontmatter, body: string): string {
  const lines = [
    '---',
    `title: ${renderScalar(frontmatter.title)}`,
    `type: ${frontmatter.type}`,
    `status: ${frontmatter.status}`,
    `updated: ${frontmatter.updated}`,
    `tags: ${renderList(frontmatter.tags)}`,
  ]
  if (frontmatter.aliases.length > 0) lines.push(`aliases: ${renderList(frontmatter.aliases)}`)
  if (frontmatter.sources.length > 0) lines.push(`sources: ${renderList(frontmatter.sources)}`)
  if (frontmatter.confidence !== null) lines.push(`confidence: ${String(frontmatter.confidence)}`)
  if (frontmatter.contradicts.length > 0) lines.push(`contradicts: ${renderList(frontmatter.contradicts)}`)
  lines.push('---')
  const head = `${lines.join('\n')}\n`
  const trimmedBody = body.replace(/\s+$/, '')
  return trimmedBody === '' ? head : `${head}\n${trimmedBody}\n`
}

/**
 * SHA-256 (hex) of the complete file text; the value `expectedRevision` compares against.
 * @param text - the complete file text.
 * @returns the lowercase hexadecimal digest.
 */
export function revisionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The vault-wide health report. Pure: it reads only its arguments, so a caller
 * supplies the pages and raw sources it already listed. Findings are ordered by
 * kind, then by page, then by detail.
 *
 * `pages` and `sources` are the examined counts. A page no other page links to
 * is orphaned; the generated catalog is not a page, and it is not an argument
 * here, so a page reachable only from `index.md` still counts as orphaned.
 * @param pages - every parsed page in the vault.
 * @param sources - every raw source path in the vault, relative to `raw/`.
 * @param unreadable - page files whose frontmatter could not be parsed, reported as `frontmatter` findings.
 * @returns the counts examined and every finding, in report order.
 */
export function lintVault(
  pages: readonly WikiPage[],
  sources: readonly WikiSourcePath[],
  unreadable: readonly WikiUnreadablePage[] = [],
): WikiLintReport {
  const findings: WikiLintFinding[] = []
  const index = buildLinkIndex(pages)
  const backlinks = new Map<string, Set<string>>()
  const unresolved = new Map<string, { readonly name: string; readonly pages: Set<string> }>()

  for (const page of pages) {
    for (const target of extractWikiLinks(page.body)) {
      const resolved = index.get(normalizePageTarget(target)) ?? null
      if (resolved === null) {
        recordUnresolved(unresolved, target, page.path)
        findings.push({ kind: 'broken-link', page: page.path, detail: `[[${target}]] resolves to no page` })
        continue
      }
      if (resolved.path === page.path) continue
      const linked = backlinks.get(resolved.path) ?? new Set<string>()
      linked.add(page.path)
      backlinks.set(resolved.path, linked)
    }
    if (!pathMatchesType(page.path, page.frontmatter.type)) {
      findings.push({
        kind: 'frontmatter',
        page: page.path,
        detail: `type "${page.frontmatter.type}" expects the directory ${describeTypeDirectory(page.frontmatter.type)}`,
      })
    }
  }

  for (const page of pages) {
    if ((backlinks.get(page.path)?.size ?? 0) === 0) {
      findings.push({ kind: 'orphan-page', page: page.path, detail: 'no page links to this page' })
    }
  }

  for (const entry of unresolved.values()) {
    if (entry.pages.size < MISSING_PAGE_THRESHOLD) continue
    findings.push({
      kind: 'missing-page',
      page: null,
      detail: `${entry.pages.size} pages link to [[${entry.name}]] but no page exists`,
    })
  }

  const available = new Set<string>()
  for (const source of sources) {
    const key = sourceKey(source)
    if (key !== '') available.add(key)
  }

  const cited = new Map<string, Set<string>>()
  for (const page of pages) {
    const reported = new Set<string>()
    for (const entry of page.frontmatter.sources) {
      const key = sourceKey(entry)
      if (key === '' || reported.has(key)) continue
      reported.add(key)
      if (!available.has(key)) {
        findings.push({ kind: 'missing-source', page: page.path, detail: `cites raw source "${entry}" which does not exist` })
        continue
      }
      const citing = cited.get(key) ?? new Set<string>()
      citing.add(page.path)
      cited.set(key, citing)
    }
  }

  for (const source of sources) {
    const key = sourceKey(source)
    if (key === '' || (cited.get(key)?.size ?? 0) > 0) continue
    findings.push({ kind: 'unintegrated-source', page: null, detail: `raw source "${source}" is cited by no page` })
  }

  for (const page of pages) {
    const reported = new Set<string>()
    for (const name of page.frontmatter.contradicts) {
      const other = index.get(normalizePageTarget(name)) ?? null
      if (other === null) {
        findings.push({ kind: 'contradiction', page: page.path, detail: `contradicts [[${name}]], which resolves to no page` })
        continue
      }
      if (other.path === page.path) continue
      if (reported.has(other.path)) continue
      reported.add(other.path)
      const reciprocal = other.frontmatter.contradicts.some(
        value => (index.get(normalizePageTarget(value)) ?? null)?.path === page.path,
      )
      if (reciprocal) continue
      findings.push({
        kind: 'contradiction',
        page: page.path,
        detail: `contradicts [[${name}]] but ${other.path} does not name this page back`,
      })
    }
  }

  for (const page of unreadable) {
    findings.push({ kind: 'frontmatter', page: page.path, detail: page.message })
  }

  findings.sort(compareFindings)
  return { pages: pages.length, sources: sources.length, findings }
}

/** A page file the vault could not parse, named for the human who must repair it. */
export interface WikiUnreadablePage {
  /** Page identity relative to `wiki/`, including the `.md` suffix. */
  readonly path: WikiPagePath
  /** The parser's own message, which names the offending field. */
  readonly message: string
}

/** The filesystem half of the vault. */
export class VaultFiles {
  /**
   * @param root - absolute path of the vault directory the instance manages.
   */
  constructor(readonly root: string) {}

  /**
   * Create the layout and seed the schema when the vault is absent; refuse a
   * non-empty directory that is not a vault. Idempotent.
   *
   * A directory counts as a vault when it holds `AGENTS.md`. An absent or empty
   * directory is adopted and receives `AGENTS.md`, `raw/`, `raw/assets/`,
   * `wiki/`, the five page directories, and the two derived files `index.md`
   * and `log.md`. `AGENTS.md` is written only when that file is absent, so an
   * edited schema is never overwritten, and `index.md` is built only when it is
   * absent, so a later call never discards an existing catalog. `.wiki/` is
   * created by the module that owns the search cache.
   * @returns nothing.
   * @throws WikiVaultError with code `WIKI_ROOT_NOT_VAULT` when the target is a non-empty non-vault directory.
   */
  async ensureLayout(): Promise<void> {
    const existing = await readDirectoryNames(this.root)
    if (existing !== null && existing.length > 0 && !existing.some(name => name.toLowerCase() === 'agents.md')) {
      throw new WikiVaultError(
        `"${this.root}" is not empty and holds no AGENTS.md, so it is not a wiki vault`,
        'WIKI_ROOT_NOT_VAULT',
      )
    }
    if (existing === null && (await fileExists(this.root))) {
      throw new WikiVaultError(`"${this.root}" is a file, not a wiki vault directory`, 'WIKI_ROOT_NOT_VAULT')
    }
    const wiki = join(this.root, 'wiki')
    const directories = [
      this.root,
      join(this.root, 'raw'),
      join(this.root, 'raw', 'assets'),
      wiki,
      ...Object.values(PAGE_TYPE_DIRECTORIES).map(name => join(wiki, name)),
    ]
    for (const directory of directories) await mkdir(directory, { recursive: true })
    const schema = join(this.root, 'AGENTS.md')
    if (!(await fileExists(schema))) await writeAtomically(schema, VAULT_SCHEMA_TEMPLATE)
    const log = join(this.root, 'log.md')
    if (!(await fileExists(log))) await writeAtomically(log, `${LOG_HEADING}\n`)
    if (!(await fileExists(join(this.root, 'index.md')))) await this.rebuildIndex()
  }

  /**
   * Every readable page, parsed, with its mtime. A page whose frontmatter cannot
   * be parsed is skipped rather than aborting the walk, so one hand-edited file
   * cannot take down search, lint, or the catalog. `listUnreadablePages` names
   * those files, and `readPage` still refuses to return one.
   * @returns the parsed pages, ordered by path.
   * @throws WikiVaultError with code `WIKI_ROOT_NOT_VAULT` when `wiki/` is absent.
   */
  async listPageEntries(): Promise<readonly VaultPageEntry[]> {
    const files = await this.pageFiles()
    const entries: VaultPageEntry[] = []
    for (const file of files.sort(compareStrings)) {
      const path = pagePathOf(this.root, file)
      try {
        const text = await readFile(file, 'utf8')
        const { frontmatter, body } = parsePageText(text, path)
        const metadata = await stat(file)
        entries.push({ page: { path, frontmatter, body, revision: revisionOf(text) }, mtimeMs: metadata.mtimeMs })
      } catch (error) {
        // A page that vanished mid-walk or cannot be parsed is reported by
        // listUnreadablePages and by lint; it must not abort an enumeration
        // every other reader depends on.
        if (!(error instanceof WikiVaultError) && !isMissing(error)) throw error
      }
    }
    return entries
  }

  /**
   * Every page file whose frontmatter cannot be parsed, with the parser's message.
   * @returns the unreadable pages, ordered by path.
   * @throws WikiVaultError with code `WIKI_ROOT_NOT_VAULT` when `wiki/` is absent.
   */
  async listUnreadablePages(): Promise<readonly WikiUnreadablePage[]> {
    const files = await this.pageFiles()
    const unreadable: WikiUnreadablePage[] = []
    for (const file of files.sort(compareStrings)) {
      const path = pagePathOf(this.root, file)
      try {
        parsePageText(await readFile(file, 'utf8'), path)
      } catch (error) {
        if (!(error instanceof WikiVaultError)) throw error
        unreadable.push({ path, message: error.message })
      }
    }
    return unreadable
  }

  /**
   * One page.
   * @param path - page identity relative to `wiki/`, including the `.md` suffix.
   * @returns the parsed page with the revision of its file text.
   * @throws WikiVaultError with code `WIKI_PAGE_NOT_FOUND` when no such page file exists.
   * @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when the file is unparsable.
   */
  async readPage(path: WikiPagePath): Promise<WikiPage> {
    const normalized = normalizePagePath(path)
    if (normalized === null) throw new WikiVaultError(`"${path}" is not a vault page path`, 'WIKI_PAGE_NOT_FOUND')
    const file = join(this.root, 'wiki', normalized)
    const text = await readFileOrNull(file)
    if (text === null) throw new WikiVaultError(`page "${path}" does not exist`, 'WIKI_PAGE_NOT_FOUND')
    const { frontmatter, body } = parsePageText(text, path)
    return { path, frontmatter, body, revision: revisionOf(text) }
  }

  /**
   * Whether a page file exists.
   * @param path - page identity relative to `wiki/`, including the `.md` suffix.
   * @returns true when a regular page file is present at that path.
   */
  async hasPage(path: WikiPagePath): Promise<boolean> {
    const normalized = normalizePagePath(path)
    if (normalized === null) return false
    const exists = await fileExists(join(this.root, 'wiki', normalized))
    return exists
  }

  /**
   * The vault schema text.
   * @returns the current contents of `<vaultRoot>/AGENTS.md`.
   * @throws WikiVaultError with code `WIKI_ROOT_NOT_VAULT` when that file is absent.
   */
  async readSchema(): Promise<string> {
    const schema = join(this.root, 'AGENTS.md')
    const text = await readFileOrNull(schema)
    if (text === null) {
      throw new WikiVaultError(`"${this.root}" holds no AGENTS.md, so it is not a wiki vault`, 'WIKI_ROOT_NOT_VAULT')
    }
    return text
  }

  /**
   * Register a new raw source. Refuses to overwrite an existing source.
   * @param path - source identity relative to `raw/`; a leading `raw/` is accepted and ignored.
   * @param text - the source text to store unchanged.
   * @returns nothing.
   * @throws WikiVaultError with code `WIKI_SOURCE_NOT_FOUND` when the path is unusable or names an attachment directory.
   * @throws WikiVaultError with code `WIKI_REVISION_CONFLICT` when the source already exists.
   */
  async addSource(path: WikiSourcePath, text: string): Promise<void> {
    const key = sourceKey(path)
    if (key === '' || ASSET_DIRECTORIES.has(key.split('/')[0] ?? '')) {
      throw new WikiVaultError(`"${path}" is not a storable raw source path`, 'WIKI_SOURCE_NOT_FOUND')
    }
    const target = join(this.root, 'raw', key)
    if (await fileExists(target)) {
      throw new WikiVaultError(`raw source "${path}" already exists`, 'WIKI_REVISION_CONFLICT')
    }
    await writeAtomically(target, text)
  }

  /**
   * A bounded slice of one source's text, plus whether it was truncated.
   * @param path - source identity relative to `raw/`.
   * @param maxChars - largest slice to return, counted in UTF-16 code units; a value at or below zero returns no text.
   * @returns the text slice and whether more text follows it.
   * @throws WikiVaultError with code `WIKI_SOURCE_NOT_FOUND` when the path is unusable or the source does not exist.
   */
  async readSource(path: WikiSourcePath, maxChars: number): Promise<{ text: string; truncated: boolean }> {
    const key = sourceKey(path)
    if (key === '') throw new WikiVaultError(`"${path}" is not a raw source path`, 'WIKI_SOURCE_NOT_FOUND')
    const text = await readFileOrNull(join(this.root, 'raw', key))
    if (text === null) throw new WikiVaultError(`raw source "${path}" does not exist`, 'WIKI_SOURCE_NOT_FOUND')
    const limit = Math.max(0, Math.floor(maxChars))
    if (text.length <= limit) return { text, truncated: false }
    return { text: sliceWithoutSplittingPair(text, limit), truncated: true }
  }

  /**
   * Every raw source path, recursive, excluding the `assets/` directory.
   * @returns the source paths relative to `raw/`, ordered lexicographically.
   */
  async listSources(): Promise<readonly WikiSourcePath[]> {
    const raw = join(this.root, 'raw')
    const files = await walkFiles(raw, { excludedDirectories: ASSET_DIRECTORIES })
    if (files === null) return []
    return files
      .map(file => brandString<WikiSourcePath>(vaultRelativePath(raw, file)))
      .sort(compareStrings)
  }

  /**
   * Create or replace one page atomically, then refresh `index.md` and append one `log.md` entry.
   *
   * The write goes to a sibling temporary file and is renamed over the target, so
   * no reader sees a partial page. A draft whose path disagrees with its `type`
   * is refused before anything is written.
   * @param draft - the page to store, with an optional expected revision.
   * @param logKind - the kind recorded in the appended log entry.
   * @returns the stored page, as parsed back from the written text.
   * @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when the draft's path or frontmatter is invalid.
   * @throws WikiVaultError with code `WIKI_REVISION_CONFLICT` when `expectedRevision` does not match the stored text.
   */
  async writePage(draft: WikiPageDraft, logKind: string): Promise<WikiPage> {
    return await this.serialize(async () => await this.writePageLocked(draft, logKind))
  }

  /** Tail of the in-process mutation chain. */
  private chain: Promise<unknown> = Promise.resolve()

  /**
   * Run one mutating operation after every queued one has settled, so two
   * writers on this instance never interleave a read-modify-write of `index.md`
   * or `log.md`. Two separate processes over one vault are still unarbitrated.
   * @param operation - the exclusive operation to run.
   * @returns the operation's own result.
   */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation, operation)
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  private async writePageLocked(draft: WikiPageDraft, logKind: string): Promise<WikiPage> {
    const normalized = normalizePagePath(draft.path)
    if (normalized === null) {
      throw new WikiVaultError(`${draft.path}: frontmatter field "path" is not a vault page path`, 'WIKI_FRONTMATTER_INVALID')
    }
    assertFrontmatter(draft.frontmatter, draft.path)
    if (!pathMatchesType(draft.path, draft.frontmatter.type)) {
      const expected = describeTypeDirectory(draft.frontmatter.type)
      throw new WikiVaultError(
        `${draft.path}: frontmatter field "type" is "${draft.frontmatter.type}", which belongs in ${expected}`,
        'WIKI_FRONTMATTER_INVALID',
      )
    }
    const target = join(this.root, 'wiki', normalized)
    const existing = await readFileOrNull(target)
    if (draft.expectedRevision !== undefined) {
      if (existing === null) {
        throw new WikiVaultError(`page "${draft.path}" does not exist, so the expected revision cannot match`, 'WIKI_REVISION_CONFLICT')
      }
      const current = revisionOf(existing)
      if (current !== draft.expectedRevision) {
        let stored: WikiPage | undefined
        try {
          const parsedStored = parsePageText(existing, draft.path)
          stored = { path: draft.path, frontmatter: parsedStored.frontmatter, body: parsedStored.body, revision: current }
        } catch (error) {
          // The stored page is itself unparsable. The stale revision is still the
          // actionable failure, so it is reported without a page to compare.
          if (!(error instanceof WikiVaultError)) throw error
        }
        throw new WikiVaultError(
          `page "${draft.path}" changed: expected revision "${draft.expectedRevision}" but found "${current}"`,
          'WIKI_REVISION_CONFLICT',
          stored,
        )
      }
    }
    const text = serializePageText(draft.frontmatter, draft.body)
    await writeAtomically(target, text)
    const { frontmatter, body } = parsePageText(text, draft.path)
    const page: WikiPage = { path: draft.path, frontmatter, body, revision: revisionOf(text) }
    await this.rebuildIndex()
    await this.appendLogLocked(logKind, `${page.path} ${page.frontmatter.title}`)
    return page
  }

  /**
   * Rewrite `index.md` from every page's frontmatter, grouped by page kind.
   * Each entry names the page title, quotes the page's first body paragraph, and
   * carries the page's `[[wikilink]]`. A page whose frontmatter cannot be parsed
   * is listed under a `Needs attention` heading instead of aborting the rebuild.
   * The catalog's own frontmatter carries `generated: true`.
   *
   * This method is not itself queued on the mutation chain, so a direct caller
   * must tolerate a concurrent `writePage`; writers reach it from inside
   * `writePageLocked`, and `ensureLayout` calls it before the vault is published.
   * @returns nothing.
   * @throws WikiVaultError with code `WIKI_ROOT_NOT_VAULT` when `wiki/` is absent.
   */
  async rebuildIndex(): Promise<void> {
    const files = await this.pageFiles()
    const grouped = new Map<WikiPageType, string[]>()
    const attention: string[] = []
    for (const file of files.sort(compareStrings)) {
      const path = pagePathOf(this.root, file)
      const text = await readFile(file, 'utf8')
      let parsed: { frontmatter: WikiFrontmatter; body: string } | null = null
      let failure: string | null = null
      try {
        parsed = parsePageText(text, path)
      } catch (error) {
        // A page a hand edit left unparsable is still worth naming in the catalog.
        if (!(error instanceof WikiVaultError)) throw error
        failure = error.message
      }
      if (parsed === null) {
        attention.push(`- \`${path}\`: ${failure ?? 'frontmatter is invalid'}`)
        continue
      }
      const parts = [parsed.frontmatter.title]
      const summary = firstParagraph(parsed.body)
      if (summary !== '') parts.push(summary)
      parts.push(`[[${pagePathWithoutExtension(path)}]]`)
      const entries = grouped.get(parsed.frontmatter.type) ?? []
      entries.push(`- ${parts.join(' | ')}`)
      grouped.set(parsed.frontmatter.type, entries)
    }

    const lines = ['---', 'generated: true', 'title: Index', `updated: ${today()}`, '---', '', '# Index', '']
    for (const type of PAGE_TYPES) {
      const entries = grouped.get(type)
      if (entries === undefined || entries.length === 0) continue
      lines.push(`## ${PAGE_TYPE_HEADINGS[type]}`, '')
      lines.push(...entries)
      lines.push('')
    }
    if (attention.length > 0) {
      lines.push('## Needs attention', '')
      lines.push(...attention)
      lines.push('')
    }
    if (lines[lines.length - 1] === '') lines.pop()
    const text = `${lines.join('\n')}\n`
    await writeAtomically(join(this.root, 'index.md'), text)
  }

  /**
   * Append one entry to `log.md`. The file is created with a `# Log` heading when absent.
   * The entry heading has the form `## [YYYY-MM-DD] <kind> | <summary>`.
   * @param kind - the class of mutation being recorded.
   * @param summary - one line naming what changed.
   * @returns nothing.
   */
  async appendLog(kind: string, summary: string): Promise<void> {
    await this.serialize(async () => { await this.appendLogLocked(kind, summary) })
  }

  private async appendLogLocked(kind: string, summary: string): Promise<void> {
    const target = join(this.root, 'log.md')
    const existing = await readFileOrNull(target)
    const base = existing === null || existing.trim() === '' ? LOG_HEADING : existing.replace(/\s+$/, '')
    const heading = `## [${today()}] ${kind} | ${summary}`
    await writeAtomically(target, `${base}\n\n${heading}\n`)
  }

  /**
   * The newest `limit` log entry headings, newest first.
   * @param limit - how many headings to return; a value at or below zero returns none.
   * @returns the complete heading lines, newest first.
   */
  async logTail(limit: number): Promise<readonly string[]> {
    if (limit <= 0) return []
    const text = await readFileOrNull(join(this.root, 'log.md'))
    if (text === null) return []
    const headings = text.split(/\r?\n/).filter(line => line.startsWith('## ['))
    return headings.slice(Math.max(0, headings.length - limit)).reverse()
  }

  /**
   * The page files present under `wiki/`.
   * @returns absolute file paths, or a rejection when the vault has no `wiki/` directory.
   */
  private async pageFiles(): Promise<string[]> {
    const files = await walkFiles(join(this.root, 'wiki'), { extensions: ['.md'] })
    if (files === null) {
      throw new WikiVaultError(`"${this.root}" holds no wiki directory, so it is not a wiki vault`, 'WIKI_ROOT_NOT_VAULT')
    }
    return files
  }
}

/**
 * Build the lookup from every name a wikilink may use to the page it addresses.
 * The keys are lowercased: the page path without `.md`, the file stem, and every
 * declared alias. The first page in iteration order wins a key claimed twice, so
 * a caller listing pages in path order gets a stable resolution.
 * @param pages - every parsed page in the vault.
 * @returns the lookup keyed by lowercased name.
 */
function buildLinkIndex(pages: readonly WikiPage[]): ReadonlyMap<string, WikiPage> {
  const index = new Map<string, WikiPage>()
  for (const page of pages) {
    const keys = [
      pagePathWithoutExtension(page.path).toLowerCase(),
      pageStem(page.path).toLowerCase(),
      ...page.frontmatter.aliases.map(alias => alias.trim().toLowerCase()),
    ]
    for (const key of keys) {
      if (key === '' || index.has(key)) continue
      index.set(key, page)
    }
  }
  return index
}

/**
 * The lookup key of a written link target.
 * @param target - the text between `[[` and `]]`.
 * @returns the lowercased key, with `./`, `wiki/`, and a `.md` suffix removed.
 */
function normalizePageTarget(target: string): string {
  let value = target.trim().replace(/\\/g, '/').toLowerCase()
  if (value.startsWith('./')) value = value.slice(2)
  if (value.startsWith('wiki/')) value = value.slice(5)
  if (value.endsWith('.md')) value = value.slice(0, -3)
  return value
}

/**
 * The target name of one `[[...]]` payload.
 * @param payload - the text between `[[` and `]]`.
 * @returns the target with any display text and heading dropped, trimmed.
 */
function linkTarget(payload: string): string {
  const beforeDisplay = payload.split('|')[0] ?? ''
  return (beforeDisplay.split('#')[0] ?? '').trim()
}

/**
 * Record one unresolved link target per page that wrote it.
 * @param unresolved - the accumulator keyed by lowercased target.
 * @param target - the target as written.
 * @param page - the page that wrote the link.
 */
function recordUnresolved(
  unresolved: Map<string, { readonly name: string; readonly pages: Set<string> }>,
  target: string,
  page: WikiPagePath,
): void {
  const key = normalizePageTarget(target)
  const entry = unresolved.get(key) ?? { name: target, pages: new Set<string>() }
  entry.pages.add(page)
  unresolved.set(key, entry)
}

/**
 * Whether a page path sits in the directory its `type` selects.
 * @param path - page identity relative to `wiki/`.
 * @param type - the page kind.
 * @returns true when the path and the kind agree.
 */
function pathMatchesType(path: WikiPagePath, type: WikiPageType): boolean {
  if (type === 'overview') return path === 'overview.md'
  const directory = PAGE_TYPE_DIRECTORIES[type]
  return pageDirectoryOf(path) === directory
}

/**
 * The directory a page kind expects, as reported in a diagnostic.
 * @param type - the page kind.
 * @returns the vault-relative directory, with a trailing slash.
 */
function describeTypeDirectory(type: WikiPageType): string {
  return type === 'overview' ? '"wiki/"' : `"wiki/${PAGE_TYPE_DIRECTORIES[type]}/"`
}

/**
 * The directory part of a vault-relative path.
 * @param path - a vault-relative page path.
 * @returns the directory without a trailing slash, or an empty string at the vault root.
 */
function pageDirectoryOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/**
 * A page path without its `.md` suffix, the form its catalog wikilink uses.
 * @param path - a vault-relative page path.
 * @returns the path without the suffix.
 */
function pagePathWithoutExtension(path: string): string {
  return path.endsWith('.md') ? path.slice(0, -3) : path
}

/**
 * The file stem of a vault-relative page path.
 * @param path - a vault-relative page path.
 * @returns the last segment without its `.md` suffix.
 */
function pageStem(path: string): string {
  const withoutExtension = pagePathWithoutExtension(path)
  const slash = withoutExtension.lastIndexOf('/')
  return slash === -1 ? withoutExtension : withoutExtension.slice(slash + 1)
}

/**
 * Read a page path from disk-relative form, rejecting anything that leaves `wiki/`.
 * @param value - the candidate path.
 * @returns the normalized path, or null when it is not a page path.
 */
function normalizePagePath(value: string): string | null {
  const normalized = normalizeRelativePath(value)
  if (normalized === null || !normalized.endsWith('.md')) return null
  return normalized
}

/**
 * Read a raw source path from disk-relative form, rejecting anything that leaves `raw/`.
 * @param value - the candidate path, with or without a leading `raw/`.
 * @returns the normalized path, or an empty string when it is unusable.
 */
function sourceKey(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/')
  const stripped = trimmed.startsWith('raw/') ? trimmed.slice(4) : trimmed
  return normalizeRelativePath(stripped) ?? ''
}

/**
 * Normalize a relative path, rejecting absolute paths and parent traversal.
 * @param value - the candidate path.
 * @returns the path with forward slashes, or null when it is unusable.
 */
function normalizeRelativePath(value: string): string | null {
  const unified = value.trim().replace(/\\/g, '/')
  if (unified === '' || unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) return null
  const segments = unified.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

/**
 * The vault-relative path of one file, with forward slashes.
 * @param base - the directory the path is relative to.
 * @param file - the absolute file path.
 * @returns the relative path.
 */
function vaultRelativePath(base: string, file: string): string {
  return relative(base, file).split(sep).join('/')
}

/**
 * The page identity of one page file.
 * @param root - the vault root.
 * @param file - the absolute page file path under `wiki/`.
 * @returns the page identity relative to `wiki/`.
 */
function pagePathOf(root: string, file: string): WikiPagePath {
  return brandString<WikiPagePath>(vaultRelativePath(join(root, 'wiki'), file))
}

/** Walk options for {@link walkFiles}. */
interface WalkOptions {
  /** Directory names skipped wherever they appear, compared exactly. */
  readonly excludedDirectories?: ReadonlySet<string>
  /** When present, keep only files whose name ends with one of these suffixes. */
  readonly extensions?: readonly string[]
}

/**
 * Collect files under one directory, recursively.
 * @param directory - the absolute directory to walk.
 * @param options - directory names to skip and file suffixes to keep.
 * @returns the absolute file paths, or null when the directory is absent.
 */
async function walkFiles(directory: string, options: WalkOptions = {}): Promise<string[] | null> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    // A missing directory is reported as null so a caller can tell "absent" from "empty".
    if (isMissing(error)) return null
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (options.excludedDirectories?.has(entry.name) === true) continue
      const nested = await walkFiles(path, options)
      if (nested !== null) files.push(...nested)
      continue
    }
    if (!entry.isFile()) continue
    if (options.extensions !== undefined && !options.extensions.some(extension => entry.name.endsWith(extension))) continue
    files.push(path)
  }
  return files
}

/**
 * Write one file durably: a full write to a sibling temporary path, then a rename.
 * @param path - the target file path.
 * @param content - the complete file text.
 * @returns nothing.
 */
async function writeAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/**
 * Read a file, treating an absent file as null.
 * @param path - the file to read.
 * @returns the file text, or null when it does not exist.
 */
async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    // An absent file is an expected answer here; every other failure is a real fault.
    if (isMissing(error)) return null
    throw error
  }
}

/**
 * List one directory's entry names.
 * @param directory - the directory to list.
 * @returns the entry names, or null when the directory does not exist.
 */
async function readDirectoryNames(directory: string): Promise<string[] | null> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.map(entry => entry.name)
  } catch (error) {
    // An absent directory is an expected answer here; every other failure is a real fault.
    if (isMissing(error)) return null
    throw error
  }
}

/**
 * Whether a regular file exists at one path.
 * @param path - the path to test.
 * @returns true when the path names an existing regular file.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path)
    return metadata.isFile()
  } catch (error) {
    // An absent file is an expected answer here; every other failure is a real fault.
    if (isMissing(error)) return false
    throw error
  }
}

/**
 * Whether a filesystem failure means "nothing there".
 * @param error - the caught value.
 * @returns true for ENOENT and ENOTDIR.
 */
function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Cut a string at a code-unit limit without splitting a surrogate pair.
 * @param text - the text to cut.
 * @param limit - the maximum number of code units.
 * @returns the leading slice.
 */
function sliceWithoutSplittingPair(text: string, limit: number): string {
  let end = limit
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/** The current UTC calendar date. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * The first body paragraph, collapsed to one line and clipped for the catalog.
 * @param body - the markdown body.
 * @returns the summary text, or an empty string when the body opens with a heading, table, or code fence.
 */
function firstParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const cleaned = block.replace(/\s+/g, ' ').trim()
    if (cleaned === '') continue
    if (/^(#{1,6}\s|>|\||```)/.test(cleaned)) continue
    return clipSummary(cleaned)
  }
  return ''
}

/**
 * Clip a summary to the catalog's line budget.
 * @param value - the collapsed paragraph.
 * @returns the paragraph, shortened at a word boundary when it exceeds the budget.
 */
function clipSummary(value: string): string {
  if (value.length <= SUMMARY_MAX_CHARS) return value
  const clipped = value.slice(0, SUMMARY_MAX_CHARS - 3)
  const boundary = clipped.lastIndexOf(' ')
  const head = boundary > SUMMARY_MAX_CHARS / 2 ? clipped.slice(0, boundary) : clipped
  return `${head}...`
}

/**
 * Validate frontmatter a caller assembled in memory.
 * @param frontmatter - the frontmatter to store.
 * @param path - the page identity, used in error messages.
 * @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` naming the offending field.
 */
function assertFrontmatter(frontmatter: WikiFrontmatter, path: WikiPagePath): void {
  if (frontmatter.title.trim() === '') throw invalidField(path, 'title', 'must not be empty')
  if (enumValue(PAGE_TYPES, frontmatter.type) === null) throw invalidField(path, 'type', `must be one of ${PAGE_TYPES.join(', ')}`)
  if (enumValue(PAGE_STATUSES, frontmatter.status) === null) {
    throw invalidField(path, 'status', `must be one of ${PAGE_STATUSES.join(', ')}`)
  }
  if (!DATE_PATTERN.test(frontmatter.updated)) throw invalidField(path, 'updated', 'must be a YYYY-MM-DD date')
  const confidence = frontmatter.confidence
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw invalidField(path, 'confidence', 'must be a number between 0 and 1')
  }
}

/**
 * Build the error for one invalid frontmatter field.
 * @param path - the page identity.
 * @param field - the field at fault.
 * @param detail - the clause completing the message.
 * @returns the error to throw.
 */
function invalidField(path: WikiPagePath, field: string, detail: string): WikiVaultError {
  return new WikiVaultError(`${path}: frontmatter field "${field}" ${detail}`, 'WIKI_FRONTMATTER_INVALID')
}

/**
 * Find the line that closes the frontmatter block.
 * @param lines - the file text split on newlines.
 * @returns the index of the closing `---` line, or -1 when there is none.
 */
function closingDelimiterIndex(lines: readonly string[]): number {
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') return index
  }
  return -1
}

/**
 * Read the flat frontmatter fields of one block.
 * Keys are recognized as `name:` at column zero; an empty value followed by
 * indented `- item` lines is read as a list, and an unrecognized line is ignored.
 * @param lines - the lines between the two `---` delimiters.
 * @returns the raw field values by key.
 */
function readFrontmatterFields(lines: readonly string[]): Map<string, RawField> {
  const fields = new Map<string, RawField>()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1] ?? ''
    const rest = (match[2] ?? '').trim()
    if (rest !== '') {
      fields.set(key, parseInlineValue(rest))
      continue
    }
    const items: string[] = []
    let next = index + 1
    while (next < lines.length) {
      const item = /^\s*-\s*(.*)$/.exec(lines[next] ?? '')
      if (item === null) break
      pushListValue(items, unquote((item[1] ?? '').trim()))
      next += 1
    }
    if (items.length > 0) {
      fields.set(key, { kind: 'list', values: items })
      index = next - 1
      continue
    }
    fields.set(key, { kind: 'scalar', value: '' })
  }
  return fields
}

/**
 * Read one inline value: a bracketed list, or a scalar.
 * @param rest - the text after the `:` on one frontmatter line.
 * @returns the raw field.
 */
function parseInlineValue(rest: string): RawField {
  if (rest.startsWith('[') && rest.endsWith(']')) {
    return { kind: 'list', values: splitInlineList(rest.slice(1, -1)) }
  }
  return { kind: 'scalar', value: unquote(rest) }
}

/**
 * Split the inside of an inline list on top-level commas.
 * @param inner - the text between `[` and `]`.
 * @returns the non-empty items, with surrounding quotes removed.
 */
function splitInlineList(inner: string): readonly string[] {
  const values: string[] = []
  let current = ''
  let quote: string | null = null
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index] ?? ''
    if (quote !== null) {
      current += character
      if (character === '\\') {
        index += 1
        current += inner[index] ?? ''
        continue
      }
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      current += character
      continue
    }
    if (character === ',') {
      pushListValue(values, unquote(current.trim()))
      current = ''
      continue
    }
    current += character
  }
  pushListValue(values, unquote(current.trim()))
  return values
}

/**
 * Append one non-empty list item.
 * @param values - the accumulator.
 * @param candidate - the raw item text.
 */
function pushListValue(values: string[], candidate: string): void {
  const value = candidate.trim()
  if (value !== '') values.push(value)
}

/**
 * Remove one layer of matching quotes.
 * @param value - the raw scalar text.
 * @returns the value without its surrounding quotes.
 */
function unquote(value: string): string {
  const first = value[0]
  const last = value[value.length - 1]
  if (value.length < 2) return value
  if (first === '"' && last === '"') return value.slice(1, -1).replace(/\\(["\\])/g, '$1')
  if (first === "'" && last === "'") return value.slice(1, -1)
  return value
}

/**
 * Validate the parsed fields of one page.
 * @param fields - the raw field values read from the frontmatter block.
 * @param path - the page identity, used in error messages.
 * @returns the validated frontmatter.
 * @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` naming the offending field.
 */
function readFrontmatter(fields: ReadonlyMap<string, RawField>, path: WikiPagePath): WikiFrontmatter {
  const title = readRequiredScalar(fields, 'title', path).trim()
  if (title === '') throw invalidField(path, 'title', 'must not be empty')
  const type = readEnumField(fields, 'type', PAGE_TYPES, path)
  const updated = readRequiredScalar(fields, 'updated', path)
  if (!DATE_PATTERN.test(updated)) throw invalidField(path, 'updated', 'must be a YYYY-MM-DD date')
  const status = readEnumField(fields, 'status', PAGE_STATUSES, path)
  return {
    title,
    type,
    updated,
    status,
    tags: readRequiredList(fields, 'tags', path),
    sources: readOptionalList(fields, 'sources', path),
    aliases: readOptionalList(fields, 'aliases', path),
    confidence: readOptionalNumber(fields, 'confidence', path),
    contradicts: readOptionalList(fields, 'contradicts', path),
  }
}

/**
 * Read one required scalar field.
 * @param fields - the raw field values.
 * @param key - the field name.
 * @param path - the page identity, used in error messages.
 * @returns the scalar text.
 * @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when the field is absent or a list.
 */
function readRequiredScalar(fields: ReadonlyMap<string, RawField>, key: string, path: WikiPagePath): string {
  const field = fields.get(key)
  if (field === undefined) throw invalidField(path, key, 'is missing')
  if (field.kind !== 'scalar') throw invalidField(path, key, 'must be a single value')
  return field.value
}

/**
 * Read one required field whose value must come from a closed set.
 * @param fields - the raw field values.
 * @param key - the field name.
 * @param values - the admitted values.
 * @param path - the page identity, used in error messages.
 * @returns the matching value.
 * @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when the field is absent or unrecognized.
 */
function readEnumField<T extends string>(
  fields: ReadonlyMap<string, RawField>,
  key: string,
  values: readonly T[],
  path: WikiPagePath,
): T {
  const raw = readRequiredScalar(fields, key, path)
  const value = enumValue(values, raw.trim())
  if (value === null) throw invalidField(path, key, `must be one of ${values.join(', ')}`)
  return value
}

/**
 * Read one required list field.
 * @param fields - the raw field values.
 * @param key - the field name.
 * @param path - the page identity, used in error messages.
 * @returns the list items, empty when the field carries no items.
 * @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when the field is absent or a non-empty scalar.
 */
function readRequiredList(fields: ReadonlyMap<string, RawField>, key: string, path: WikiPagePath): readonly string[] {
  const field = fields.get(key)
  if (field === undefined) throw invalidField(path, key, 'is missing')
  return listValue(field, key, path)
}

/**
 * Read one optional list field.
 * @param fields - the raw field values.
 * @param key - the field name.
 * @param path - the page identity, used in error messages.
 * @returns the list items, empty when the field is absent.
 * @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when the field is a non-empty scalar.
 */
function readOptionalList(fields: ReadonlyMap<string, RawField>, key: string, path: WikiPagePath): readonly string[] {
  const field = fields.get(key)
  if (field === undefined) return []
  return listValue(field, key, path)
}

/**
 * Read one list value from its raw form.
 * @param field - the raw field.
 * @param key - the field name, used in error messages.
 * @param path - the page identity, used in error messages.
 * @returns the list items.
 * @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when a non-empty scalar cannot be a list.
 */
function listValue(field: RawField, key: string, path: WikiPagePath): readonly string[] {
  if (field.kind === 'list') return field.values
  if (field.value.trim() === '') return []
  throw invalidField(path, key, 'must be a list, written as [a, b] or as indented - items')
}

/**
 * Read one optional number field held between 0 and 1.
 * @param fields - the raw field values.
 * @param key - the field name.
 * @param path - the page identity, used in error messages.
 * @returns the number, or null when the field is absent.
 * @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when the value is not a number in range.
 */
function readOptionalNumber(fields: ReadonlyMap<string, RawField>, key: string, path: WikiPagePath): number | null {
  const field = fields.get(key)
  if (field === undefined) return null
  if (field.kind !== 'scalar') throw invalidField(path, key, 'must be a number between 0 and 1')
  const raw = field.value.trim()
  const value = Number(raw)
  if (raw === '' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidField(path, key, 'must be a number between 0 and 1')
  }
  return value
}

/**
 * The value of a closed set that equals one candidate string.
 * @param values - the admitted values.
 * @param value - the candidate.
 * @returns the admitted value, or null when the candidate is not admitted.
 */
function enumValue<T extends string>(values: readonly T[], value: string): T | null {
  return values.find(candidate => candidate === value) ?? null
}

/** Render one list value in the inline form the parser reads. */
function renderList(values: readonly string[]): string {
  return `[${values.map(renderScalar).join(', ')}]`
}

/** Render one scalar, quoting it unless it is unambiguously plain. */
function renderScalar(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9 ._/@()-]*$/.test(value)) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Compare two strings by code unit, for a stable order on every platform. */
function compareStrings(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** Order findings by kind, then by page, then by detail. */
function compareFindings(left: WikiLintFinding, right: WikiLintFinding): number {
  const kind = LINT_KIND_ORDER.indexOf(left.kind) - LINT_KIND_ORDER.indexOf(right.kind)
  if (kind !== 0) return kind
  const page = compareStrings(left.page ?? '', right.page ?? '')
  if (page !== 0) return page
  return compareStrings(left.detail, right.detail)
}
