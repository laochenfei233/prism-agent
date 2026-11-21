---
feature: prism-wiki
status: in-progress
updated: 2026-11-21
branch: feat/prism-wiki
commits: not recorded; delivery records the base..head range
---

# Prism Wiki

English | [中文](prism-wiki.zh.md)

## Report

**What was built** — `@prism/prism-wiki` maintains a markdown knowledge vault at `<DSH home>/knowledge`: immutable `raw/` sources, model-owned `wiki/` pages, a co-evolved `AGENTS.md` schema, a generated `index.md`, an append-only `log.md`, and a plugin-private `.wiki/` holding a rebuildable SQLite FTS5 cache. Five model tools register through `ctx.tools.register`, `/wiki` is the operator surface, six Host Fetch routes carry the Web Knowledge page, and the package ships as a prebuilt mirror at `plugins/prism-wiki`.

The Web page now closes its own loop rather than only displaying the vault: a cited raw source opens in place, a wikilink that resolves to no page opens a draft for the name it asked for, a new page's path follows its title and kind until the reader types one, `overview.md` opens on first load, a new draft refuses a path the vault already holds, a refused save shows the stored body beside the retained draft, and a narrowed viewport folds the catalog behind its own toggle.

**Verification** — `npx vitest run packages/prism/prism-wiki` passes 146 tests across eight suites, including a real-Loader composition that boots all four shipped rows with the browser row over a real Connection and calls every one of the six routes; `tsc -b` reports zero diagnostics for both faces; `oxlint` reports no findings in the package; `verify-package-dependencies` matches the policy after two reviewed safe-export classifications and one removed runtime import; `verify-doc-budgets`, `verify-client-ui-i18n`, `verify-export-jsdoc`, the README summary gate, `verify-agent-note-format`, and the README pairing gate pass. Not met: the repository's per-file coverage gate. `test:coverage` still reports 667 uncovered locations across eight source files — 268 in `src/client/WikiPage.tsx`, 193 in `src/vault.ts`, 71 in `src/search.ts`, 55 in `src/tools.ts`, 33 in `src/commands.ts`, and smaller counts in `src/client/api.ts`, `src/service.ts`, and `src/web.ts`. The browser entry `src/client/index.tsx` is exempted in `vitest.config.ts` beside the other client registrants, because no harness mounts the slot and locale services it registers into; the rest is recorded as open work.

**Journey log** — 1) The branch is based on the pre-resync import commit and sits 392 commits behind `master`; a dry-run merge shows only ten mechanical conflicts, so the resync stays deferred while the package scope was renamed to `@prism/prism-wiki` in this round to match `master`'s convention. 2) `verify-package-dependencies` blocked on three unclassified Host exports: `defineTool` and `createUserMessage` were reviewed and classified safe (both return plain frozen values with no module-local identity), and `CommandDefinitionId` was replaced with `brandString<CommandDefinitionId>` so the provider's runtime is no longer imported. 3) The schema frame read threw into the `agent/pre-step` waterfall, so a broken `AGENTS.md` could fail the very step it was preparing; it now settles the debt silently for vault-level failures and still propagates anything else. 4) The Web editor's "New page" wrote over an existing path because a fresh draft carries no revision to echo; the page refuses the write and names the existing page, and the save route enforces the same rule for any client. 5) `plugins/prism-wiki/README.i18n.yaml` had drifted from its README pair, which the pairing gate caught and this round re-recorded.

## [S1] Problem

Document work in this harness is retrieval-shaped. Raw files sit in a workspace, the model assembles an answer from fragments, and the assembled answer is discarded when the turn ends. Nothing accumulates, so a question that needs five sources synthesized is re-derived from scratch every time it is asked.

`prism-memory` stores one claim per record. It answers "what do we know" and cannot answer "what does this body of sources say, and where do the sources disagree", because it has no page-level artifact and no cross-references between pages.

Karpathy's llm-wiki pattern names the missing capability: three layers (immutable raw sources, an LLM-owned wiki of interlinked markdown pages, and a schema that makes the model a disciplined maintainer), three operations (ingest, query, lint), and two navigation files (a content catalog and an append-only log). The knowledge is compiled once and then kept current instead of re-derived per query.

Nothing in this tree provides that layout, that schema, those operations, or any way to read the result inside the product.

## [S2] Design

### Layers and layout

`vaultRoot` is a validated Config field defaulting to `<DSH home>/knowledge`. The plugin owns that directory; it creates the layout on first use and refuses to adopt a non-empty directory that is not already a vault.

