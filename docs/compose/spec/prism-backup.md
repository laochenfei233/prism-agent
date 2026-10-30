---
feature: prism-backup
status: in-progress
updated: 2026-10-30
branch: feat/prism-backup (worktree .worktrees/prism-backup)
commits: 1a63913b (base)..delivery worktree
---

# Prism Backup

English | [中文](prism-backup.zh.md)

## Report

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

A `.check()` validates the fields the active `targetType` requires and rejects cross-type leftovers only when they are invalid for their own type. Run-time resolution repeats the per-type check and fails with a typed, actionable error naming each missing field — misconfiguration fails loud, never as a silent skip.

### S2.3 Secrets

Password-type values never enter the Config or any patch file. They are ordinary credential references in the provider-managed file layer — `PRISM_BACKUP_WEBDAV_PASSWORD`, `PRISM_BACKUP_SMB_PASSWORD`, `PRISM_BACKUP_S3_SECRET_KEY` — written from the settings page through the existing `remote.credentials.set`/`unset`/`describe` surface, exactly as the Models page manages provider keys, so the values land in `~/.prism/.credentials.yaml` and nowhere else. The host resolves each reference once per run with `ctx.credentials.resolve`, so a changed password reaches the next run without a restart, and the page renders only `describe()`'s `configured` flag, never a value. The settings page and the plugin README disclose that the backup archive contains `.env` and `.credentials.yaml`, so a backup target must be a server the user trusts.

### S2.4 Archive layout

Every archive is one zip named `prism-backup-<yyyyMMdd-HHmmss>.zip` under `remoteDir`, streamed with fflate to a staging file under `dshCachePath('backups')` and deleted after upload. Members:

| Member | Source |
| --- | --- |
| `prism-backup/manifest.json` | written last: format version, creation time, app name and version, per-content counts and bytes, host platform, and the settings files that were absent |
| `prism-backup/settings/profile-cordis.patch.yml` | the profile's patch file (`profileContext`) |
| `prism-backup/settings/home-cordis.patch.yml` | `~/.prism/cordis.patch.yml` |
| `prism-backup/settings/env` | `~/.prism/.env` |
| `prism-backup/settings/credentials.yaml` | `~/.prism/.credentials.yaml` |
| `prism-backup/memory/prism_memory/**` | the whole `storages/prism_memory` directory |
| `prism-backup/workspace/registry.json` | `~/.prism/storages/workspace.json` |
| `prism-backup/projects/<index>-<folderName>/**` | each registered project folder's files |

Optional members ship when their source exists and are recorded as absent in the manifest otherwise. Project walking applies `projectExcludes` as path-segment matches (default: `.git`, `node_modules`, `dist`, `build`, `out`, `target`, `coverage`, `__pycache__`, `.venv`, `venv`, `.next`, `.turbo`, `.cache`, `.DS_Store`), skips unreadable entries with a recorded warning in the manifest, and prefixes folder names with their registry index so same-named folders cannot collide. Session data is never included.

### S2.5 Transports

One internal interface, three implementations over the process-global fetch dispatcher:

- **WebDAV**: `PUT` for upload, `MKCOL` for missing parent collections (created on the first `409`/`404`, then one retry), `PROPFIND` Depth 1 for listing, `DELETE` for rotation, Basic auth.
- **S3**: header-form SigV4 with `x-amz-content-sha256: UNSIGNED-PAYLOAD` so uploads stream from the staged file; `PutObject`, `ListObjectsV2`, `DeleteObject`; path-style or virtual-host addressing per `s3PathStyle`. The signing implementation is tested against AWS's published SigV4 test vectors.
- **SMB**: plain `node:fs` over `smbPath` — a UNC path or mapped drive uses the OS session's credentials. When the path is unreachable and a username and password are stored, Windows additionally runs one `net use <path> <password> /user:<username>` bootstrap and retries once; the password argument is visible in the process table for the bootstrap call, which the README states. On macOS and Linux SMB requires a pre-mounted path; the test-connection result says so.

### S2.6 Run orchestration

