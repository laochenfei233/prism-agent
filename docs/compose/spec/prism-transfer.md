---
feature: prism-transfer
status: delivered
updated: 2026-10-31
branch: feat/prism-transfer (worktree .worktrees/prism-transfer)
commits: 42f8b7cfed (base)..d002a34b80
---

# Prism Transfer

English | [中文](prism-transfer.zh.md)

## Report

**What was built** — `@prism/prism-transfer` puts an Import & Export page under Settings and makes it work. Export picks registered projects and streams one standard zip — a single-project archive or a combined one — carrying the workspace folder, every attached session's complete log with subagents, and the referenced media and files, plus an optional JSON file of the settings page's editable values (secrets excluded unless explicitly included, with the skipped counts surfaced to the page). Import verifies such an archive entry by entry — central-directory parsing, per-entry CRC-32, path and conflict guards, entry/size caps, a free-space guard — then spools, extracts to staging, publishes each project with one atomic rename (`name (2)` on collision, never overwriting), restores sessions under their original ids through the persistence handle with the projection checkpoint that gives the cold sidebar its titles, re-stores media and files through the attachment seam with content-address verification, registers the workspace, and reapplies settings per namespace through the revision-fenced write path. A single-flight job store with pollable snapshots drives the progress UI; failed imports leave no staging and no half-published project.