```
$DSH_HOME/knowledge/          the vault — open this directory as an Obsidian vault
  AGENTS.md                   the schema: conventions the human and the model co-evolve
  index.md                    generated content catalog
  log.md                      append-only chronology
  raw/                        immutable sources, never modified by the plugin
    assets/                   locally downloaded images
  wiki/                       LLM-owned pages
    overview.md
    entities/  concepts/  sources/  comparisons/  syntheses/
  .wiki/                      plugin-private state, hidden from Obsidian and from git
    index.db                  SQLite FTS5 search cache, rebuildable, never authoritative
```

The vault is plain markdown with `[[wikilinks]]` and YAML frontmatter, so Obsidian, any editor, and git operate on it unchanged. `raw/` is read-only to the plugin: the source of truth is never rewritten.

### File access

Because the vault sits outside the session workspace, the model's own `read`, `write`, and `edit` tools cannot reach it: under `workspace-write`, the `fs-sandbox` backend admits a mutation only under the session workspace or a platform temporary root. The five `wiki_*` tools are therefore the model's only path to the vault, which is what makes frontmatter validation and derived-artifact maintenance enforceable rather than advisory.

Plugin-owned files are written with `node:fs/promises` directly, following the `prism-memory` export path: the sandbox fences model mutations, not trusted plugin code. Every write is atomic — a full write to a sibling temporary path, then a rename — so no reader observes a partial page.

### Page frontmatter

Required on every page: `title`, `type`, `tags`, `updated`, `status`. Optional: `sources` (raw paths this page cites), `aliases`, `confidence`, `contradicts` (page names this page disagrees with).

`type` is one of `overview`, `entity`, `concept`, `source`, `comparison`, `synthesis`; `status` is one of `current`, `stub`, `superseded`, `disputed`. `type` selects the directory, so a page's path and its frontmatter cannot disagree.

### Division of labor

The model reads sources, synthesizes, and writes pages. The plugin performs only mechanical, checkable work and never calls a model.

`index.md` and `log.md` are derived artifacts, not model responsibilities: the plugin regenerates the catalog from page frontmatter and appends one log entry per mutation. This is why the catalog cannot drift from the wiki and why the log stays parseable — neither depends on the model remembering to update it.

### Model-facing tools

Five tools, a deliberate bound for the same reason `prism-memory` holds at five: tool schemas sit in the cached prefix and are paid for on every request. Each registers through `ctx.tools.register` inside `ctx.effect`, so a disposed fiber removes all five.

| Tool | Contract |
|---|---|
| `wiki_search` | Ranked pages for a literal query, filterable by `type`, `tags`, and `status`; returns path, title, type, updated, and a matched excerpt |
| `wiki_read` | One page in full, plus its outgoing wikilinks, its backlinks, and the raw sources it cites |
| `wiki_write` | Creates or updates one page: validates frontmatter against the schema, writes atomically, then refreshes `index.md`, appends `log.md`, and updates the search index |
| `wiki_source` | The raw layer: `list` (sources with integration status), `read` (bounded source text), `add` (register a new source into `raw/`), `integrate` (mark a source integrated, recording the pages it touched) |
| `wiki_lint` | The health report: orphan pages, broken wikilinks, concepts referenced repeatedly with no page, sources not yet integrated, pages citing missing raw files, frontmatter violations, and unresolved `contradicts` pairs |

### Operator command

`/wiki` is the human surface and costs no tool schema: `status`, `lint`, `reindex`, `open <page>`, `log [n]`, `schema`. An unknown subcommand returns an error naming the usage.

### Schema delivery

The pattern depends on the schema being in context, but the vault's `AGENTS.md` is co-evolved and therefore changes — putting it in the system prompt would rewrite the cached prefix on every edit. The system-prompt section is instead a static protocol carrying the mechanics (layout, tool contract, frontmatter fields, workflows), byte-stable from Config.

The vault's own `AGENTS.md` is appended exactly once per session as a single tail frame on that session's first wiki tool call, through an `agent/pre-step` listener that calls `next()` first and appends to the returned decision. The `/wiki schema` operator command prints it on demand. A vault that cannot supply the schema — no `AGENTS.md`, no configured root — settles the debt without a frame instead of failing the step; any other read failure still propagates.

### The seeded schema

The template seeded at `vault/AGENTS.md` carries only what is domain-specific: which categories this wiki keeps, what earns a page of its own, how page files are named, how a source is cited, and the house style for a synthesis. It is the one part of the pattern the human and the model are expected to rewrite, and the plugin never regenerates it once it exists.

