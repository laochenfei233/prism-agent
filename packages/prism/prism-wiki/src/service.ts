/**
 * The wiki vault service (`ctx.wikiVault`): opens the vault, answers the page,
 * source, search, and lint operations the tools, the operator command, and the
 * Web routes share, and puts the vault schema in front of the model once per
 * session.
 *
 * The service owns no model call. Reading, synthesis, and page authoring belong
 * to the model; everything here is mechanical and checkable.
 * @module @prism/prism-wiki
 */

import { join } from 'node:path'
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { VaultFiles, WikiVaultError, extractWikiLinks, lintVault } from './vault.ts'
import { WikiSearchIndex, type WikiSearchEntry } from './search.ts'
import type {
  WikiLintReport, WikiPage, WikiPageDraft, WikiPagePath, WikiPageView, WikiSearchFilter,
  WikiSearchHit, WikiSourcePath, WikiSourceView, WikiVaultStatus,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The markdown knowledge vault this deployment maintains. */
    wikiVault: WikiVaultService
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'prism-wiki': { kind: 'prism-wiki' } & ContextFormed
  }
}

/**
 * Prompt-section order for the wiki protocol. `getSectionOrder()` only knows
 * repository-allocated names, so this plugin claims a slot inside the tool
 * guidance band, between the goal section (2400) and workflow (2600).
 */
const WIKI_SECTION_ORDER = 2550

/** Directory the SQLite cache lives in, hidden from Obsidian and from git. */
const STATE_DIRECTORY = '.wiki'

/** Shipped protocol section: the vault's mechanics, never its domain conventions. */
export const DEFAULT_PROTOCOL = [
  'A wiki vault is a persistent, interlinked body of markdown pages that is compiled once and kept current, instead of being re-derived per question.',
  'Three layers: `raw/` holds immutable sources; `wiki/` holds the pages you own; `AGENTS.md` holds this vault\'s conventions.',
  'This vault\'s conventions are handed to you the first time you touch the vault in a session; follow them for every page you write.',
  'Ingest: read a source with `wiki_source`, then write or revise every page it changes with `wiki_write`. One source commonly touches several pages.',
  'Query: find pages with `wiki_search`, read them with `wiki_read`, and answer from them. A good answer is worth filing back as a page.',
  'Lint: run `wiki_lint` periodically and act on what it reports.',
].join(' ')

/** Deployment-owned vault choices. */
export interface Config {
  /** Absolute vault directory; unset means the plugin refuses to operate. */
  vaultRoot: Volatile<string | undefined>
  /** Static system-prompt text describing the vault mechanics. */
  protocolSection: Volatile<string>
  /** Whether the vault schema may be delivered to the model. */
  schemaDeliveryEnabled: Volatile<boolean>
  /** Hard cap on `wiki_search` results, including a model-requested limit. */
  maxSearchResults: Volatile<number>
  /** Character cap on one source read. */
  maxSourceChars: Volatile<number>
  /** Character cap on one page body write. */
  maxPageChars: Volatile<number>
}

/** A wiki operation that cannot proceed on the current configuration or vault. */
export class WikiError extends Error {
  /**
   * @param message - Operator-facing description of the failure.
   * @param code - Stable machine-readable discriminant.
   */
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'WikiError'
  }
}

/**
 * The markdown knowledge vault. Each write is atomic, each read observes a whole
 * file, and mutating operations on one instance serialize; two processes over
 * one vault are not arbitrated.
 */
export class WikiVaultService extends Service {
  /** Services required before the vault can be served. */
  static readonly inject = ['systemPrompt'] as const

  /** Validated deployment configuration. */
  static readonly Config = z.object({
    vaultRoot: z.string().volatile(),
    protocolSection: z.string().default(DEFAULT_PROTOCOL).volatile(),
    schemaDeliveryEnabled: z.boolean().default(true).volatile(),
    maxSearchResults: z.number().step(1).min(1).default(6).volatile(),
    maxSourceChars: z.number().step(1).min(1).default(40_000).volatile(),
    maxPageChars: z.number().step(1).min(1).default(200_000).volatile(),
  })

