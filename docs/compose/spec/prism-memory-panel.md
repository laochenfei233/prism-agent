---
feature: prism-memory-panel
status: delivered
updated: 2026-11-01
branch: feat/prism-memory-panel
commits: c22ec9f0b9..67c8302650
---

# Prism Memory Operator Surface

English | [中文](prism-memory-panel.zh.md)

## Report

**What was built.** A person can now read and write long-term memory without spending a model turn. `/memory remember <text>` stores a claim of their own, `/memory search <query>` finds one by keyword, `/memory forget <id>` retires one, and the Web host gains a memory page: counts over the whole corpus, a keyword search, an add form, the review inbox with approve and reject handed out oldest decision first, and the live claims.

The page has no calling session, so it reads and settles through four new agent-less service methods — `operatorRecords`, `operatorSearch`, `operatorApprove`, `operatorReject` — behind four exact Fetch routes on Connection's shared `/api` channel, whose paths come from one shared module both faces import. Model-facing callers are untouched: a tool passes the agent it runs in and `/memory` passes the one it was invoked from, and both are still narrowed by it. The browser half is an out-of-tree module-loader closure that requests React and the shared primitives as baseline modules, so the shell keeps one copy of each, and the two compiler faces keep the DOM library out of the Host half.

The model surface did not move: no tool, no prompt byte, no injected frame.

**Verification.** In the worktree `plugins/prism-memory`: `tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.client.json --noEmit` both exit 0; `vitest run --config vitest.config.ts` passes 13 files and 178 tests (the baseline before this change was 9 files and 146 tests); `tsdown --config tsdown.config.ts` emits the four Host modules plus `lib/client.js`; `node scripts/smoke.mjs` passes, including a check that loads the browser bundle through a stand-in module loader, runs its `apply`, and asserts both slot registrations. `pnpm run build:artifacts` passes in the worktree, which the out-of-tree typecheck depends on. `pnpm run verify-translation-pairing` reports both the README pair and this document's pair consistent, and the repository's pre-commit hooks (translation pairing, lint on staged files, whitespace, vendor guard) pass on both commits.

**Journey log.**

1. The plugin's own Vitest config named `scripts/test-invariants.ts`, which the rc.4 resync deleted, so no spec could start at all. Repairing that was the first change, and it is what made the 146-test baseline measurable.
2. An out-of-tree browser half cannot use `packages/client/tsdown.client.ts` (a workspace preset) or a CSS pipeline, so the bundle reproduces the module-loader closure by hand after `plugins/prism-about`, and the page owns a stylesheet string of shell tokens.
3. The review turned the feature around once: the two new human write surfaces could create a claim no human surface could retire, because `/memory reject` settles only pending records and `memory_forget` is a model tool. That produced `/memory forget` and the paragraph stating that a page-added claim is `global`.
4. Three surfaces answered "most recent" three different ways — the tool, the command, and the page. The command now makes the same `memory.search` call the tool does, and the page keeps its own live-corpus read and the queue head.
5. The wire, the spec, and the API docs drifted from the code in four places the review caught; each is now stated once and matches what the routes do.

## [S1] Problem

`@prism/prism-memory` has no surface a person can read or write directly. `/memory` governs — status, review, approve, reject, restore, maintain, dream, journal, import, export — but it cannot author a claim and cannot find one: `show` needs an id, and an id only appears in `review` or `conversations` output. Writing without a model turn is impossible, and the Web host has no memory page at all.

The comparison target is the third-party plugin `omdsh-dev/dsh-mnemon`, which pairs its memory store with a person's own surface: a sidebar memory system page, a per-reply bar listing what that turn read and wrote, and a one-click capture that hands a candidate to an agent for dedupe, refinement, and a write. Its store, retrieval, distillation, and consolidation overlap what this plugin already ships, so the reference value is the human-facing half, not the storage half.

Memory reads and writes are already visible in a transcript — an injected frame arrives as a context message, and a model write is a tool call — so the missing capability is a place where a person can look at the corpus, search it, settle the review inbox, and add a claim without spending a model turn.

## [S2] Design

### S2.1 Operator reads and review settlement in the service

Scope authority does not change: every model-facing tool and every `/memory` subcommand keeps passing its calling agent, and `admission(agent)` still decides what it may see. A browser route has no calling session, so the service gains four agent-less methods that read and settle the whole store, following the precedent of `maintain`, `dream`, `importMemories`, and `exportMarkdown`, which are already whole-store operations:

- `operatorRecords()` — every stored record, newest first, including pending and archived ones, because a governance surface must show what it is governing.
- `operatorSearch(query, options)` — the same BM25 ranking and status set `search` uses, without a scope filter.
- `operatorApprove(id, note?)` and `operatorReject(id, reason?)` — the review settlement of `approve`/`reject`, without a scope filter.

The private `require` is split into a scope-taking wrapper and a `requireIn(id, admission)`, so both surfaces call one implementation. An operator write reuses the public `remember` with `origin: 'operator'`, which keeps write-time dedupe, tag derivation, and the capacity check on one path.

### S2.2 Four routes on Connection's shared API channel

