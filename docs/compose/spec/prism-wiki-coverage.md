---
feature: prism-wiki-coverage
status: designed
updated: 2026-11-21
branch: feat/prism-wiki
commits: not recorded; delivery records the base..head range
---

# Prism Wiki Coverage

English | [中文](prism-wiki-coverage.zh.md)

## Report

Not delivered. The measurement in S1 is the state this plan starts from.

## [S1] Problem

The repository gates coverage per file: `vitest.config.ts` sets `perFile: 100` for statements, branches, functions, and lines under `packages/*/*/src`, and CI runs that rule through `check:ci:coverage`, which merges the partitioned runs before one threshold check. A package that misses it cannot pass a pull request.

After the resync, `@prism/prism-wiki` reports **660 uncovered locations across eight source files**:

| Source | Uncovered |
|---|---|
| `src/client/WikiPage.tsx` | 268 |
| `src/vault.ts` | 193 |
| `src/search.ts` | 71 |
| `src/tools.ts` | 48 |
| `src/commands.ts` | 33 |
| `src/client/api.ts` | 18 |
| `src/service.ts` | 16 |
| `src/web.ts` | 13 |

These are not missing features. Every suite drives its feature's main path; what is uncovered is the second and third branch of code that already ships: a parser's rejected spellings, an error class that only a hostile file produces, a route's unexpected-failure mapping, an optional argument's absent arm, and the page states a reader reaches by choosing another tab or clearing a filter. The package's README records the debt, and its earlier rounds even claimed the tool, command, route, and browser halves had no direct specs.

## [S2] Design

### The rules this plan holds to

1. **Tests describe behaviour, through real compositions.** A case drives the same surfaces the product composes: a temporary vault on disk, the real registries, the real route handlers, and the page in jsdom. No production-only test hooks, no mocks of the code under test.
2. **Delete an unreachable branch instead of testing it.** A branch that cannot run for a reason the type system enforces (an impossible state behind a typed boundary) is removed. Validation at a trust boundary — queued input, model/tool JSON, files on disk, wire bodies — stays and gains a test.
3. **An exemption carries a reason.** A file may leave the gate only with a comment in `vitest.config.ts` and a line in the package README. The one current exemption is the browser registrant `src/client/index.tsx`, because no harness mounts the slot and locale services it registers into.
4. **No behaviour change.** Shipped code changes only by deleting a dead branch, or by fixing a defect a new test exposes; a fix lands as its own commit with a regression test.

### What each file's missing tests drive

- `src/commands.ts` — every `/wiki` subcommand through the real command registry, including `log` with and without a count, an unusable count, and an unknown subcommand's usage text; the error mapping for a vault failure.
- `src/web.ts` — each route's failure arms: a malformed body per route, a stored page whose frontmatter cannot be parsed, an unexpected error that must not masquerade as a wiki failure, and the optional search fields present and absent.
- `src/service.ts` — the pre-step listener declining a rejected or aborted step, `schemaDeliveryEnabled: false`, a call without an agent, and a vault with no configured root.
- `src/client/api.ts` — the wire narrowing that rejects a wrong numeric, boolean, nullable, or union field, one case per reader.
- `src/tools.ts` — `wiki_source`'s missing-argument arms, a page-existence probe meeting each error class, and an unexpected error propagating instead of becoming a result.
- `src/search.ts` — a database belonging to another application, an unreadable database that is replaced once, the rollback path, `rebuild` over an empty and a populated set, and the excerpt and matcher edge cases.
- `src/vault.ts` — the parser's rejected spellings (missing delimiter, unclosed block, scalar where a list is required, out-of-range confidence), each frontmatter field's failure, the unreadable-page walk, and the path guards that refuse a traversal or a file where a directory belongs.
- `src/client/WikiPage.tsx` — the states a reader reaches: an empty vault, a failed list and a failed page read, each filter and the cleared filter, a collapsed group, the search tab idle/searching/empty/hit states, the health tab before and after a pass, every editor field, the source panel's loading, truncated, and failed states, and the wikilink rewriter's fenced-code and code-span arms.

### Order

Cheapest first, so the gate's remaining surface shrinks with every commit: `client/api` (18), `web` (13), `service` (16), `commands` (33), `tools` (48), `search` (71), `vault` (193), then `WikiPage` (268). Shared fixtures come first so the two large files do not grow their own copies.

## [S3] Scope

- In scope: the test additions above, the fixtures they share, the deletions of branches that cannot run, and any defect fix a new test exposes; the README and spec updates that record the result.
- Out of scope: new features or behaviour changes, the coverage threshold itself, other packages' coverage debt, and hand-writing a slot/locale harness for the browser registrant.

## Tasks

- [ ] T1: Shared fixtures — a malformed-frontmatter table, a corrupt and a foreign search database, and a page builder; acceptance: each helper is used by at least two suites and carries JSDoc (depends: none)
- [ ] T2: `client/api.ts` at 100% — one rejection case per field reader (depends: T1)
- [ ] T3: `web.ts` at 100% — each route's failure arms, including an unparsable stored page and an unexpected error (depends: T1)
- [ ] T4: `service.ts` at 100% — the pre-step decline paths and the schema-delivery switches (depends: T1)
- [ ] T5: `commands.ts` at 100% — every subcommand and argument arm through the command registry (depends: T1)
- [ ] T6: `tools.ts` at 100% — missing arguments, error classes, and unexpected-error propagation (depends: T1)
- [ ] T7: `search.ts` at 100% — foreign, unreadable, and empty databases plus the excerpt edges (depends: T1)
- [ ] T8: `vault.ts` at 100% — parser and validator rejections, the unreadable-page walk, and the path guards (depends: T1)
- [ ] T9: `WikiPage.tsx` at 100% — the reader's states: empty, failed, filtered, collapsed, search, health, editor fields, source panel (depends: T1)
- [ ] T10: Verification — the gate exits zero for the package, the README's coverage note is replaced by the result, and the feature spec records it (depends: T2, T3, T4, T5, T6, T7, T8, T9)

## [S4] Acceptance

- [ ] `npx vitest run packages/prism/prism-wiki --coverage --coverage.include='packages/prism/prism-wiki/src/**'` exits zero, with every file at 100% statements, branches, functions, and lines except the recorded browser-registrant exemption.
- [ ] `pnpm run check:ci:coverage` reports no `packages/prism/prism-wiki` file.
- [ ] No test-only production API was added and no new `as unknown` assertion appears.
- [ ] Every existing test still passes unchanged, or its change is explained in the commit that changes it.
- [ ] The package README's coverage note states the measured result instead of the debt.
- [ ] Any branch deleted as unreachable is named in its commit with the type-level reason it cannot run.