### Retrieval

Search is SQLite FTS5 over title, body, and frontmatter, opened lazily on the first search so startup stays quiet and `node:sqlite` is never imported by a session that does not search.

The tokenizer is `trigram`, not the FTS5 default. Measured on this toolchain (Node v24.19.0, SQLite 3.53.3): `unicode61` returns zero hits for a CJK query against CJK text, while `trigram` matches it. The vault is expected to hold Chinese pages, so the default tokenizer is unusable here.

The index is a cache and never authoritative. Each search reconciles file mtimes first, so an edit made in Obsidian or in the product is visible without a filesystem watcher; `/wiki reindex` rebuilds from files; a missing or corrupt index is rebuilt rather than reported.

### Concurrency

Four writers touch the vault: the model's tools, the Web page, an external editor, and git. Every plugin write is atomic. `wiki_write` accepts an optional `expectedRevision` (a content hash); a mismatch returns a conflict result carrying the current page and writes nothing, which is what the page sends after loading a page.

`index.md` and `log.md` are plugin-owned: the index declares `generated: true` and is regenerated rather than merged, and a hand edit to it is overwritten on the next mutation.

A stale `expectedRevision` is refused with a conflict that carries the stored page. The model reads it in the tool result, the Web save route carries it in its failure envelope, and the editor shows it beside the retained draft.

### The Web page

A Knowledge page joins the client as a keyed `main` entry paired with a `sidebar.panellist` row, registered through `ctx.slots.inject`, which is required when registering into another package's slot. The vault tree, renderer, search box, backlinks panel, editor, and health tab read through one inject face.

Rendering reuses `MarkdownText` with a memoized `MarkdownLabels` built from `t`. The page renders `[[wikilinks]]` itself, because `MarkdownText` has no wiki-link syntax. Transient save outcomes use the app-wide `Toast` hosted in a `shell.overlay` entry, which outlives the page.

The browser reaches the host over exact Fetch routes registered on `ctx.connection.fetch` under `/api/prism-wiki`, with validated request bodies and the `{ ok, value } | { ok, error }` envelope: `list`, `read`, `search`, `save`, `source`, and `lint`. A plugin-registered RPC channel is not available here: the channel service's own context does not inject `webServer`, so `ctx.connection.rpc.handle()` throws at load.

The page's editing loop follows the vault's own conventions instead of only displaying them:

- A cited raw source opens in place through the `source` route, which applies the same configured character cap the model's `wiki_source read` uses and reports truncation.
- Following a wikilink that resolves to no page opens a draft for the name it asked for: the target's title, and its path derived from the directory the link named, or `concepts/` for a directory this vault does not own.
- A new draft's path follows its title and kind while the path is still the derived one; a path the reader typed is never overwritten.
- `overview.md` opens on first load when the vault holds it.
- A new draft whose path the vault already holds is refused with the path named, because it carries no revision to compare and would otherwise replace that page silently. The `save` route enforces this itself, so any browser client is held to it, and a stored page it cannot parse is refused rather than replaced unseen.
- A refused save keeps the draft, reports the conflict in place, and shows the stored body beside it.
- Under 767px the catalog column folds behind its own toggle, and the two-column layout becomes one.

All product copy reaches presentation through a typed locale dictionary registered with `ctx.locale.register`.

### Where the plugin lives

Source is `packages/prism/prism-wiki`, a workspace package. The Web half cannot be built from anywhere else: `clientBundle()` in `packages/client/tsdown.client.ts` resolves a client package by globbing `packages/*/*/package.json` and fails the build for any other location, the root tsdown workspace and the root vitest include never reach `plugins/*`, and `verify-client-ui-i18n` discovers sources under `packages/*/*/src/client` only. Authoring under `plugins/` would forfeit the supported client build, the copy gate, and root test collection.

`plugins/prism-wiki` is the shipped copy: `lib/`, `cordis.patch.yml`, `LICENSE`, and the README trio, with sources absent, matching `plugins/prism-meeting`. `apps/desktop/scripts/bundle-runtime.mjs` already strips `src`, `tests`, `scripts`, and `*.ts` when it collects `plugins/*` into the desktop runtime.

`packages/prism` is a new package group, so `packages/README.md` gains its row in the same change.

## [S3] Scope

