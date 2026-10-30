---
feature: prism-backup
status: delivered
updated: 2026-10-30
branch: feat/prism-backup (worktree .worktrees/prism-backup)
commits: 1a63913b (base)..66821c5a (plus the master merge 771926f1)
---

# Prism Backup

English | [中文](prism-backup.zh.md)

## Report

**What was built** — `@prism/prism-backup` puts a Backup section in the application's settings page and makes it work: the section picks one of WebDAV, SMB, or S3, fills in that protocol's fields, decides which of the three data sets to include, and offers Test connection and Back up now. A run reads the live configuration once, collects the profile and home `cordis.patch.yml` layers, `.env`, `.credentials.yaml`, the long-term memory store, the workspace registry, and every registered project folder into a single zip with a self-describing manifest, uploads it to the selected destination, prunes older archives beyond the retention the user chose, and appends one run record the page lists. Passwords never enter configuration: they are the credential references `PRISM_BACKUP_WEBDAV_PASSWORD`, `PRISM_BACKUP_SMB_PASSWORD`, and `PRISM_BACKUP_S3_SECRET_KEY`, written from the page and resolved once per run.

The Host half is one plugin with one POST route (`/api/prism.backup`), because a backup is a file transfer with progress rather than a JSON Remote call; settings rides the existing configuration-form surface, secrets ride the existing credential surface, and history rides the ordinary storage domain under `prism_backup`. Transports are hand-written over the process-global fetch (WebDAV verbs, header-form SigV4 for S3) and the operating system's file session (SMB, with one Windows `net use` bootstrap when a password is stored). Nothing here is model-visible: no prompt, tool, or session event is registered.

**Verification** — `node node_modules/vitest/vitest.mjs run packages/backup/prism-backup/tests`: 133 tests pass, and `--coverage` reports 100% statements, branches, functions, and lines on every `packages/backup/prism-backup/src` file. `tsc -b tsconfig.host.json` and `tsc -b tsconfig.client.json` pass; `scripts/build.ts --scope artifacts` then `--scope check` pass; oxlint is clean on the package's sources and tests. The gates that this change touches pass: `gen-config-catalog --check`, `gen-plugin-packages --check`, `gen-client-catalog --check`, `verify-package-readme-summaries`, `verify-package-readme-model-experience`, `verify-package-readme-limitations`, `verify-client-ui-i18n`, `verify-export-jsdoc`, `verify-no-unknown-casts`, `verify-md-wrap`, `verify-md-links`, `verify-translation-pairing`, `check-workspace-constraints`, `verify-default-product-isolation`, `verify-dsh-package-licenses`, `verify-application-entrypoints`. PRE-EXISTING failures on this machine, identical at master `8d388f0a8c`: `verify-cordis-config` (an `apps/cli` profile fixture, and `@prism/prism-session-import` missing a bare `tsconfig.base.json` alias), `verify-product-use` (the same alias), and `gen-doc-graphs --check` (24 cron type-link rows from the unfinished A7 import). `jscpd` could not start in this worktree (its own module resolution fails), so clone detection is left to CI. `pnpm install --offline` also fails after the master merge because the local mirror lacks metadata for the website's `@algolia/abtesting`; the installed `node_modules` stayed usable for every check above.

**Journey log**

- The first design gave the feature its own Typert Remote namespace. That needs the package under `packages/` (the generator only registers projects there), and it needed a generated contribution mounted in `@deepseek-ai/dsh-api-remotes`. Replacing it with one `ctx.connection.fetch.register` POST route — the channel `dsh-client-file-upload` uses for the same reason — removed the codegen, the assembly edit, and a whole failure vocabulary, and the spec recorded the pivot.
- The AWS documentation's "GET Object" example did not match the implementation until the signer was generalized to sign exactly the headers a caller sends; the AWS Signature Version 4 test-suite `get-vanilla` vector then passed unmodified. A caller-supplied `x-amz-date` also has to decide the credential scope, which the first version got wrong.
- Review found three defects that the tests had hidden: the web bundle never declared the package (the row could not resolve), S3 listings returned full keys so rotation silently matched nothing, and the single-flight guard sat before an `await` so two requests in one tick both ran. Each now has a test that fails on the old code.
- Two spec claims were over-claims rather than code defects and were narrowed instead of "fixed": required configuration fields are resolved when a run starts (not by a schema `.check()`, which would refuse the first save after a protocol switch), and only reading the sources raises `collect-failed` (compression and staging stay `failed`).