`PrismBackup.run()` is single-flight: a second call while one is active fails with `prism-backup/busy` instead of queueing. The run advances through collect → zip → upload → rotate and publishes its current phase and byte/file counts in the in-memory state the settings page polls. Completion appends one run record to the `prism_backup` storage domain (per-record table), and the list is pruned to the 20 most recent. A record carries id, start and finish times, `success | failed`, the target type and sanitized endpoint (no credentials), archive size, object key, member counts, and the failure's code and message. Failures use the `prism-backup/*` table (`not-configured`, `busy`, `connection-failed`, `auth-failed`, `upload-failed`, `collect-failed`), each thrown next to its check with the underlying error as `cause`.

### S2.7 Host route

The plugin registers one exact POST route, `/api/prism.backup`, through `ctx.connection.fetch.register` — the same channel `file-upload` uses for work that cannot ride JSON Remote invocation, and the reason this feature needs no generated Typert namespace or Remote contribution. The buffered JSON body carries an `action`: `state` (running phase plus the history records), `run` (starts a run, answers its record), or `test` (per-type reachability with an actionable message). Answers are a JSON envelope `{ ok: true, value }` or `{ ok: false, error: { code, message } }` whose code is the `prism-backup/*` table. The page polls `state` every second while a run is active; settings writes and secret writes keep riding their existing Remote surfaces.

### S2.8 Settings page

A `settings.section` registration (id `backup`, order `25`, after agent presets) rendered by the package's client half, reading live config through the config-forms service the way the models page does and writing through `form.mutate` with the expected revision. Page structure: target-type picker, connection fields for the active type with write-only secret inputs showing stored/clear state, content toggles with the exclude list and retention visible when projects are on, and a history list (time, status, size, target, failure detail). Every string lives in the package's `locales.ts` pair, zh as the key-set source of truth and en mirroring it, so `verify-client-ui-i18n` stays clean; buttons name their outcome (`Test connection`, `Back up now`, `Backed up`).

## [S3] Scope

- In scope: the `@prism/prism-backup` package (host service, Remote namespace, client settings page), WebDAV/S3/SMB transports, one-shot backup of settings + memory + project folders and the workspace registry, rotation, run history, bilingual docs and UI copy, unit and integration tests.
- Out of scope: restore or import from an archive (the manifest keeps archives self-describing for a later feature), scheduled backups, multiple named targets, session-data backup, an agent-facing backup tool, and end-to-end tests against real remote servers.

## Tasks

- [ ] T1: scaffold the package — manifest, face configs, tsdown via `clientBundle` (host phase), the web-app loader row, service and route; `build:artifacts` and a web-profile boot stay green (depends: none)
- [ ] T2: Config schema with checks, credential-reference resolution, `prism_backup` storage domain (depends: T1)
- [ ] T3: WebDAV, S3 (SigV4 against published vectors), and SMB transports with unit tests (depends: T1)
- [ ] T4: orchestrator — collect, zip, upload, rotate, phases, history — with integration tests over a fake transport (depends: T2, T3)
- [ ] T5: the POST route, failure-code table, and host-side specs (depends: T4)
- [ ] T6: client settings page, locale pair, slot registration, run/test/state fetch wiring (depends: T5)
- [ ] T7: README pair, divergence index area A11, config-catalog regeneration if the generator scans the package (depends: T6)
- [ ] T8: full verification — build, tests, coverage, typecheck, doc and i18n gates (depends: T7)

## [S4] Acceptance

- [ ] A web-profile boot composes the rows, and the client renders a Backup section in settings.
- [ ] Saving connection fields persists them to the profile patch; passwords persist only to `.credentials.yaml` and appear in no patch file.
- [ ] `testConnection` reports reachability per active type with an actionable failure message.
- [ ] A run against a local fake WebDAV server uploads one zip whose members match S2.4, including the manifest counts and the project excludes.
- [ ] SigV4 signing matches AWS's published test vectors for the requests the S3 transport sends.
- [ ] Rotation keeps `maxBackups` archives and deletes the oldest beyond it.
- [ ] History stays bounded at 20 records and survives a service restart through the storage domain.
- [ ] `pnpm run test`, `typecheck`, and the doc/i18n gates pass on the worktree; new `packages/**/src` files carry 100% coverage or a justified exemption.
