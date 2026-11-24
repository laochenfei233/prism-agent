# Wiki vault

English | [中文](wiki.zh.md)

The wiki vault is the Prism knowledge layer: a per-Workspace directory of interlinked markdown pages that the model ingests from raw sources, authors through tools, and answers from later, with a rebuildable SQLite full-text cache behind the reads. [`@prism/prism-wiki`](../../packages/prism/prism-wiki/README.md) owns the capability end to end — the vault directory, the generated catalog and log, the five model-facing tools, the `/wiki` operator command, and the Web Knowledge page. This page records the `ctx.wikiVault` Service Definition the hub exposes; the [package README](../../packages/prism/prism-wiki/README.md) owns the vault layout, configuration, and tool schemas.

Role map:

| Package | Owns | Service |
|---|---|---|
| [`prism-wiki`](../../packages/prism/prism-wiki/README.md) | The vault directory and its generated catalog, the five model-facing wiki tools, the `/wiki` command, and the Web Knowledge page | `ctx.wikiVault` |

## Vault layers

The vault is three layers with one owner each. `raw/` holds immutable sources that the plugin registers once and refuses to overwrite. `wiki/` holds the pages the model authors through `wiki_write`. `AGENTS.md` holds the vault's own conventions, seeded once from the shipped template and never regenerated, so the human and the model co-own the vault from then on.

Writes are atomic and serialized per vault instance: a write replaces one whole page, appends one dated entry to `log.md`, regenerates `index.md`, and refreshes the full-text cache. Two processes over one vault are not arbitrated, so a profile runs one hub per vault directory.

## Sources and retrieval

A source is registered with its path relative to `raw/` and never rewritten; pages cite sources by those paths. Retrieval reads the SQLite cache that the vault rebuilds from the `wiki/` directory, so a lost cache is recoverable by replaying the pages, and search answers from the cache rather than scanning files.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxwikivault--wikivaultservice"></a>

### `ctx.wikiVault` — `WikiVaultService`

The markdown knowledge vault. Each write is atomic, each read observes a whole file, and mutating operations on one instance serialize; two processes over one vault are not arbitrated.

```ts cordis-catalog
/**
 * Mark a session as owing the vault schema, so its next step carries it. A
 * session that already received the frame is never marked again.
 * @param agent - The calling session's agent, when the call has one.
 */
noteSchemaDue(agent: Agent | undefined): void

/**
 * Resolve the vault root, or fail loudly when the deployment set none.
 * @returns The absolute vault directory.
 */
vaultRoot(): string

/**
 * Open the vault on first use: create the layout when absent, then open the
 * search cache. Idempotent, and concurrent callers share one attempt.
 * @returns The opened vault files.
 */
async ready(): Promise<VaultFiles>

/**
 * Search the vault, reconciling the cache against the files first.
 * @param query - Literal query text.
 * @param filter - Narrowing applied on top of the query.
 * @returns Ranked hits, never more than the configured cap.
 */
async search(query: string, filter: WikiSearchFilter): Promise<readonly WikiSearchHit[]>

/**
 * Read one page together with its links, backlinks, and cited sources.
 * @param path - Vault-relative page identity.
 * @returns The page and its relations.
 */
async read(path: WikiPagePath): Promise<WikiPageView>

/**
 * Create or replace one page, refreshing the catalog, the log, and the cache.
 * @param draft - The page to store.
 * @returns The stored page.
 */
async write(draft: WikiPageDraft): Promise<WikiPage>

/**
 * List every raw source with the pages that cite it.
 * @returns One view per source, ordered by path.
 */
async sources(): Promise<readonly WikiSourceView[]>

/**
 * Read a bounded slice of one raw source.
 * @param path - Source identity relative to `raw/`.
 * @param maxChars - Caller-requested bound; the configured cap still applies.
 * @returns The text and whether the bound truncated it.
 */
async readSource(path: WikiSourcePath, maxChars?: number): Promise<{ text: string; truncated: boolean }>

/**
 * Register a new raw source.
 * @param path - Source identity relative to `raw/`.
 * @param text - Source text.
 * @returns The registered source's view.
 */
async addSource(path: WikiSourcePath, text: string): Promise<WikiSourceView>

/**
 * Report the pages already citing one source, refusing a source nothing cites.
 * @param path - Source identity relative to `raw/`.
 * @returns The citing pages.
 */
async confirmIntegrated(path: WikiSourcePath): Promise<readonly WikiPagePath[]>

/**
 * Health-check the whole vault.
 * @returns Counts and findings.
 */
async lint(): Promise<WikiLintReport>

/**
 * Vault statistics.
 * @returns Counts and the newest log heading.
 */
async status(): Promise<WikiVaultStatus>

/**
 * Discard the search cache and rebuild it from the files.
 * @returns A promise that settles once the rebuild finished.
 */
async rebuildIndex(): Promise<void>

/**
 * The newest log entry headings.
 * @param limit - How many entries to return.
 * @returns Headings, newest first.
 */
async logTail(limit: number): Promise<readonly string[]>

/**
 * The vault schema as authored in the vault.
 * @returns The `AGENTS.md` text.
 */
async schema(): Promise<string>
```

Types: [Agent](core.md)

Source: [`packages/prism/prism-wiki/src/service.ts`](../../packages/prism/prism-wiki/src/service.ts)
<!-- END GENERATED cordis-surface -->
