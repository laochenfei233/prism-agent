---
description: "The Prism knowledge vault bundle: an LLM-maintained set of interlinked markdown pages with a rebuildable SQLite full-text cache, five model-facing wiki tools, the /wiki operator command, and the Web Knowledge page, for users adding a durable wiki to a dsh profile."
kind: "package-bundle"
---

# @prism/prism-wiki

English | [中文](README.zh.md)

## Summary

This bundle adds a persistent markdown knowledge vault to a `dsh` profile. The model ingests raw sources, writes interlinked pages, and answers from them later, while the package performs only the mechanical work: the vault directory, the generated catalog and log, a rebuildable SQLite full-text cache, five wiki tools, the `/wiki` operator command, and the Web Knowledge page. The vault is a directory of plain files that Obsidian can open, so what a profile learns outlives the session that wrote it. No shipped profile includes this layer; a profile gains it by installing the package and restarting.

## Table of Contents

- [The vault layout](#vault-layout)
- [Configuration](#configuration)
- [Model-facing tools](#model-facing-tools)
- [The `/wiki` command](#the-wiki-command)
- [Retrieval](#retrieval)
- [The Web Knowledge page](#web-knowledge-page)
- [Verification](#verification)
- [Installation](#installation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="vault-layout"></a>
## The vault layout

The vault is three layers, and each layer has one owner. `raw/` holds immutable sources: the plugin registers a source once and refuses to overwrite it. `wiki/` holds the pages, which the model authors through `wiki_write`. `AGENTS.md` holds the vault's own conventions, seeded once from the shipped template and never regenerated, so the human and the model co-own it from then on.

```text
<vaultRoot>/
  AGENTS.md       the vault's own schema, seeded once and never regenerated
  index.md        the generated catalog, grouped by page kind
  log.md          one dated heading per page write
  raw/            immutable sources, cited by path relative to this directory
    assets/       attachments; excluded from the source listing
  wiki/           the pages the model owns
    overview.md   the single front door
    entities/     one page per durable thing: a person, project, product, organization, or tool
    concepts/     one page per idea, method, or term
    sources/      one page per ingested raw source
    comparisons/  one page per decision between alternatives
    syntheses/    one page per conclusion drawn across several pages
  .wiki/          the SQLite full-text cache, hidden from Obsidian and from git
```

`ensureLayout()` creates that tree on first use. A directory that already holds `AGENTS.md` is adopted; a non-empty directory without that file is refused with `WIKI_ROOT_NOT_VAULT` instead of being filled in. `index.md` and `log.md` are derived files: the catalog is rewritten from page frontmatter after every write, and the log receives one heading per page write, so neither is edited by hand.

-----

<a id="configuration"></a>
## Configuration

The service reads its configuration from [`src/service.ts`](src/service.ts), and the shipped [`cordis.patch.yml`](cordis.patch.yml) states the vault root plus the three bounds. Every field is volatile, so a later patch layer or the running configuration surface can change it.

| Field | Default | Meaning |
|---|---|---|
| `vaultRoot` | none; required | Absolute vault directory. An empty or unset value makes every operation fail with `PRISM_WIKI_NO_VAULT_ROOT`; the shipped patch sets `!!js dshHomePath('knowledge')`. |
| `protocolSection` | `DEFAULT_PROTOCOL` | Static system-prompt text stating the vault mechanics; the shipped text is quoted under Model Experience. |
| `schemaDeliveryEnabled` | `true` | Whether a wiki tool call may mark the session as owing the vault schema frame. |
| `maxSearchResults` | `6` | Hard cap on `wiki_search` hits, applied on top of the model's own `limit`. |
| `maxSourceChars` | `40000` | Character cap on one source read and on one registered source; a longer `add` is refused with `PRISM_WIKI_TOO_LARGE`. |
| `maxPageChars` | `200000` | Character cap on one page body write; a longer body is refused with `PRISM_WIKI_TOO_LARGE`. |

-----

<a id="model-facing-tools"></a>
## Model-facing tools

The `./tools` row registers five definitions. Each call marks the session as owing the vault schema frame, and each refusal comes back as a result carrying `ok: false`, a stable `code`, and a message the model can act on, rather than as an unhandled tool error.

| Tool | Inputs | What it returns |
|---|---|---|
| `wiki_search` | `query` (required), `type`, `tags`, `status`, `limit` | Ranked hits (path, title, type, status, updated, and an excerpt around the first matching term), best `bm25()` match first, never more than `maxSearchResults`. |
| `wiki_read` | `path` (required) | One page in full: its frontmatter fields, body, outgoing links, backlinks, and the raw sources it cites. |
| `wiki_write` | `path`, `title`, `type`, `body` (required); `status`, `tags`, `sources`, `aliases`, `contradicts`, `confidence`, `expectedRevision` | The stored path, its new SHA-256 revision, and whether the write created the page. A stale `expectedRevision` is refused with `WIKI_REVISION_CONFLICT`. Frontmatter text carrying a newline is refused with `WIKI_FRONTMATTER_INVALID` before anything is written. |
| `wiki_source` | `action` (required: `list`, `read`, `add`, or `integrate`); `path`, `text`, `maxChars` | Per action: every source with the pages that cite it, one source's bounded text and whether the bound truncated it, the registered path, or the pages citing one source. |
| `wiki_lint` | none | The pages and sources examined, and every finding with its kind, its page (or null for a vault-wide finding), and its detail. |

The five definitions are a deliberate bound: tool schemas sit in the cached request prefix and are paid for on cold start and on every profile switch.

-----

<a id="the-wiki-command"></a>
## The `/wiki` command

`./commands` registers `/wiki`, the human half of vault maintenance. It costs no tool schema, so it cannot change the cached prefix, and the model has no way to call it.

| Subcommand | What it reports |
|---|---|
| `/wiki` or `/wiki status` | The vault root, page count, source count with how many no page cites, and the newest log heading. |
| `/wiki lint` | The same findings `wiki_lint` returns, as text. |
| `/wiki reindex` | Discards the search cache and rebuilds it from the page files. |
| `/wiki open <page>` | One page with its links, backlinks, and cited sources. |
| `/wiki log [n]` | The newest `n` log headings, newest first; 10 when `n` is absent or unusable. |
| `/wiki schema` | The vault's own `AGENTS.md` text. |

An unknown subcommand returns the usage text as an error result.

-----

<a id="retrieval"></a>
## Retrieval

Search is literal, not semantic. `wiki_search` escapes the query into FTS5 phrases, joins them with `AND`, and ranks with `bm25()`, so every term must appear in a page and FTS5 operators inside the query are searched for rather than applied. A query shorter than three characters matches nothing, and `type`, `tags`, and `status` narrow the same query: `type` and `status` match exactly, and each requested tag must appear as a whole word.

The cache is derived, never a source of truth. Rows are reproduced from the page files, `reconcile()` re-reads only the rows whose file mtime changed and drops the rows whose page is gone, and `rebuild()` drops and repopulates everything. The index lives at `<vaultRoot>/.wiki/index.db`, is created with owner-only permissions, and carries its own SQLite `application_id` and derived schema version: a file belonging to another application is refused rather than overwritten, and a cache written by an older derived schema version is reset in place. An unusable database is discarded and reopened once; when it stays unusable, a search answers with no hits instead of failing the tool call.

The tokenizer is `trigram` (`tokenize = 'trigram'`), which indexes every three-character sequence and is the only built-in FTS5 tokenizer that matches Chinese text; the default `unicode61` treats a whole CJK run as one token and returns no hits for a substring query. `title`, `body`, `tags`, `type`, `status`, and `updated` are indexed, while `path` and `mtime_ms` are carried unindexed for row lookup and reconciliation. A hit carries at most 200 code points of body text around the first matching term, with an ellipsis at each cut edge, and a shorter body is returned whole.

-----

<a id="web-knowledge-page"></a>
## The Web Knowledge page

`./web` and `./client` add the Knowledge entry to the sidebar panel rail, the `wiki-vault` main panel it opens, and a frame-wide host for the page's transient notices. The page reads and writes the same vault the tools do, through this plugin's own `POST` routes under `/api/prism-wiki`: `list`, `read`, `search`, `save`, `source`, and `lint`. Every answer is one envelope, `{ ok: true, value }` or `{ ok: false, error: { code, message } }` with HTTP 400, and the page branches on `prism-wiki/revision-conflict` and `prism-wiki/not-found`.

The page has three tabs. **Page** shows the vault tree grouped by kind with type and status filters, renders the selected page as markdown with clickable wikilinks, lists its backlinks, opens any cited raw source in place, and edits its frontmatter and body. A save echoes the revision it loaded; a conflicting save keeps the draft, reports the conflict in place, and shows the stored body beside it; and a save that carries no revision is refused once the vault already holds that path, so a draft can only create a page rather than replace one it never read. Following a wikilink that resolves to no page opens a draft for the name it asked for. A new page's path follows its title and kind until the reader types one, `overview.md` opens on first load when the vault has it, and a narrowed viewport folds the catalog behind its own toggle. **Search** ranks literal hits, 20 by default. **Health** runs the lint pass and lists every finding under its localized kind label.

The row injects `wikiVault`, `connection`, and `webServer`, so a profile that composes the Connection without a web server leaves the row pending instead of failing it.

-----

<a id="verification"></a>
## Verification

These are the repository commands that cover this package.

```sh
pnpm run test
pnpm run typecheck
pnpm run test:docs
pnpm run verify-translation-pairing packages/prism/prism-wiki/README.md
```

- `pnpm run test` runs the unit suite: `tests/vault.spec.ts` against real temporary vault directories, `tests/search.spec.ts` against a real FTS5 database file, `tests/tools.spec.ts` and `tests/commands.spec.ts` through the real registries, `tests/service.spec.ts` over the vault service's own seams, `tests/web.spec.ts` through the real Connection Fetch registry, `tests/client-api.client.spec.ts` over the browser client, `tests/client-page.client.spec.tsx` over the page in jsdom, and `tests/composition.host.spec.ts` booting the shipped rows through the vendored Loader.
- `pnpm run typecheck` compiles the host and client programs against the checkout.
- `pnpm run test:docs` runs the documentation gates: pairing, wrap, links, budgets, and the package-README checks.
- `pnpm run verify-translation-pairing packages/prism/prism-wiki/README.md` checks this README pair alone.

The package meets the repository's per-file coverage gate: `test:coverage` reports 100% statements, branches, functions, and lines for every file under `src/`, with `src/client/index.tsx` exempted as the browser entry.

-----

<a id="installation"></a>
## Installation

The package declares `dsh.bundle.patch`, so `dsh plugin` reconciles it as a profile layer instead of mounting one plugin. Install the tarball into a profile, then restart that profile.

```sh
dsh plugin --profile <profile> add /absolute/path/to/prism-prism-wiki-0.1.0.tgz
dsh --profile <profile>
dsh plugin --profile <profile> remove @prism/prism-wiki
```

The patch inserts four rows, and each row's package owns its behavior.

- `prism-wiki` registers `ctx.wikiVault` with the vault root and the three bounds.
- `tool-prism-wiki` registers the five model-facing tools.
- `command-prism-wiki` registers `/wiki`.
- `web-prism-wiki` registers the browser routes and the Knowledge page.

The profile needs the services those rows inject: `systemPrompt` for the vault row, `tools` for the tool row, `commands` for the command row, and `connection` plus `webServer` for the Web row. A profile without the Web Connection leaves the Web row pending rather than failing, so a headless profile carries the service, the tools, and the command without a page. Client modules are scanned at startup, so the page appears after the profile restarts.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

One fixed section named `prism-wiki` at prompt order 2550, inside the tool-guidance band between the goal section and the workflow section. Its text is `protocolSection`, read from configuration on every assembly.

##### Shipped protocol text

```markdown
A wiki vault is a persistent, interlinked body of markdown pages that is compiled once and kept current, instead of being re-derived per question. Three layers: `raw/` holds immutable sources; `wiki/` holds the pages you own; `AGENTS.md` holds this vault's conventions. This vault's conventions are handed to you the first time you touch the vault in a session; follow them for every page you write. Ingest: read a source with `wiki_source`, then write or revise every page it changes with `wiki_write`. One source commonly touches several pages. Query: find pages with `wiki_search`, read them with `wiki_read`, and answer from them. A good answer is worth filing back as a page. Lint: run `wiki_lint` periodically and act on what it reports.
```

#### Token effect

One short paragraph on every request while the plugin is loaded; the vault's own schema text is not part of it.

#### KV Cache effect

Prefix-stable while `protocolSection` and the sections ordered above it stay unchanged; editing either one invalidates reuse from that point on.

### Vault conventions frame

#### What the model sees

After any `wiki_*` tool call, the next step of that session carries one extra user message: it opens with `<prism-wiki-schema>`, carries the vault's `AGENTS.md` text, and closes with "These are this vault's conventions. Follow them for every page you write." The debt is cleared when the frame is delivered, and `schemaDeliveryEnabled: false` suppresses the frame entirely. A vault that cannot supply the schema — no `AGENTS.md`, no configured root — settles the debt without a frame instead of failing the step; any other read failure still propagates.

#### Token effect

Conditional: absent on a step that follows no wiki tool call, and bounded by the size of the vault's `AGENTS.md` on the steps that carry it.

#### KV Cache effect

Append-only at the tail: the frame is one new message after the existing history, so it leaves the earlier prefix reusable.

### Model-facing tools

#### What the model sees

Five tool definitions, `wiki_search`, `wiki_read`, `wiki_write`, `wiki_source`, and `wiki_lint`, with the parameter and output schemas the table above describes.

#### Token effect

Five fixed definitions on every request while the tool row is mounted; the `/wiki` command adds none.

#### KV Cache effect

Prefix-stable while tool visibility and the definitions stay unchanged; mounting or removing the tool row rewrites the tool block and invalidates reuse from there.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current constraints of the layer, not a general comparison.

- **Retrieval is literal, not semantic** — `trigram` matches three-character substrings, so a paraphrase that shares no three-character run with a page is missed; there are no embeddings and no reranker, and every query needs at least three characters.
- **A hit is an excerpt, not a page** — `wiki_search` returns at most 200 code points of body text per hit, so the model must call `wiki_read` for anything it will quote or revise.
- **The vault is written outside the session workspace** — the plugin uses `node:fs/promises` directly, and the shipped root is `dshHomePath('knowledge')`, so the model's own file tools neither reach nor confine the vault; the wiki tools are its write path.
- **Conflict protection is one revision check** — writes are atomic and mutating operations on one vault instance serialize, but nothing arbitrates two harness processes over one vault, and `expectedRevision` is the only guard against a lost update.
- **No page or source deletion** — neither the tools nor the Knowledge page deletes, moves, or renames a page, so the schema's answer to a rename is an alias on the new page, and a raw source can only be added.
- **`wiki_source add` refuses an existing path** — a registered source is immutable (`WIKI_REVISION_CONFLICT`), so revising a raw source means registering it under a new path.
- **The lint report sees only pages and raw sources** — a page reachable only from the generated `index.md` still counts as orphaned, and a name fewer than three pages ask for is reported only as `broken-link`, never as `missing-page`.
- **The vault schema is seeded once and never regenerated** — `AGENTS.md` receives the shipped template only when the file is absent, so a later improvement to the template does not reach an existing vault.
- **`updated` is stamped by the writer** — `wiki_write` stores the current UTC date, and the frontmatter parser only checks its `YYYY-MM-DD` form, so a page's date is a record of the write and not of the content.
- **The browser half is not exercised end to end** — component specs render the page in jsdom, so nothing here boots the assembled Web page against the Host routes.
- No runtime invariant companion is published because this package owns no relationship whose observations can diverge.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Prism owns this package; the service keeps the DSH `ctx.wikiVault` key. The bundle carrier is one package that also publishes the service, tool, command, and browser rows it inserts, so this README follows the bundle template while its Model Experience section stays structured: the system prompt, the schema frame, and the tool definitions are this package's own contributions.

</details>