  private files: VaultFiles | undefined
  private index: WikiSearchIndex | undefined
  private opening: Promise<VaultFiles> | undefined
  /** Sessions whose next step still owes them the vault schema. */
  private readonly schemaPending = new WeakSet<Agent>()
  /** Sessions that already received the vault schema frame. */
  private readonly schemaDelivered = new WeakSet<Agent>()

  /**
   * @param ctx - Owning Cordis context.
   * @param config - Validated deployment configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'wikiVault')
    this.config = config
  }

  private readonly config: Config

  /**
   * Register the protocol section and the tail-frame listener.
   * @returns A promise that settles once contributions are registered.
   */
  [Service.init](): void {
    this.ctx.systemPrompt.section({
      name: 'prism-wiki',
      order: WIKI_SECTION_ORDER,
      text: () => this.config.protocolSection.get(),
    })

    this.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const text = await this.takeSchemaFrame(agent)
      if (text === '') return decision
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'prism-wiki', form: 'snapshot', sections: [{ name: 'prism-wiki-schema', text }] },
          }),
        ],
      }
    })
  }

  /**
   * Mark a session as owing the vault schema, so its next step carries it. A
   * session that already received the frame is never marked again.
   * @param agent - The calling session's agent, when the call has one.
   */
  noteSchemaDue(agent: Agent | undefined): void {
    if (agent === undefined) return
    if (!this.config.schemaDeliveryEnabled.get()) return
    if (this.schemaDelivered.has(agent)) return
    this.schemaPending.add(agent)
  }

  /**
   * Read the vault schema for one session and clear the debt.
   *
   * A vault that cannot answer this call — no `AGENTS.md`, no configured root —
   * already answered the tool call that created the debt, so the frame is
   * skipped rather than failing the step it was going to join.
   * @param agent - the session whose step is starting.
   * @returns The frame text, or an empty string when nothing is owed.
   */
  private async takeSchemaFrame(agent: Agent): Promise<string> {
    if (!this.schemaPending.has(agent)) return ''
    this.schemaPending.delete(agent)
    this.schemaDelivered.add(agent)
    let schema: string
    try {
      schema = await (await this.ready()).readSchema()
    } catch (error: unknown) {
      if (error instanceof WikiVaultError || error instanceof WikiError) return ''
      throw error
    }
    return `<prism-wiki-schema>\n${schema.trim()}\n</prism-wiki-schema>\nThese are this vault's conventions. Follow them for every page you write.`
  }

  /**
   * Resolve the vault root, or fail loudly when the deployment set none.
   * @returns The absolute vault directory.
   */
  vaultRoot(): string {
    const root = this.config.vaultRoot.get()
    if (root === undefined || root === '') {
      throw new WikiError(
        'no vault root: set vaultRoot on the prism-wiki row, for example vaultRoot: !!js dshHomePath(\'knowledge\')',
        'PRISM_WIKI_NO_VAULT_ROOT',
      )
    }
    return root
  }

  /**
   * Open the vault on first use: create the layout when absent, then open the
   * search cache. Idempotent, and concurrent callers share one attempt.
   * @returns The opened vault files.
   */
  async ready(): Promise<VaultFiles> {
    if (this.files !== undefined) return this.files
    this.opening ??= this.open()
    return await this.opening
  }

  private async open(): Promise<VaultFiles> {
    const root = this.vaultRoot()
    const files = new VaultFiles(root)
    await files.ensureLayout()
    const index = new WikiSearchIndex(join(root, STATE_DIRECTORY, 'index.db'))
    this.files = files
    this.index = index
    this.ctx.effect(() => async () => {
      await index.close()
    }, 'prismWiki.searchClose')
    return files
  }

  /**
   * Search the vault, reconciling the cache against the files first.
   * @param query - Literal query text.
   * @param filter - Narrowing applied on top of the query.
   * @returns Ranked hits, never more than the configured cap.
   */
  async search(query: string, filter: WikiSearchFilter): Promise<readonly WikiSearchHit[]> {
    const files = await this.ready()
    const index = this.requireIndex()
    const limit = Math.min(filter.limit, this.config.maxSearchResults.get())
    await index.reconcile(await this.entries(files))
    return await index.search(query, { ...filter, limit })
  }

  /**
   * Read one page together with its links, backlinks, and cited sources.
   * @param path - Vault-relative page identity.
   * @returns The page and its relations.
   */
  async read(path: WikiPagePath): Promise<WikiPageView> {
    const files = await this.ready()
    const entries = await files.listPageEntries()
    const page = await files.readPage(path)
    const links = resolveLinks(page.body, entries.map(entry => entry.page))
    const backlinks = entries
      .filter(entry => resolveLinks(entry.page.body, [page]).includes(path))
      .map(entry => entry.page.path)
    return { page, links, backlinks, sources: page.frontmatter.sources }
  }

  /**
   * Create or replace one page, refreshing the catalog, the log, and the cache.
   * @param draft - The page to store.
   * @returns The stored page.
   */
  async write(draft: WikiPageDraft): Promise<WikiPage> {
    const files = await this.ready()
    const body = enforceChars(draft.body, this.config.maxPageChars.get(), 'page body')
    return await files.writePage({ ...draft, body }, 'write')
  }

  /**
   * List every raw source with the pages that cite it.
   * @returns One view per source, ordered by path.
   */
  async sources(): Promise<readonly WikiSourceView[]> {
    const files = await this.ready()
    const paths = await files.listSources()
    const pages = (await files.listPageEntries()).map(entry => entry.page)
    return paths.map((path) => {
      const citing = pages.filter(page => page.frontmatter.sources.includes(path)).map(page => page.path)
      return { path, integrated: citing.length > 0, pages: citing }
    })
  }

  /**
   * Read a bounded slice of one raw source.
   * @param path - Source identity relative to `raw/`.
   * @param maxChars - Caller-requested bound; the configured cap still applies.
   * @returns The text and whether the bound truncated it.
   */
  async readSource(path: WikiSourcePath, maxChars?: number): Promise<{ text: string; truncated: boolean }> {
    const files = await this.ready()
    return await files.readSource(path, Math.min(maxChars ?? this.config.maxSourceChars.get(), this.config.maxSourceChars.get()))
  }

  /**
   * Register a new raw source.
   * @param path - Source identity relative to `raw/`.
   * @param text - Source text.
   * @returns The registered source's view.
   */
  async addSource(path: WikiSourcePath, text: string): Promise<WikiSourceView> {
    const files = await this.ready()
    await files.addSource(path, enforceChars(text, this.config.maxSourceChars.get(), 'source text'))
    return { path, integrated: false, pages: [] }
  }

  /**
   * Report the pages already citing one source, refusing a source nothing cites.
   * @param path - Source identity relative to `raw/`.
   * @returns The citing pages.
   */
  async confirmIntegrated(path: WikiSourcePath): Promise<readonly WikiPagePath[]> {
    const all = await this.sources()
    const found = all.find(source => source.path === path)
    if (found === undefined) {
      throw new WikiError(`no such raw source: ${path}`, 'PRISM_WIKI_SOURCE_NOT_FOUND')
    }
    if (!found.integrated) {
      throw new WikiError(
        `no page cites ${path} yet: write the pages this source changes, then confirm again`,
        'PRISM_WIKI_SOURCE_NOT_INTEGRATED',
      )
    }
    return found.pages
  }

  /**
   * Health-check the whole vault.
   * @returns Counts and findings.
   */
  async lint(): Promise<WikiLintReport> {
    const files = await this.ready()
    const entries = await files.listPageEntries()
    return lintVault(
      entries.map(entry => entry.page),
      await files.listSources(),
      await files.listUnreadablePages(),
    )
  }

  /**
   * Vault statistics.
   * @returns Counts and the newest log heading.
   */
  async status(): Promise<WikiVaultStatus> {
    const files = await this.ready()
    const entries = await files.listPageEntries()
    const sources = await this.sources()
    const tail = await files.logTail(1)
    return {
      vaultRoot: this.vaultRoot(),
      pages: entries.length,
      sources: sources.length,
      pendingSources: sources.filter(source => !source.integrated).length,
      lastLogEntry: tail[0] ?? null,
    }
  }

  /**
   * Discard the search cache and rebuild it from the files.
   * @returns A promise that settles once the rebuild finished.
   */
  async rebuildIndex(): Promise<void> {
    const files = await this.ready()
    const index = this.requireIndex()
    await index.rebuild(await this.entries(files))
  }

  /**
   * The newest log entry headings.
   * @param limit - How many entries to return.
   * @returns Headings, newest first.
   */
  async logTail(limit: number): Promise<readonly string[]> {
    return await (await this.ready()).logTail(limit)
  }

  /**
   * The vault schema as authored in the vault.
   * @returns The `AGENTS.md` text.
   */
  async schema(): Promise<string> {
    return await (await this.ready()).readSchema()
  }

  private requireIndex(): WikiSearchIndex {
    /* v8 ignore next -- ready() opens the cache before either caller reaches this guard. */
    if (this.index === undefined) throw new WikiError('the search cache is not open', 'PRISM_WIKI_NOT_READY')
    return this.index
  }

  private async entries(files: VaultFiles): Promise<readonly WikiSearchEntry[]> {
    return (await files.listPageEntries()).map(({ page, mtimeMs }) => ({
      path: page.path,
      title: page.frontmatter.title,
      body: page.body,
      type: page.frontmatter.type,
      status: page.frontmatter.status,
      updated: page.frontmatter.updated,
      tags: page.frontmatter.tags,
      mtimeMs,
    }))
  }
}