- In scope: the `packages/prism` group row, the `packages/prism/prism-wiki` workspace package, the vault layout and schema template, frontmatter validation, the five tools, the `/wiki` command, the FTS5 index, the system-prompt section and the vault schema tail frame, the host Fetch routes, the Web page and its locale dictionaries, unit and real-composition tests, the package README trio, the mirror at `plugins/prism-wiki`, and the Agent Note recording the plugin's ownership and location.
- Out of scope: no graph view, because Obsidian's graph view is the intended tool for the shape of the wiki; no embeddings, vector store, or reranker, because retrieval is literal FTS5 ranking and the pattern holds that the catalog plus a plain search is enough at this scale; no filesystem watcher, because external edits are reconciled per search; no automatic ingestion and no scheduled lint, because ingest and lint are model- or operator-initiated; no slide-deck, chart, or canvas export formats; and no modification of, merge with, or dependency on `prism-memory`.

## Tasks

- [x] T1: Register the `packages/prism` group and scaffold `packages/prism/prism-wiki` — acceptance: the package builds through `pnpm run build` and its `exports` cover `.`, `./client`, `./web`, and `./cordis.patch.yml` (covers: S2 Where the plugin lives; depends: none)
- [x] T2: Vault core — layout creation and adoption guard, frontmatter schema and validation, atomic read/write, wikilink and backlink resolution, revision hashing — acceptance: specs cover creation, adoption refusal, a rejected frontmatter, an atomic write, and a revision mismatch (covers: S2 Layers and layout, Page frontmatter, File access; depends: T1)
- [x] T3: Derived artifacts — `index.md` generation from frontmatter, `log.md` append, the seeded `AGENTS.md` template — acceptance: one `wiki_write` leaves both derived files consistent, and an edited schema is not regenerated (covers: S2 Division of labor, The seeded schema; depends: T2)
- [x] T4: Search index — FTS5 with the trigram tokenizer, lazy open, mtime reconciliation, the rebuild path — acceptance: a CJK query returns its page, an external edit is visible on the next search, and `reindex` restores a deleted index (covers: S2 Retrieval; depends: T2)
- [x] T5: Model tools — `wiki_search`, `wiki_read`, `wiki_write`, `wiki_source`, `wiki_lint` — acceptance: all five register through `ctx.tools.register` inside `ctx.effect` and a disposed fiber removes them (covers: S2 Model-facing tools; depends: T2, T3, T4)
- [x] T6: Schema delivery — the static system-prompt section and the once-per-session vault schema tail frame — acceptance: the section's bytes are identical across two requests, and the vault schema is appended exactly once per session (covers: S2 Schema delivery; depends: T2)
- [x] T7: Operator command `/wiki` — acceptance: each of `status`, `lint`, `reindex`, `open`, `log`, and `schema` returns a result, and an unknown subcommand returns an error naming the usage (covers: S2 Operator command; depends: T5)
- [x] T8: Host Fetch routes — acceptance: a malformed body returns the `{ ok: false, error }` envelope, and a save carrying a stale `expectedRevision` returns the conflict code (covers: S2 The Web page, Concurrency; depends: T2, T4)
- [x] T9: Web page — vault tree, renderer, wikilink navigation, backlinks, search, editor, health tab, and locale dictionaries — acceptance: the page registers into `main` and `sidebar.panellist` through `ctx.slots.inject`, and every product string resolves through the typed `t` seat (covers: S2 The Web page; depends: T8)
- [x] T10: Tests — vault core, frontmatter validation, CJK search, lint findings, write conflict, registration and disposal, a real-composition mount of the production services, and the client page — acceptance: the suite passes and the real-composition spec drives the mounted services (covers: S2, S4; depends: T5, T9)
- [x] T11: Packaging — build configuration, `cordis.patch.yml`, the mirrored `plugins/prism-wiki`, and the artifact smoke — acceptance: `node scripts/smoke.mjs` passes against the emitted `lib/`, and the mirror holds `lib/`, `cordis.patch.yml`, `LICENSE`, and the README trio with no sources (covers: S2 Where the plugin lives; depends: T5, T9)
- [x] T12: Documentation — the package README trio with Summary, configuration, tool contracts, Model Experience, Known Limitations, and the verification section, plus the Agent Note for the plugin's ownership and location — acceptance: the pairing gate passes for the README trio and `verify-agent-note-format` passes for the note (covers: S3; depends: T11)
- [x] T13: Verification and independent review — acceptance: every criterion in S4 carries a command output or a `file:line` reference (covers: S4; depends: T10, T11, T12)
- [x] T14: Close the dependency gate — acceptance: `verify-package-dependencies` exits zero after `defineTool` and `createUserMessage` are reviewed safe exports and `CommandDefinitionId` is built with the shared brand helper (covers: S2 Model-facing tools, Operator command; depends: T13)
- [x] T15: Make the schema frame non-fatal for vault-level failures — acceptance: a missing `AGENTS.md` and an unset `vaultRoot` each leave the step entering without a frame, and an unexpected read failure still rejects the step (covers: S2 Schema delivery; depends: T2)
- [x] T16: Serve raw sources to the page — acceptance: the `source` route returns a cited source's text and truncation, answers `prism-wiki/not-found` for a missing source, and rejects a malformed body (covers: S2 The Web page; depends: T8)
- [x] T17: Close the page's editing loop — acceptance: an unresolved wikilink opens a draft at the derived path, a new page's path follows its title and kind until typed, `overview.md` opens on first load, and an existing path is refused instead of overwritten (covers: S2 The Web page; depends: T9)
- [x] T18: Show a refused save beside the stored page and fold the catalog on a narrow viewport — acceptance: a conflict renders the stored body beside the retained draft, and the catalog toggle reports its expanded state (covers: S2 The Web page; depends: T9)
- [x] T19: Refresh the shipped documentation — acceptance: the README trio quotes the shipped protocol text, lists the six routes and the page's editing loop, names the suites that cover the package, and re-records the pair so the mirror's sidecar is current (covers: S3; depends: T16, T17, T18)
- [x] T20: Rename the package scope to `@prism` — acceptance: no `@prism-ai/prism-wiki` remains in the package, the mirror, the docs, the tsconfig aliases, or the generated client catalog; the emitted bundle registers under `@prism/prism-wiki`; the lockfile stays consistent (covers: S2 Where the plugin lives; depends: T19)
- [x] T21: Prove the shipped rows are callable together — acceptance: a real-Loader composition boots all four rows with the browser row over a real Connection, every one of the six routes answers, and a tool-written page is visible to the browser route while a browser save is visible to the model-facing tool (covers: S2 The Web page; depends: T20)

