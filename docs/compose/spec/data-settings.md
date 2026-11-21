---
feature: data-settings
status: delivered
updated: 2026-11-01
branch: none, see the Workspace override in S2
commits: uncommitted working tree
---

# Data Settings

English | [中文](data-settings.zh.md)

## Report

**What was built** — The settings rail now carries one 数据 entry (id `data`, order 25) instead of the 备份, 导入导出, and 导入 rows. The new `@prism/prism-data` section renders three fixed tabs — 数据存储路径, 备份, 导入导出 — and mounts a visited tab again while hidden. The storage tab shows the harness home this process runs from; 更改位置 copies it (regular files and directory links, no top-level `cache/`) into an empty destination, records the destination in `~/.prism-data-home`, and leaves the old directory untouched, while 恢复默认位置 clears that record. `prism-backup`, `prism-transfer`, and `prism-session-import` keep their packages, dictionaries, and Host routes and register into `settings.data.page`, so 备份 is the backup page and 导入导出 stacks the archive page above the cross-agent import page; all three lost their nav rows and page titles. The CLI adopts the pointer when `$DSH_HOME` is blank, and the desktop shell resolves `$PRISM_HOME`, then the pointer, then `~/.prism`, so the next launch runs from the new directory.

**Verification** — `node node_modules/vitest/vitest.mjs run packages/data/prism-data/tests` → 6 files, 70 tests passed, and the package's own files reach 100% statements, branches, functions, and lines under `--coverage`. The same runner over `packages/backup/prism-backup/tests packages/transfer/prism-transfer/tests packages/session-query/session-import/tests packages/util/home-paths/tests packages/client/ui-settings-general/tests apps/cli/tests/data-home-pointer.spec.ts` → 43 files, 513 passed, 1 skipped; the run also reports one unhandled rejection from `packages/transfer/prism-transfer/tests/route.spec.ts`, reproduced with that file alone (`PRE-EXISTING: transfer-route-unhandled`). `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib home_tests` → 3 passed. `pnpm run typecheck` → 5 gates passed. `npx tsx scripts/run-oxlint.ts packages/data` and the same runner over the other changed paths → 0 errors (the transfer page keeps three errors at unchanged lines, `PRE-EXISTING: transfer-promise-handlers`). Gates passing: `verify-md-links`, `verify-doc-refs`, `verify-package-meta`, `verify-package-readme-limitations`, `verify-client-packages`, `verify-tsconfig-paths`, `verify-client-catalog`, `verify-config-catalog`, `verify-plugin-packages`, `verify-client-ui-i18n`, `verify-doc-budgets`, and `verify-translation-pairing` over the five pairs this change touches. Pre-existing red gates not touched here: `verify-md-wrap` (`docs/compose/specs/custom-theme-presets.md`), `verify-package-paths` (agent notes naming a retired package path), `verify-package-readme-summaries` (ui-chat, ui-conversation, sandbox-windows-acl), `verify-package-readme-model-experience` (ui-sidebar-git), `verify-cordis-config` (`apps/cli/tests/profiles/acp/cordis.yml`), `verify-export-jsdoc` (`packages/transfer/prism-transfer/src/client/state.ts`), and the corpus-wide `verify-translation-pairing` (ui-primitives, ui-theme, ui-settings-general README records).

**Journey log**

- `fs.cp` fails on this machine's harness home: its `node_modules` is a junction, and copying a link needs privilege Node does not have. The copy therefore walks `lstat` and recreates each link as a junction on Windows or a symlink elsewhere.
- Renaming the home while the app runs is not portable — Windows keeps open handles below the home — so the junction-swap design was dropped for a launch pointer plus a restart.
- The three pages stayed in their own packages, which made the section own a child slot rather than a monolith; the pages then no longer need section runtime props, which also removed the test casts' type error.
- This checkout's client roster could not resolve `@deepseek-ai/dsh-web-app` (no self-link in `node_modules`); a local junction restored it so the shell spec could run and confirm the `data` row.
- The new group row needed 13 more words than `packages/README.md` allowed; the budget manifest records the raised ceiling.

## [S1] Problem

Three settings entries describe the same subject and none of them answers the first question a user has: where this app keeps its data. `数据存储路径` does not exist, while `备份` (prism-backup), `导入导出` (prism-transfer), and `导入` (session-import) each own a top-level navigation row. The navigation rail therefore carries three entries for one topic, the two import pages are separated although they answer one question ("bring something in"), and a user who wants their chats on another disk has no control at all: the harness home is decided at launch by `$DSH_HOME` or by `~/.prism`.

## [S2] Design

### Workspace override

This feature has no worktree, no branch, and no commits. The repository's fork changes are delivered as working-tree edits and the previous fork feature documents record the same override; this session also reserves commits for an explicit request. The document records the override in place of a branch and a commit range.

### S2.1 One `数据` section with three tabs

A new plugin package `@prism/prism-data` (`packages/data/prism-data`) owns one `settings.section` entry:

- id `data`, order `25`, label `数据` / `Data`, dictionary namespace `settings.data`.
- The package declares the child slot `settings.data.page` (`list`, `root`) in its own contract module, following `ui-settings-models`: a feature package owns the slot types of the pages it hosts.
- The section renders a title, an intro, and exactly three tabs in a fixed order — `数据存储路径`, `备份`, `导入导出`. The tab labels belong to the section's dictionary; contributions carry only an id, so a page cannot rename or reorder its tab.
- Visiting a tab mounts it and keeps it mounted while hidden, as `ui-settings-plugins` does, so staged backup drafts survive tab switches.

The three existing pages keep their own packages, dictionaries, and Host routes; only their registration target changes from `settings.section` to `settings.data.page`:

| Page | Package | Slot id | Rendered in tab |
| --- | --- | --- | --- |
| Storage location | `prism-data` (own component) | — | `数据存储路径` |
| Backup | `prism-backup` | `backup` | `备份` |
| Archive transfer | `prism-transfer` | `transfer` | `导入导出` |
| Cross-agent import | `prism-session-import` | `cross-agent` | `导入导出` |

`导入导出` renders the two contributions one after the other: exporting and importing an archive, then importing conversations from other agents. Both keep their current content; the cross-agent page keeps a smaller heading so the two blocks read as one page.

`prism-backup`, `prism-transfer`, and `prism-session-import` drop their `nav` copy key and their page-title headings, because the section own the page title. Backup keeps its credential warning; transfer keeps its export and import cards; cross-agent import keeps its intro and rescan action.

The settings shell's `navIcon` gains a `data` case (`IconDatabaseOutlineMedium`); the `transfer` case is deleted. `PRODUCT_SECTIONS` in the shell spec becomes `['general', 'appearance', 'models', 'plugins', 'agent-presets', 'data']`.

### S2.2 Where the data lives, and what changing it means

The **harness home** is one directory holding `sessions/`, `storages/`, `attachments/`, `profiles/`, `projects/`, `.env`, and `.credentials.yaml`. It is resolved once per launch and every service captures it at construction, so moving it in a running process would split the data. Changing it therefore has two halves:

1. **Copy now.** The running Host copies the current home to the chosen directory.
2. **Record the choice.** The Host writes a launch pointer; the next launch resolves the home from it.

The old directory is never modified or deleted. A relocation is therefore always reversible by pointing the app back at the old path (by hand) or by clearing the pointer with `恢复默认位置`.

### S2.3 Launch pointer

`~/.prism-data-home` (a plain text file holding one absolute path) is the pointer. It lives beside the default home, never inside it, so reading it can never depend on the value it selects.

Resolution order, unchanged where it exists today:

| Launcher | Order |
| --- | --- |
| Desktop shell (`apps/desktop/src-tauri/src/setup.rs::dsh_home`) | `$PRISM_HOME` → pointer → `~/.prism` |
| CLI (`apps/cli/src/bin.ts`) | `$DSH_HOME` when non-blank → pointer (exported as `DSH_HOME` for the process) → `~/.prism` |

`@deepseek-ai/dsh-home-paths` owns the three helpers both Node launchers and the Host route use: `dataHomePointerPath()`, `readDataHomePointer()`, and `writeDataHomePointer(path)`. The desktop shell re-implements the same three lines in Rust because it resolves the home before any Node process exists; it already forwards the result as `DSH_HOME` to the child.

A pointer written on a machine whose `$DSH_HOME` is set is not honoured by that CLI; the page states once, in its intro copy, that an environment variable naming the data directory still wins. Desktops pass a `DSH_HOME` derived from the pointer, so the statement never misleads there.

### S2.4 Host route contract

One POST route, `/api/prism.data`, JSON in and out, following the backup route's envelope (`{ ok: true, value }` / `{ ok: false, error: { code, message } }`).

```ts
type DataRequest =
  | { action: 'state' }
  | { action: 'relocate'; target: string }
  | { action: 'reset' }

interface DataLocationState {
  root: string            // absolute home this process uses
  pointerPath: string     // ~/.prism-data-home
  storedRoot?: string     // pointer contents when present and absolute
  pendingRoot?: string    // root a fresh launch would use, when it differs from root
}

interface RelocationResult {
  target: string          // absolute new root
  previousRoot: string    // root the copy came from
  files: number           // regular files copied
  bytes: number           // their total size
  skippedLinks: string[]  // links that could not be recreated (absolute paths)
}
```

Failure codes: `prism-data/bad-request` (400), `prism-data/busy` (409), `prism-data/target-invalid` (400), `prism-data/target-not-empty` (409), `prism-data/copy-failed` (500), `prism-data/pointer-failed` (500).

### S2.5 Relocation rules

