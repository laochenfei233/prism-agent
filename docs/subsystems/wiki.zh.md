# Wiki 知识库

[English](wiki.md) | 中文

Wiki 知识库是 Prism 的知识层：每个 Workspace 一个互链 markdown 页面目录，模型从原始资料中摄取内容、通过工具撰写页面，并在之后据此作答；读取由可重建的 SQLite 全文缓存支撑。[`@prism/prism-wiki`](../../packages/prism/prism-wiki/README.zh.md) 端到端地拥有该能力——知识库目录、生成的目录与日志、五个面向模型的工具、`/wiki` 操作命令，以及 Web 知识页面。本页记录 Hub 暴露的 `ctx.wikiVault` Service Definition；[包 README](../../packages/prism/prism-wiki/README.zh.md) 拥有目录布局、配置与工具 schema。

角色映射：

| 包 | 职责 | 服务 |
|---|---|---|
| [`prism-wiki`](../../packages/prism/prism-wiki/README.zh.md) | 知识库目录及其生成的目录、五个面向模型的 wiki 工具、`/wiki` 命令与 Web 知识页面 | `ctx.wikiVault` |

## 知识库分层

知识库分三层，每层有一个所有者。`raw/` 存放不可变来源，插件只注册一次并拒绝覆盖。`wiki/` 存放模型通过 `wiki_write` 撰写的页面。`AGENTS.md` 存放知识库自身的约定，从随附模板播种一次后不再重新生成，因此人与模型从此共同维护这份约定。

写入是原子的，并按知识库实例串行：一次写入替换整个页面、向 `log.md` 追加一条按日期的记录、重新生成 `index.md`，并刷新全文缓存。两个进程操作同一知识库不做仲裁，因此一个 profile 对一个知识库目录只运行一个 Hub。

## 来源与检索

来源以相对于 `raw/` 的路径注册且从不改写；页面引用来源时使用这些路径。检索读取由 `wiki/` 目录重建的 SQLite 缓存，因此缓存丢失后可以重放页面恢复，搜索也从缓存作答而非扫描文件。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

Source: [`packages/prism/prism-wiki/src/service.ts`](../../packages/prism/prism-wiki/src/service.ts)
<!-- END GENERATED cordis-surface -->