## [S4] Acceptance

- [x] A vault is created at `vaultRoot` with the documented layout, and the plugin refuses to adopt an unrelated non-empty directory.
- [x] `wiki_write` creates and updates a page, rejects frontmatter that violates the schema, and leaves `index.md` and `log.md` consistent without a second call.
- [x] A search for a CJK query returns the page containing it, and a search after an external edit to a page on disk returns the edited text.
- [x] `wiki_lint` reports a seeded orphan page, broken wikilink, unintegrated source, and unresolved `contradicts` pair.
- [x] `wiki_write` with a stale `expectedRevision` returns a conflict carrying the current page and writes nothing.
- [x] The five tools register and dispose cleanly, and the system-prompt section's bytes do not change between requests.
- [x] The vault schema is appended exactly once per session, at the request tail.
- [x] The Web page lists the vault, renders a page, follows a wikilink, shows backlinks, searches, and saves an edit that is then visible on disk.
- [x] No product string on the Web page bypasses the typed locale dictionaries.
- [x] `plugins/prism-wiki` mirrors the built package: `lib/`, `cordis.patch.yml`, `LICENSE`, and the README trio, with no sources.
- [x] The README trio records a consistent pair, and the Agent Note passes its format and classification gates.
- [x] The package typechecks, its suite passes, and the repository gates covering `packages/prism/prism-wiki` and this document pass.
- [x] The vault schema frame is skipped, not fatal, when the vault cannot supply it, and an unexpected schema read failure still fails the step.
- [x] A cited raw source opens in the page at the same character cap the model's tool applies, and a missing source answers `prism-wiki/not-found`.
- [x] Following an unresolved wikilink opens a draft with the target's title and its derived path; a new draft's path follows its title and kind until the reader types one.
- [x] A new draft whose path the vault already holds is refused, the page does not call the save route, and the route itself refuses a revisionless write over an existing page.
- [x] A refused save renders the stored body beside the retained draft, and the catalog toggle reports its expanded state.
- [ ] The package meets the repository's per-file coverage gate (`test:coverage`) for every source file it ships.
- [x] The package name is `@prism/prism-wiki`, and no reference to the old scope survives in sources, the mirror, the docs, the path aliases, or the generated slot catalog.
- [x] The four shipped rows compose through the real Loader, all six browser routes answer over the real Connection, and the tools and the routes read and write one vault.