A new Host row `@prism/prism-memory/web` registers exact Fetch routes under `/api/prism-memory` through `ctx.connection.fetch.register`, the same mechanism other feature packages use. The three routes that carry a body validate it with zod; `overview` reads none. Every route answers one envelope: `{ ok: true, value }` or `{ ok: false, error: { code, message } }` at HTTP 400.

    POST /api/prism-memory/overview  -> { counts: { total, byStatus, byLayer }, pending, recent }
    POST /api/prism-memory/search    -> { rows }
    POST /api/prism-memory/remember  -> { row, outcome, duplicates }
    POST /api/prism-memory/review    -> { row }

`overview` answers one round trip for the page's initial state: counts computed over the whole store, the head of the pending queue with the oldest decision first, and the newest live claims. Row caps live in this row, not in the service, so the read stays whole and the transport decides how much of it crosses the wire.

### S2.3 The browser half

The plugin gains a browser entry that reproduces the shell's dynamic-bundle contract by hand, because this bundle is out of tree and `packages/client/tsdown.client.ts` is a workspace preset. The bundle registers two contributions: a `sidebar.panellist` glyph and the `main` page keyed by panel id `memory`.

The page shows the counts, a search field, an add form, the review inbox with approve and reject, and the record list, with loading, empty, and failed states. Controls come from the shared `@deepseek-ai/dsh-client-ui-primitives` baseline; the page owns a stylesheet string, because an out-of-tree bundle has no CSS pipeline, and consumes the shell's `--dsw-*` tokens so it follows the active theme. Copy lives in one locale namespace registered under `prismMemory.panel`.

### S2.4 Three human subcommands

`/memory remember <text>` stores the operator's own claim with `origin: 'operator'` and prints the id it landed on; `/memory search <query>` renders the ranked lines `memory_search` would render, narrowed to the invoking session's scope; `/memory forget <id> [reason]` retires one live claim, so a person can both add and retract without a model turn. All three are thin adapters over existing service methods, and none costs a tool schema.

### S2.5 The model surface does not move

The panel and the three subcommands add no tool definition, no system-prompt bytes, and no injected frame. The five tool schemas, the protocol section, and the tail rule stay exactly as they are, so `tests/cache-safety.spec.ts` keeps holding without an edit to it.

### S2.6 Deliberately not taken from dsh-mnemon

- A provider ecosystem for external memory services: this plugin's store is the profile's storage domain, and a provider abstraction with one provider is speculation.
- Pluggable source and strategy components on a plugin page: the search policy is one function, and split into components it would be configuration without a second implementation.
- Storage placement choice and ZIP backup: the storage domain and the Markdown mirror already own that, and a separate backup feature is being built elsewhere.
- An entity graph and an agent that answers from memory: topic digests already cluster the corpus, and memory search is one tool call away.
- A per-reply memory bar: a read is already a context message and a write is already a tool call in the transcript, so the bar would restate what the conversation shows.
- User-editable memory files as a third source of truth: the Markdown mirror stays an export, because a hand-edited file and the domain would need a merge owner neither has.

## [S3] Scope

- In scope: the four operator service methods, the browser routes and their wire contract, the browser half and its build and manifest changes, the three `/memory` subcommands, the model-facing documentation, and the tests for all of it.
- Out of scope: any change to the record schema, the retrieval model, the injection frame, the tool surface, the protocol text, the import layouts, and the consolidation passes.

## Tasks

- [x] T1: Add the four operator methods to the service with a shared `requireIn`, and cover them in `tests/service.spec.ts` (depends: none)
- [x] T2: Add `src/web-contract.ts`, `src/routes.ts`, and the `src/web.ts` route row, wire the row into `cordis.patch.yml`, and cover it with a Loader composition spec (depends: T1)
- [x] T3: Add the browser half: manifest and `dsh.client`, the two tsconfig faces, the tsdown client bundle, the locale dictionary, the request client, the page and styles, the glyph, and the registration (depends: T2)
- [x] T4: Add `/memory remember`, `/memory search`, and `/memory forget`, and a spec that drives `/memory` end to end through the real command runtime (depends: T1)
- [x] T5: Update `README.md`, `README.zh.md`, and the pairing record; update the design note in `preview/` where it states the command and panel surfaces (depends: T3, T4)
- [x] T6: Run the package typecheck for both faces, the suites, the build, and the smoke script in the worktree (depends: T3, T4, T5)
- [x] T7: Independent review of the complete change, then finalize this document (depends: T6)

## [S4] Acceptance

- [x] `/memory remember <text>` stores one claim with origin `operator` in the caller's default scope, and prints its id.
- [x] `/memory search <query>` renders ranked lines carrying layer, kind, scope, date, and originating session, and an empty query lists the most recent claims.
- [x] `/memory forget <id>` retires a live claim the person wrote, so a human can both add and retract without a model turn.
- [x] A caller with no session can read project- and conversation-scoped records and can approve or reject one, which `visible` and `approve` cannot do today.
- [x] The review inbox hands out the head of the pending queue, oldest decision first.
- [x] The four routes answer their envelope; the three that carry a body reject an invalid one with an error code; none throws out of the route.
- [x] The web row activates over a real web server and connection through the Loader, and stays pending in a profile that composes neither.
- [x] The page registers into `sidebar.panellist` and `main`, and renders counts, search results, review actions, the add form, and the three states.
- [x] The five tool schemas, the protocol section, and the injected frame are byte-identical to the previous build.
- [x] The two typecheck faces, the package suites, the tsdown build, and `scripts/smoke.mjs` pass in the worktree.