**Verification** — `node node_modules/vitest/vitest.mjs run packages/transfer/prism-transfer/tests --coverage --coverage.include='packages/transfer/prism-transfer/src/**'`: 198 passed, 1 skipped (Windows-gated symlink case), 0 errors, 100/100/100/100 on every `src` file. `pnpm run typecheck` PASS (re-run after the tsconfig alias additions); `pnpm run build:artifacts` + `pnpm run build:check` PASS after the final src state; `verify-cordis-config` shows only the pre-existing acp fixture failure; `verify-default-product-isolation`, `verify-dsh-package-licenses`, `verify-application-entrypoints`, `pnpm run constraints` PASS; `verify-client-ui-i18n`, `verify-md-links`, `verify-translation-pairing`, `verify-doc-budgets`, `gen-plugin-packages --check`, `gen-client-catalog --check`, `gen-config-catalog --check` PASS. PRE-EXISTING on this machine, verified identical at master: four `test:docs` failures (md-wrap on fork-upstream-divergence's Report line, repository-references uv.lock row, README Summaries on ui-chat/ui-conversation, doc-standard on prism-backup zh README), the ui-settings-general suite's `dsh-web-app` resolution error, and `jscpd`/`pnpm install --online` constraints. An independent adversarial review found one critical integration gap (the shipped route never wired the projection checkpoint) and five majors (lying-deflate memory exposure, missing ADS/ancestor guards, dead skip counters, incomplete A13 marker list) — all fixed in this branch with targeted tests, plus the minors recorded in the Journey log.

**Journey log**

- The review's critical finding came from a test seam: the import engine took `projections` as an option and the unit tests always injected a fake, so the shipped route silently composed without it. Any optional dependency that changes user-visible behavior needs a route-level integration test that asserts the wiring itself, not just the engine behavior.
- fflate's synchronous `Inflate` reports output through a `(data, final)` callback and throws errors from `push` — the async-style `(err, data)` signature silently misroutes data into an error slot. The initial reader did exactly that and the tests caught it only after the checksum comparisons started failing.
- Image restoration through `saveImage` is safe only because normalization passes clean bytes through byte-identically; the returned-id check turns that property into an enforced invariant instead of an assumption, and a deployment whose image policy differs fails the import loudly rather than storing refs the log cannot resolve.
- Media and file entry names carry `sha256:` colons that Windows cannot store; routing those entries straight into the attachment seam (never materializing them under staging) removed the whole ADS class for sessions, and the `project/**`-only colon guard plus the reader's directory-segment rule close it for materialized files.
- The jsdom lane's v8 coverage remap reports zero for executed blocks in the larger section component (probe-verified); the affected statements carry `v8 ignore` pragmas naming the specs that assert them, and the pure logic they cover (skip-count notices) moved into `state.ts`, where remap is exact.

## [S1] Problem

Prism Agent keeps each project as a registered workspace folder plus the sessions attached to it, and keeps user configuration as the settings values shown in the settings page. None of that can cross machines today:

- The only bulk path out is `prism-backup`, which uploads a whole-machine archive to WebDAV/SMB/S3, includes no sessions, and has no restore path; it is a backup, not a per-project or per-setting transfer.
- `session-log-export` zips one session (its log, subagents, media, files) onto the browser, but there is no way to bring a session archive back in, and it does not carry the project folder or registry entry.
- `prism-session-import` reads other agents' stores on the host, not archive files; it cannot restore a Prism project from a file.
- Settings values exist only inside one install's profile patch. Moving to a new machine means re-entering every section by hand.

Goal: a settings-page section — 「导入导出」 — that exports selected projects (folder + attached sessions) and/or all settings values to files, and imports such files back: extracting the project folder, restoring its sessions so they appear in the sidebar with titles, registering the workspace, and reapplying settings values. One project exports as a standard zip; several projects export as one combined zip; settings export as one readable JSON file. Import never overwrites existing data.

## [S2] Design

### S2.1 Package and composition

New fork package `@prism/prism-transfer` at `packages/transfer/prism-transfer` (new group `transfer/` with the README trio), plugin name `prism-transfer`, following the `prism-backup` / `prism-session-import` precedent: host plugin in `src/index.ts`, client plugin in `src/client/index.ts` exporting `inject` + `apply`, `./client` export and `dsh.client` manifest (`platform: "web"`) in `package.json`, composition row in `packages/bundle/web-app/cordis.patch.yml`, and an audited model-free row in `scripts/verify-package-readme-model-experience.ts` (product use comes from the web-app composition, as with its siblings). No Typert Remote namespace, no new npm dependency: zip writing and reading use `fflate` (already a workspace dependency of `session-log-export`), session serialization reuses `@deepseek-ai/dsh-session-log-export`'s public API, and the client rides `slots`, `locale`, `remote`, `workspaces`, and `remote.directoryPicker`. No `Config` schema: the section has no deployment-varying tunables (the import destination default is a product constant, overridable per import through the native directory picker; entry and size caps are fixed security invariants).

The section registers on the existing `settings.section` list slot with `id: 'transfer'`, `order: 30` (after backup and import), label `() => t('nav')`, namespace `settings.transfer`. The only core edit is a `'transfer'` case in `navIcon()` (`packages/client/ui-settings-general/src/client/SettingsRoot.tsx`), carrying a `PRISM-DIVERGENCE` marker and an area row (A13) in `docs/compose/spec/fork-upstream-divergence.md`. Nothing else in `packages/client/*` changes.

### S2.2 Archive and file formats

Three self-describing formats, all version 1. Per-project zip `<safe-title>.zip`:

```
.prism-project.json              ← first entry: { format: 'prism-project', version: 1, title,
                                    exportedAt, originalPath, sessions, hasProjectFolder }
project/**                       ← the workspace folder contents (omitted when the folder is
                                    empty; hasProjectFolder: false says so)
sessions/<sessionId>/session.v4.jsonl
sessions/<sessionId>/subagents/<id>/session.v4.jsonl
sessions/<sessionId>/media/<attachmentId>.<ext>     ← normalized image bytes
sessions/<sessionId>/files/<2>/<digest>/<name>      ← file attachment bytes
```

Combined zip `prism-transfer-<ts>.zip`:

```
.prism-transfer.json             ← { format: 'prism-transfer', version: 1, exportedAt,
                                    projects: [{ dir, title, sessions }], settings: boolean }
projects/<n>-<safe-title>/…      ← each child is a complete prism-project layout with its
                                    own .prism-project.json at its root
settings.json                    ← prism-settings body, present only when settings exported
```

Settings file `prism-settings-<ts>.json` (and the embedded `settings.json`):

```
{ format: 'prism-settings', version: 1, exportedAt, includeSecrets: boolean,
  namespaces: { <entryId>: <volatile projection of that namespace's effective value> } }
```

The volatile projection carries exactly the fields the settings page shows as editable (the `meta.volatile` paths of each active plugin's Config schema, as returned by `ctx.settings.describe()`). Import therefore restores what the file names — the file never carries fields import would silently drop. Manifest counts (`sessions`) are informational only and never trusted for validation; validation reads the archive itself. The formats reserve `version` for future evolution; a reader rejects unknown formats and versions greater than it understands with a typed error.

### S2.3 Export

One streaming GET route; no job, no staging — the zip is built straight onto the response like `session-log-export`. Query: `projects` (comma-separated workspace ids), `settings=0|1`, `secrets=0|1`. Response selection: one project and no settings → single-project zip; any project set with settings, or more than one project → combined zip; settings only → JSON attachment. Filenames via `content-disposition: attachment` with an RFC 5987 `filename*` for non-ASCII titles.

Before the first byte is sent, a scan pass walks each selected workspace folder and fails fast with a typed error when it finds a single file ≥ 4 GiB (fflate's per-entry write limit — the error names the file and suggests compressing or splitting it), a name containing `\` or NUL, or an unreadable entry. Symbolic links and junctions are skipped and counted, never followed, so nothing outside the folder enters the archive. The scan also sums bytes for the progress-free phaseless download the browser already renders. Session content is produced by the exported generator `sessionLogZipEntries` from `@deepseek-ai/dsh-session-log-export` (root log, subagent descendants via `traceSession`, media, files — including the live-session flush it performs), with each session's entries re-rooted under `sessions/<sessionId>/`. Compression follows the house convention: media and already-compressed bytes stored, text deflated at level 6. Exported sessions are the ids attached to the workspace record in the registry (`WorkspaceRecord.sessionIds`), archived ones included; a session whose log can no longer be opened fails the whole export loudly — the download errors before shipping a truncated archive that would silently lose a session.

Settings export reads `ctx.settings.describe()` in-process (unredacted when `secrets=1`) and projects each active namespace to its volatile fields; with `secrets=0` secret-role fields are omitted and counted, with `secrets=1` their real values are written. Credentials outside the settings document (`remote.credentials`) are never exported.

### S2.4 Import

One streaming POST route accepts the zip bytes (`requestBody: 'streaming'`, the `file-upload` channel — no size cap) plus an optional `dest` query (absolute destination root; default `~/.prism/projects` via the home-paths service). The bytes are spooled to `$DSH_HOME/cache/prism-transfer/import-<hex>.zip` — never held in memory — then read back through a new zip reader module: parse EOCD/ZIP64 central directory, then extract entry by entry, verifying each entry's CRC32 against the decompressed bytes (fflate's streaming inflate does not check CRC; stored media must be verified). Validation before any write outside staging: entry-name guards (reject `\`, NUL, leading `/`, drive `:`, UNC, empty segments, `.`/`..` segments, names over 1024 UTF-8 bytes, in-segment `:` ADS), duplicate-entry rejection with case folding (macOS/Windows) and NFC normalization, ancestor conflicts in both orders (`a` file then `a/b`, and reverse), at most 200 000 entries, per-entry uncompressed size ≤ 4 GiB, and a free-space guard (require free > archive size + 1 GiB before extracting; abort when written bytes exceed start-free − 512 MiB, skipping the guard only where the platform cannot report free space, e.g. some UNC paths).

The root manifest decides the shape: `.prism-project.json` → one project; `.prism-transfer.json` → iterate `projects/*`, each child validated as a full prism-project layout; anything else (including a manifest-less zip) fails with `bad-manifest`. Extraction goes to a staging directory `<dest>/.prism-import-<hex>/` on the same volume as publication, so each project is published with a single atomic `rename` to `<dest>/<final-name>`; a failure removes staging and leaves `<dest>` without half-projects. The final name comes from the manifest title, sanitized with the same rules project titles use elsewhere (Windows-illegal characters stripped, length capped, non-empty fallback), and a collision with an existing directory appends ` (2)`, `(3)`… up to 100 — import never overwrites. The default and any picked destination refuse publication targets that resolve to the DSH home directory itself or its reserved top-level entries.

For each project, sessions restore under the session-import recipe: skip ids already present (`sessionPersistence.stat` — counted as duplicates), else `sessionPersistence.create(header)` from the archive's first JSONL line, `append` the remaining lines as one contiguous batch, `flush`, `close`, then the projection checkpoint through `sessionProjectionCache` (the step that makes titles appear in a cold sidebar list), then register and attach. Header acceptance follows the same rule as the session-import native copy path: a readable header whose format version equals the running `SESSION_FORMAT_VERSION` restores verbatim (the session-import native rule); anything else fails that project with `session-version`. Logs are copied verbatim — no cwd rewriting (the header's `cwd` names the exporting machine's path; grouping and resume follow the workspace record, and the limitation is stated in the README). Main sessions restore before their subagents. Media and files restore through the public attachment seam: each `media/*` entry through `attachments.saveImage`, each `files/*` entry through `attachments.saveFileStream`, content-addressing reproducing the original refs; after each save the returned attachment id is compared with the id the archive layout names, and a mismatch fails the import with `attachment-mismatch` rather than leaving sessions whose images resolve to wrong bytes. The workspace is registered with `workspaceRegistry.create(path)` (an existing registration for the same path is success, counted) and each restored session attached with `attachSession`; a registry failure keeps the restored files and is reported as `workspace-register-failed` in the result, not a rollback. When the archive carries `settings.json`, its values are applied as the job's final phase, sharing the settings applier below; per-namespace failures are reported, never fatal.

A single-flight guard (taken after the route's awaits, so two requests in one tick cannot both run) allows one import job at a time; a second concurrent import answers 409 `busy`. Progress is a polled snapshot: phases `validating → extracting → restoring → applying-settings → registering → done`, with byte, file, session, and project counters. The finished snapshot is retained until the next job starts or ten minutes pass. Stale `.prism-import-*` staging directories older than 24 hours are swept when the plugin applies and before each import; only that prefix is ever removed.

### S2.5 Settings (config items) export and import

Standalone settings import is one buffered JSON POST route carrying the parsed `prism-settings` body; it shares the same applier as the combined-archive phase. For each namespace in the file that is also active in the current `describe()`, the applier builds a patch from the file's volatile projection, applies it through the existing revision-fenced write path (`ctx.settings.update(ns, patch, expectedRevision)`), and re-reads the revision once on a conflict before reporting the namespace as failed. Namespaces in the file but not active are skipped and counted; namespaces active but absent from the file are untouched. Each namespace's outcome (applied / skipped-inactive / failed with reason) is returned to the client for a per-item report. Secret-role fields are applied only when the file was exported with `includeSecrets: true`; a file without them simply leaves the current secrets in place.

### S2.6 Safety and consistency

All host work happens inside the plugin's own routes on the existing client connection fence — no new runner-token exception, no Typert namespace. Import never overwrites: projects publish under a fresh name, sessions dedupe by id, settings merge per namespace, attachments merge content-addressed. Export never follows links out of a workspace folder, never includes a file ≥ 4 GiB, and never exports credentials. The zip reader treats every archive as hostile: central-directory-driven extraction (local headers are never trusted for sizes), per-entry CRC verification, the name and conflict guards above, and hard entry/size caps. Errors are typed codes mapped to zh/en copy client-side, with the host `detail` as fallback; staging is cleaned on every failure path, and `projects/` never keeps a half-published directory. The plugin registers nothing model-visible: no prompt, tool, or session event.

### S2.7 Host routes and job model

All routes live under one prefix, in the `prism-backup` style:

| Method / path | Request | Response |
| --- | --- | --- |
| `GET /api/prism.transfer/export` | query `projects`, `settings`, `secrets` | streamed zip or JSON attachment; 400 on invalid ids, 404 on unknown workspace |
| `POST /api/prism.transfer/import` | streaming octet-stream body, query `dest?` | `{ jobId }`; 400 `bad-archive`-class codes; 409 `busy` |
| `GET /api/prism.transfer/job` | — | `{ state: 'idle' }` or the snapshot below |
| `POST /api/prism.transfer/settings` | buffered JSON `prism-settings` body | `{ results: [{ ns, outcome }] }`; 400 `bad-settings` |

Job snapshot: `{ jobId, kind: 'project' | 'combined' | 'unknown', state: 'running' | 'done' | 'failed', phase, name, archiveBytes, files, bytes, sessionsDone, sessionsTotal, projectsDone, projectsTotal, duplicates, skippedLinks, skippedUnreadable, skippedSecrets, result?, error?, startedAt, finishedAt? }` (`kind` is `unknown` between job start and manifest dispatch). The client polls only the `jobId` it received, stops on a terminal state, and the server treats a poll for an unknown or expired job as `idle` (a restart loses the in-flight job; its staging is covered by the sweep).

### S2.8 Settings page UI

The section renders three cards in the settings modal's content area, all copy from the `settings.transfer` dictionary (zh is the key-set source of truth, en the typed mirror; nav label 「导入导出」 / "Import & Export"):

- **导出 card** — the workspace list from `ctx.workspaces` (title, path tooltip, session count, checkbox per row, select-all), an 「包含配置项」 checkbox that enables an 「包含密钥」 checkbox, a primary 「导出所选」 button (disabled when nothing is selected; exports one zip — single-project layout when exactly one project and no settings, combined otherwise — as a browser download), and a secondary 「仅导出配置项」 button (JSON download). Rows use the settings-card fill alias with visible `:focus-visible` rings; the card notes that archives contain the project folder and its sessions, and that secrets are excluded unless explicitly included.
- **导入 card** — 「选择压缩包…」 opens the file input (`.zip`), the picked file's name and size are shown, the destination row shows the effective root (default `~/.prism/projects`) with a 「更改…」 button that calls `remote.directoryPicker.pick()` when the native capability is present (absent on web-only deployments: the button is hidden, the default stands), and an 「导入」 button that POSTs the file and starts polling. While a job runs the card shows phase text, a determinate progress bar with byte/session counters, and `aria-busy`; a terminal state renders the per-project result (names, session counts, duplicates) or the typed error with its zh/en copy, `role="status"` while running and `role="alert"` on failure. Progress motion respects `prefers-reduced-motion`.
- **说明 card note line** — the never-overwrites rule and the sessions-not-rewritten limitation, one line each.

### S2.9 Reuse map

Reused, with one widening: the transfer writer needs `session-log-export`'s streaming helpers (`ResponseCapacityGate`, `pushArtifactChunks`, `pushBinaryChunks`, `pushStreamChunks`) exported, a marked fork edit recorded in the divergence index; the session-entry producers (`sessionLogZipEntries` + `sessionLogExportDeps` + `flushLiveSessionLog` + `SESSION_LOG_FILENAME`) were already public, the `sessionPersistence` create/append/flush/close handle recipe and `sessionProjectionCache` checkpoint from `prism-session-import`, `workspaceRegistry` create/resolveByPath/attachSession, `ctx.settings.describe/update` + volatile/secret schema walks, `ctx.workspaces` client list, `remote.directoryPicker.pick`, `connection.fetch.register` streaming and buffered routes, `fflate` Zip writing, the settings-card CSS aliases, and the locale dictionary pattern. New code: the zip reader (central directory + CRC + guards), the export scan and assembly, the import job state machine, the settings applier, and the section UI.

### S2.10 Rejected alternatives

- **Native open/save file dialogs (new host file-picker seam)** — the streaming route plus browser download already moves unlimited-size files; a new host capability seam would add packages and remote verbs for no capability the web cannot reach. Rejected.
- **Browser-side unzip** — the browser never touches the filesystem in this app's architecture, and client-side extraction would duplicate every guard the host must re-run anyway. Rejected.
- **Rewriting session `cwd` on import** — frame 1 of a session log must hold exactly; log surgery to point `cwd` at the restored path risks corruption for a value grouping does not depend on. Logs stay verbatim; the limitation is documented. Rejected.
- **Restoring attachments by directory copy (session-import's `copyAttachments`)** — that copies the store's internal layout, coupling the plugin to `attachment-local` internals; the public `saveImage`/`saveFileStream` seam plus the returned-id check gives the same content-addressed result inside the seam contract. Rejected.
- **One archive format only** — the user asked for both per-project sharing and whole-set transfer; the combined layout embeds complete per-project subtrees, so the importer validates one layout twice instead of maintaining two layouts.
- **Extending `prism-backup` with import/restore** — backup targets remote stores and excludes sessions; transfer is file-shaped and session-carrying. Different contract, different package.

## [S3] Scope

- In scope:
  - `@prism/prism-transfer` host plugin: zip reader, export engine, import engine, settings applier, four routes, job model, staging sweep.
  - Client plugin: `settings.section` slot `transfer` with 导出 / 导入 cards, dictionary (zh/en), progress and error states, accessibility.
  - Archive formats v1 (`prism-project`, `prism-transfer`, `prism-settings`) with manifest validation and CRC-verified extraction.
  - Session restore with dedupe, subagents, media/files restore with id verification, projection checkpoints, workspace registration.
  - Settings export (volatile projection, secrets opt-in) and per-namespace import with report.
  - Core `navIcon` case + divergence marker/index row; package README trio + group README trio; product-package-policy row; web-app composition row; catalogs regenerated.
  - Unit tests at the repo's 100% per-file coverage gate for the package.
- Out of scope:
  - Cancel/pause/resume of a running import; parallel jobs.
  - Encrypted or password-protected archives; tar/7z formats; manifest-less foreign zips.
  - Exporting unregistered paths, single sessions, or the session list of one project without its folder.
  - Session log rewriting (cwd or otherwise); session format migrations on import.
  - Drag-and-drop import; auto-open after import; CLI entry; cloud upload (prism-backup's domain).

## Tasks

- [x] T1: Zip reader module — EOCD/ZIP64 central directory parse, per-entry CRC32 verify, entry-name guards, duplicate/case/NFC conflict detection, ancestor conflicts, entry count and size caps; unit tests covering every guard with crafted archives (`../`, absolute, backslash, ADS colon, duplicates incl. case/Unicode folds, ancestor conflicts both orders, corrupt CRC, truncated central directory, over-cap entries). (depends: none)
- [x] T2: Export engine — workspace folder scan with guards (≥4 GiB, `\`/NUL names, link/unreadable skip + counts), manifest emission, `project/**` assembly, per-session `sessionLogZipEntries` re-rooting under `sessions/<id>/`, single-project vs combined layout selection, settings JSON projection (volatile fields, secrets opt-in), streamed fflate writer; unit tests with temp folders and fake deps. (depends: T1)
- [x] T3: Import engine — spool-to-cache, manifest dispatch (project / combined / reject), staging extract with CRC, free-space guards, sanitized naming with ` (n)` collisions, session restore recipe with dedupe + version rule + projection checkpoint, attachment restore with returned-id verification, workspace register + attach, settings-apply phase; job state machine with post-await single-flight, snapshot, retention, staging sweep; unit tests for each path and failure. (depends: T1)
- [x] T4: Settings applier as a standalone unit (shared by T3's phase and the standalone route) — volatile patch build, revision-fenced update with one conflict retry, per-namespace outcomes; unit tests. (depends: none)
- [x] T5: Routes and wiring — the four routes under `/api/prism.transfer`, streaming import with spool, export query validation, error-code mapping table, plugin `apply()` with `ctx.easel`-style registration (connection.fetch.register), composition row in `packages/bundle/web-app/cordis.patch.yml`, package.json (`./client` export + `dsh.client` manifest), product-package-policy row; route tests with fake services (busy/409, 400s, poll semantics, restart-idle). (depends: T2, T3, T4)
- [x] T6: Client section — `src/client/index.ts` (inject list, `LocaleNamespaceMap` merge, `slots.inject('settings.section', …)`), `locales.ts` zh/en, `TransferSection.tsx` with the three cards, file input + streaming POST, destination row with native-pick fallback, polling progress + result/error rendering, a11y states; pure-function tests (layout detection client-side helpers, error-copy mapping). (depends: T5)
- [x] T7: Core + docs — `navIcon()` `'transfer'` case with `PRISM-DIVERGENCE` marker, divergence index area A13 row, `packages/transfer/README` trio + package README trio with generated `.i18n.yaml` records, spec trio pairing record, catalogs (`gen-plugin-packages`, `gen-client-catalog`) regenerated; affected doc gates run. (depends: T6)
- [x] T8: Verification and review — package vitest run with 100% per-file coverage, typecheck host + client faces, `build:artifacts` + `build:check`, touched doc gates, i18n gate; record evidence in the spec; independent review pass per the compose flow; fixes re-verified. (depends: T7)

## [S4] Acceptance

- [x] The settings sidebar shows 「导入导出」 after backup/import; on a fresh profile the section renders with the workspace list, both cards, and the default destination `~/.prism/projects`.
- [x] Exporting one project (no settings) downloads `<title>.zip`; opening it in a file manager shows `.prism-project.json` first, `project/**`, and `sessions/**`; exporting several projects downloads one combined zip whose `projects/*` children each carry their own manifest; 「仅导出配置项」 downloads a readable `prism-settings-*.json`.
- [x] A round-trip (export on a temp home → wipe → import) restores the project folder byte-identical, every session (main + subagents) visible in the sidebar with titles, images and files rendering again, and the workspace registered once (no duplicate registration on re-import; re-importing the same archive reports duplicates and restores nothing twice).
- [x] Importing into a destination that already has the project publishes as `<title> (2)` and never touches the existing directory; the combined import with `settings.json` applies settings per namespace and reports applied/skipped/failed.
- [x] Hostile archives (every T1 guard case, plus a manifest-less zip, a `prism-project` version 2 manifest, and a CRC-tampered stored media entry) fail with the mapped error code, leave no staging directory, and change nothing under the destination.
- [x] An exported project containing a ≥ 4 GiB file fails the export before any download begins, naming the file; symbolic links and unreadable files are skipped and counted in the result the client shows.
- [x] Settings export without 「包含密钥」 contains no secret-role values and reports how many were skipped; with it, importing on a second profile reproduces the exported values (verified through `describe()`), and a namespace absent from the new install is reported skipped.
- [x] Two imports submitted in the same tick produce exactly one job (409 for the other); polling an unknown/expired job returns idle; a killed run leaves only a `.prism-import-*` directory, swept once it is older than 24 hours by the next import or restart.
- [x] All section copy is dictionary-owned (zh/en), the nav icon renders, focus rings are visible on every new control, running/failed states use `role="status"`/`role="alert"`, and reduced-motion removes progress animation; `verify-client-ui-i18n` passes.
- [x] `pnpm vitest run packages/transfer/prism-transfer` covers every `src` file at 100%; `tsc` host and client faces pass; `build:artifacts` + `build:check` pass; the touched doc gates (readme summaries/model-experience/limitations, translation pairing, md wrap/links, workspace constraints, product isolation, application entrypoints, plugin/client catalogs) pass; PRE-EXISTING failures identical to master are recorded as such.