/**
 * Resolve every `[[wikilink]]` in a body against a known page set, matching a
 * page's path, its filename stem, or one of its declared aliases.
 * @param body - Markdown body to scan.
 * @param pages - Pages the links may resolve to.
 * @returns Resolved page identities, de-duplicated, unresolvable links dropped.
 */
export function resolveLinks(body: string, pages: readonly WikiPage[]): readonly WikiPagePath[] {
  const byName = new Map<string, WikiPagePath>()
  for (const page of pages) {
    const stem = page.path.slice(page.path.lastIndexOf('/') + 1).replace(/\.md$/u, '')
    byName.set(stem.toLowerCase(), page.path)
    byName.set(page.path.replace(/\.md$/u, '').toLowerCase(), page.path)
    for (const alias of page.frontmatter.aliases) byName.set(alias.toLowerCase(), page.path)
  }
  const resolved = new Set<WikiPagePath>()
  for (const name of extractWikiLinks(body)) {
    const target = byName.get(name.trim().toLowerCase())
    if (target !== undefined) resolved.add(target)
  }
  return [...resolved]
}

/**
 * Enforce a character bound on caller-supplied text.
 * @param text - Text to bound.
 * @param max - Maximum accepted length in Unicode code units.
 * @param label - Name of the bounded value, used in the failure message.
 * @returns The text unchanged when it fits.
 */
export function enforceChars(text: string, max: number, label: string): string {
  if (text.length > max) {
    throw new WikiError(`${label} exceeds ${max} characters`, 'PRISM_WIKI_TOO_LARGE')
  }
  return text
}

export { WikiVaultError, VaultFiles }
export type {
  WikiLintReport, WikiPage, WikiPageDraft, WikiPagePath, WikiPageView, WikiSearchFilter,
  WikiSearchHit, WikiSourcePath, WikiSourceView, WikiVaultStatus,
}

/**
 * Brand a model-supplied page path, which reaches the tools as a bare string.
 * @param value - Vault-relative page path as the caller wrote it.
 * @returns The same path carrying its page identity.
 */
export const brandPagePath = (value: string): WikiPagePath => brandString<WikiPagePath>(value)

/**
 * Brand a model-supplied raw-source path, which reaches the tools as a bare string.
 * @param value - Source path relative to `raw/` as the caller wrote it.
 * @returns The same path carrying its source identity.
 */
export const brandSourcePath = (value: string): WikiSourcePath => brandString<WikiSourcePath>(value)