## [S1] Problem

Prism keeps three kinds of user data on one machine with no way to copy them elsewhere: configuration (the profile and home `cordis.patch.yml` layers, `.env`, `.credentials.yaml`), long-term memory (`~/.prism/storages/prism_memory/`), and the project-folder registry plus the registered project folders themselves. A disk failure or a move to a new computer loses the accumulated memory, the tuned configuration, and the project list together. The user needs a settings option that backs up these three kinds of data to a remote server over WebDAV, SMB, or S3, triggered from the settings page.

## [S2] Design

### S2.1 Package and composition

New in-tree workspace package `packages/backup/prism-backup`, name `@prism/prism-backup` — the fork's second `@prism` package, following `@prism/prism-session-import`. It carries the host half (the backup service behind `apply`, owning collection, archiving, transports, rotation, and history) and the client half (a `settings.section` page), mounted by one Loader row in `packages/bundle/web-app/cordis.patch.yml` whose `name` is the bare package name so the browser half attaches to that same row. Settings writes ride the existing `remote.settings` surface and secrets ride `remote.credentials`, so the feature adds no generated Typert namespace and edits no upstream-owned assembly file except that patch. The patch row carries a `PRISM-DIVERGENCE` marker and joins the [fork-upstream-divergence](fork-upstream-divergence.md) index as area A11.

### S2.2 Configuration

One active target at a time; switching type hides the other type's fields without clearing them. Flat volatile Config fields on `PrismBackupService.Config`, with the shipped defaults restated in the patch row:

- `targetType`: `webdav | s3 | smb` (default `webdav`).
- WebDAV: `webdavUrl` (base URL including the server's WebDAV path).
- S3: `s3Endpoint` (empty means the AWS endpoint for `s3Region`), `s3Region` (default `us-east-1`), `s3Bucket`, `s3PathStyle` (default `false`; `true` for MinIO and most self-hosted servers).
- SMB: `smbPath` (a UNC path `\\server\share\folder` or a mapped drive letter).
- Common: `username` (WebDAV/SMB login; unused by S3), `s3AccessKeyId`, `remoteDir` (default `prism-backup`), `includeSettings`/`includeMemory`/`includeProjects` (default `true`), `projectExcludes` (default segment list in S2.4), `maxBackups` (default `10`, `0` keeps every archive).

Schema validation covers per-field ranges and shapes only. Required fields are resolved when a run or a connection test starts, not when the page saves: a cross-field `.check()` would refuse the first save after a protocol switch, before the user had a chance to fill the new fields. That resolver fails with a typed, actionable error naming each missing field, and a missing password by its credential reference — misconfiguration fails loud, never as a silent skip.

### S2.3 Secrets

Password-type values never enter the Config or any patch file. They are ordinary credential references in the provider-managed file layer — `PRISM_BACKUP_WEBDAV_PASSWORD`, `PRISM_BACKUP_SMB_PASSWORD`, `PRISM_BACKUP_S3_SECRET_KEY` — written from the settings page through the existing `remote.credentials.set`/`unset`/`describe` surface, exactly as the Models page manages provider keys, so the values land in `~/.prism/.credentials.yaml` and nowhere else. The host resolves each reference once per run with `ctx.credentials.resolve`, so a changed password reaches the next run without a restart, and the page renders only `describe()`'s `configured` flag, never a value. A target URL that itself carries `user:password@` is refused as `not-configured` instead of being silently stripped: a stripped URL would send an anonymous request and turn a working password into a 401, and the typed value would still sit in the patch file. The settings page and the plugin README disclose that the backup archive contains `.env` and `.credentials.yaml`, so a backup target must be a server the user trusts.

### S2.4 Archive layout

Every archive is one zip named `prism-backup-<yyyyMMdd-HHmmss>.zip` under `remoteDir`, streamed with fflate to a staging file under `dshCachePath('backups')` and deleted after upload. Members:

| Member | Source |
| --- | --- |
| `prism-backup/manifest.json` | written last: format version, creation time, app name and version, per-source counts and byte totals, host platform, the sources that were absent, and the entries skipped while walking |
| `prism-backup/settings/profile-cordis.patch.yml` | the profile's patch file (`profileContext`) |
| `prism-backup/settings/home-cordis.patch.yml` | `~/.prism/cordis.patch.yml` |
| `prism-backup/settings/env` | `~/.prism/.env` |
| `prism-backup/settings/credentials.yaml` | `~/.prism/.credentials.yaml` |
| `prism-backup/memory/prism_memory/**` | the whole `storages/prism_memory` directory |
| `prism-backup/workspace/registry.json` | `~/.prism/storages/workspace.json` |
| `prism-backup/projects/<index>-<folderName>/**` | each registered project folder's files |

Optional members ship when their source exists and are recorded as absent in the manifest otherwise. Project walking applies `projectExcludes` as path-segment matches (default: `.git`, `node_modules`, `dist`, `build`, `out`, `target`, `coverage`, `__pycache__`, `.venv`, `venv`, `.next`, `.turbo`, `.cache`, `.DS_Store`), skips unreadable entries with a recorded warning in the manifest, and prefixes folder names with their collection ordinal, checked against a verbatim path set, so same-named folders cannot collide. Session data is never included.

### S2.5 Transports

One internal interface: two implementations over the process-global fetch dispatcher and one over the operating system's file session:

- **WebDAV**: `PUT` for upload, `MKCOL` for missing parent collections (created on the first `409`/`404`, then one retry), `PROPFIND` Depth 1 for listing, `DELETE` for rotation, Basic auth.
- **S3**: header-form SigV4 with `x-amz-content-sha256: UNSIGNED-PAYLOAD` so uploads stream from the staged file; `PutObject`, `ListObjectsV2` (one page, so a retention pass sees at most 1000 keys), `DeleteObject`; path-style or virtual-host addressing per `s3PathStyle`. `list` answers names below the requested prefix, like the other two transports, because rotation reasons about basenames. The signing implementation is tested against AWS's published SigV4 test vector, and the transport signs exactly the headers it sends.
- **SMB**: plain `node:fs` over `smbPath` — a UNC path or mapped drive uses the OS session's credentials. When the path is unreachable and a username and password are stored, Windows additionally runs one `net use <path> <password> /user:<username>` bootstrap and retries once; the password argument is visible in the process table for the bootstrap call, which the README states. On macOS and Linux SMB requires a pre-mounted path; the test-connection result says so.

### S2.6 Run orchestration

`PrismBackup.run()` is single-flight: a second call while one is active fails with `prism-backup/busy` instead of queueing. The run advances through collect → zip → upload → rotate and publishes its current phase and byte/file counts in the in-memory state the settings page polls. Completion appends one run record to the `prism_backup` storage domain (per-record table), and the list is pruned to the 20 most recent. A record carries id, start and finish times, `success | failed`, the target type and sanitized endpoint (URL userinfo stripped, no credential), the archive name, the destination object key, archive size, member counts, and the failure's code and message. A history store that cannot open — a corrupt record file, say — degrades to empty history with one logged warning instead of failing the plugin, and a run whose append is refused still reports its own outcome. Failures use the `prism-backup/*` table (`not-configured`, `busy`, `connection-failed`, `auth-failed`, `upload-failed`, `collect-failed`, `failed`), each thrown next to its check with the underlying error as `cause`: reading the sources raises `collect-failed`, a transport refusal raises its own code, and a compression, staging, or otherwise unclassified failure is `failed`.

### S2.7 Host route

The plugin registers one exact POST route, `/api/prism.backup`, through `ctx.connection.fetch.register` — the same channel `file-upload` uses for work that cannot ride JSON Remote invocation, and the reason this feature needs no generated Typert namespace or Remote contribution. The buffered JSON body carries an `action`: `state` (running phase plus the history records), `run` (starts a run, answers its record), or `test` (per-type reachability with an actionable message). Answers are a JSON envelope `{ ok: true, value }` or `{ ok: false, error: { code, message } }` whose code is the `prism-backup/*` table. The page polls `state` every second whenever the Host reports a run in flight — including one it did not start, so a page opened mid-run follows it — and stops when the run settles or the plugin unloads; settings writes and secret writes keep riding their existing Remote surfaces.

### S2.8 Settings page

A `settings.section` registration (id `backup`, order `25`, after agent presets) rendered by the package's client half, reading live config through the config-forms service the way the models page does and writing through `form.mutate` with the expected revision. Page structure: target-type picker, connection fields for the active type with write-only secret inputs that show stored or missing and offer Clear when one is stored, content toggles, the exclude list in a multi-line control next to the retention field, and a history list (time, status, size, target, failure detail). Every string lives in the package's `locales.ts` pair, zh as the key-set source of truth and en mirroring it, so `verify-client-ui-i18n` stays clean; buttons name their outcome (`Test connection`, `Back up now`), and the success notice reads `Backup finished.`

## [S3] Scope

- In scope: the `@prism/prism-backup` package (host service, Remote namespace, client settings page), WebDAV/S3/SMB transports, one-shot backup of settings + memory + project folders and the workspace registry, rotation, run history, bilingual docs and UI copy, unit and integration tests.
- Out of scope: restore or import from an archive (the manifest keeps archives self-describing for a later feature), scheduled backups, multiple named targets, session-data backup, an agent-facing backup tool, and end-to-end tests against real remote servers.

## Tasks

- [x] T1: scaffold the package — manifest, face configs, tsdown via `clientBundle` (host phase), the web-app loader row, service and route; `build:artifacts` and a web-profile boot stay green (depends: none)
- [x] T2: Config schema with checks, credential-reference resolution, `prism_backup` storage domain (depends: T1)
- [x] T3: WebDAV, S3 (SigV4 against published vectors), and SMB transports with unit tests (depends: T1)
- [x] T4: orchestrator — collect, zip, upload, rotate, phases, history — with integration tests over a fake transport (depends: T2, T3)
- [x] T5: the POST route, failure-code table, and host-side specs (depends: T4)
- [x] T6: client settings page, locale pair, slot registration, run/test/state fetch wiring (depends: T5)
- [x] T7: README pair, divergence index area A11, config-catalog regeneration if the generator scans the package (depends: T6)
- [x] T8: full verification — build, tests, coverage, typecheck, doc and i18n gates (depends: T7)
- [x] T9: review findings — bundle dependency, S3 listing names, single-flight claim, stage-specific failure codes, manifest bytes and object key, reload polling, multiline exclusions, clear-secret control (depends: T8)

## [S4] Acceptance

- [x] The web bundle declares the package, Loader boots the row from its bare name, and the client renders a Backup section in settings.
- [x] Saving connection fields persists them to the profile patch; passwords are written only through the credential surface, whose values live in `.credentials.yaml`, and no Config field or patch row can carry one.
- [x] `test` reports reachability per active type with an actionable failure message.
- [x] The WebDAV transport uploads one zip whose members, manifest counts, and manifest byte totals match the plan.
- [x] SigV4 signing matches AWS's published vector, and the S3 transport signs exactly the headers it sends.
- [x] Rotation keeps `maxBackups` archives and deletes the oldest beyond it, including when the store lists full keys.
- [x] Two runs starting in the same tick produce one run and one `busy` refusal.
- [x] History stays bounded at 20 records, survives a service restart through the storage domain, and degrades instead of failing when the store cannot open.
- [x] `typecheck` (both aggregates), `build:artifacts` + `build:check`, and the doc/i18n gates pass on the worktree; every `packages/backup/prism-backup/src` file is at 100% coverage.