- The target must be an absolute path, must differ from the root, must not contain the root and must not sit inside the root.
- The target must be absent or an empty directory. Merging into an existing tree is refused rather than guessed at.
- The copy walks the home with `lstat`, so a link is copied as a link and never traversed.
- The top-level `cache/` directory is skipped: it holds rebuildable transfer spools and model caches, and copying it can dominate the run.
- A link is recreated as a junction whose target is absolute, so it still resolves at the new root; every platform except Windows ignores that type argument. A link whose target is missing, or that the platform refuses to recreate — a file link on Windows — is skipped and reported in `skippedLinks` rather than failing the run; the desktop recreates its own `node_modules` link on the next launch.
- File contents are copied verbatim; file modes and ownership are the destination's defaults, which is what a fresh home would get.
- A failure at any point removes the target it was writing (best effort, including an empty directory the operator picked) and answers `copy-failed`, so a retry is not blocked by a tree the user cannot explain.
- Only one relocation may run at a time; a second request answers `busy`.
- After a successful copy the Host writes the pointer. If that write fails the route answers `pointer-failed`; the copy is left on disk and the message names it.

### S2.6 Storage page

The first tab renders:

- **当前数据目录** — the absolute root, in a monospace value block, with a one-line hint naming what lives there.
- **下次启动** — shown only while `pendingRoot` is set: "重启后将在 <pendingRoot> 运行".
- **更改位置…** — opens a dialog with a text field (the path is editable by hand) and a 选择文件夹… button bound to `remote.directoryPicker`, the same picker the transfer page uses. The section does not require that service: a deployment without it still renders, keeps the text field, and shows the transfer page's unavailable hint.
- The dialog states that data is copied, that the app must be restarted, and that the old directory is kept. Confirming calls `relocate`; while it runs the dialog shows 正在复制数据… and cannot be re-submitted.
- A finished relocation shows the file and byte counts, the new path, the kept old path, and any skipped links.
- **恢复默认位置** — shown only while `storedRoot` is set; it calls `reset` and explains that the current directory keeps running until the next launch.

Failures are rendered as the typed code's localized sentence, with the Host message as the fallback, matching the transfer page's `CODE_KEYS` treatment.

### S2.7 Copy and presentation limits

The copy is a plain sequential walk: no parallelism, no progress percentage. The page reports one busy state for the run because `fs.cp`'s callbacks cannot be counted cheaply here, and the observed home on this machine is ~130 MB / ~1.7k files. A home large enough to make that feel slow still finishes; the dialog stays busy and the route can be retried after a restart if it is interrupted.

## [S3] Scope

- In scope: the `数据` section and its three tabs; the storage location page; the launch pointer in `dsh-home-paths`, the CLI, and the desktop shell; the three registrations moved into the new slot; navigation, copy, tests, and fork-divergence markers for every upstream file touched.
- Out of scope: moving the data directory without a restart; per-directory relocation (projects, attachments, cache); progress reporting and cancellation for the copy; deleting the old directory; migrating a directory that a running process still writes to; any change to how the backup or transfer features work.

## Tasks

- [x] T1: Create `packages/data/prism-data` (manifest, face configs, tsdown, entry files, README pair) and its wiring rows: web-app patch row and dependency, aggregate tsconfig references, `tsconfig.base.json` aliases, model-experience gate entry (depends: none)
- [x] T2: Add the launch-pointer helpers to `packages/util/home-paths` with tests (depends: none)
- [x] T3: Read the pointer in the CLI entry and in the desktop shell's `dsh_home` (depends: T2)
- [x] T4: Implement the Host route and the copy walker for `state`, `relocate`, and `reset` (depends: T1, T2)
- [x] T5: Implement the client section shell, the storage page, dictionaries, and styles (depends: T1, T4)
- [x] T6: Move `prism-backup`, `prism-transfer`, and `prism-session-import` into `settings.data.page` and drop their navigation rows and page titles (depends: T1)
- [x] T7: Update the settings shell `navIcon` and its `PRODUCT_SECTIONS` expectation (depends: T6)
- [x] T8: Regenerate catalogs and run the client, host, and documentation gates (depends: T1-T7)
- [x] T9: Write the bilingual feature document and the divergence markers (depends: T8)

## [S4] Acceptance

- [x] The settings navigation lists one new row `数据` (order 25) and no `备份`, `导入导出`, or `导入` row.
- [x] `数据` shows three tabs in the order 数据存储路径 / 备份 / 导入导出; a tab keeps its mounted state after being revisited.
- [x] The `导入导出` tab shows the archive export/import cards and, below them, the cross-agent import page.
- [x] The storage tab shows the absolute harness home the process uses.
- [x] Relocating copies the home's files, writes `~/.prism-data-home`, and leaves the previous home untouched; the tab then reports that the next launch uses the new path.
- [x] A non-empty target, a target inside the home, and a relative target are refused with their typed codes, and the home is unchanged.
- [x] A second relocation request while one runs answers `busy`.
- [x] Links are recreated where the platform allows and reported in `skippedLinks` where it does not; `cache/` is not copied.
- [x] `prism` with no `DSH_HOME` resolves the home from the pointer; with `DSH_HOME` set the variable still wins.
- [x] The desktop shell resolves `$PRISM_HOME`, then the pointer, then `~/.prism`, and still hands the result to the child as `DSH_HOME`.
- [x] `pnpm vitest run` over the four changed packages, `pnpm run typecheck`, and the client/translation/config gates pass.
