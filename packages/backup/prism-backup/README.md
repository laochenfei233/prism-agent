---
description: "Back up the Harness configuration, the long-term memory store, and the registered project folders to a WebDAV, SMB, or S3 server from the settings page."
kind: "package-reference"
---
# Prism Backup

English | [中文](README.zh.md)

## Summary

`@prism/prism-backup` archives the profile and home `cordis.patch.yml` layers, `.env`, `.credentials.yaml`, the long-term memory store, the workspace registry, and every registered project folder, then uploads the zip to one WebDAV, SMB, or S3 destination and prunes older archives. The browser half is one settings section: it edits the `prism-backup` namespace through the shared configuration forms, stores passwords through the credential surface, and drives `run`, `test`, and `state` over one POST route. Session logs are never included.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Host half is one Loader row in `dsh-web-app` (`prism-backup`) and needs `connection`, `storageDomain`, and `credentials`. It registers exactly one route, `POST /api/prism.backup`, whose buffered JSON body carries `{ "action": "state" | "test" | "run" }`. Answers are `{ ok: true, value }` or `{ ok: false, error: { code, message } }` with the HTTP status implied by the code: `400` for `prism-backup/bad-request`, `409` for `prism-backup/busy`, and `502` for every provider or configuration failure. The route is the settings page's only Host call; everything else rides existing surfaces.

Configuration is one live section: `targetType` selects the destination, the per-type fields fill it in, and `includeSettings`/`includeMemory`/`includeProjects` plus `projectExcludes` and `maxBackups` decide the archive and its retention. A run reads the live values once at its start and is single-flight: the run slot is claimed before the policy is resolved, so two requests arriving in the same tick produce one run and one `prism-backup/busy` refusal. Nothing is required to be complete until a run or a connection test starts, which is what lets a user switch protocols and fill the new fields in order; a missing field then fails with `prism-backup/not-configured` naming it.

Passwords never enter the Config: the WebDAV password, the SMB password, and the S3 secret access key are credential references (`PRISM_BACKUP_WEBDAV_PASSWORD`, `PRISM_BACKUP_SMB_PASSWORD`, `PRISM_BACKUP_S3_SECRET_KEY`) written from the page through `remote.credentials` and resolved once per run. The page renders only whether one is stored.

### What one archive holds

| Member | Source |
| --- | --- |
| `prism-backup/manifest.json` | format version, creation instant, app name and version, platform, per-source counts and byte totals, absent sources, skipped entries |
| `prism-backup/settings/profile-cordis.patch.yml` | the active profile's patch file |
| `prism-backup/settings/home-cordis.patch.yml` | `$DSH_HOME/cordis.patch.yml` |
| `prism-backup/settings/env` | `$DSH_HOME/.env` |
| `prism-backup/settings/credentials.yaml` | `$DSH_HOME/.credentials.yaml` |
| `prism-backup/memory/prism_memory/**` | the whole memory store |
| `prism-backup/workspace/registry.json` | the workspace registry |
| `prism-backup/projects/<index>-<name>/**` | each registered project folder, minus excluded segments |

Every optional member ships when its source exists and is listed as absent otherwise; a project folder that disappeared is a warning in the manifest, not a failed backup. The archive is written to `$DSH_HOME/cache/backups` while it uploads and deleted afterwards. Rotation lists the remote directory, keeps the newest `maxBackups` archives (including the one just written; `0` keeps all), and deletes the rest; every transport answers names below the requested directory, so a store that reports full keys rotates correctly too. A run record keeps the destination object key, the sanitized endpoint (URL userinfo stripped), the archive size, and the per-source counts. History lives in the `prism_backup` storage domain and degrades to empty — with one logged warning — when that store cannot open, rather than failing the plugin.

### Config

| Field | Default | Meaning |
|---|---:|---|
| `targetType` | `webdav` | Active destination protocol: `webdav`, `s3`, or `smb` |
| `webdavUrl` | empty | WebDAV base URL including the server's collection path |
| `s3Endpoint` | empty | S3 endpoint origin; empty derives the AWS endpoint from `s3Region` |
| `s3Region` | `us-east-1` | Signing region |
| `s3Bucket` | empty | Receiving bucket |
| `s3PathStyle` | `false` | Address the bucket as `endpoint/bucket` (MinIO and most self-hosted services) |
| `smbPath` | empty | UNC path or mounted directory receiving archives |
| `username` | empty | WebDAV or SMB user name; S3 ignores it |
| `s3AccessKeyId` | empty | S3 access key id; the secret key lives in the credential store |
| `remoteDir` | `prism-backup` | Directory below the target root that holds archives |
| `includeSettings` | `true` | Archive the configuration files |
| `includeMemory` | `true` | Archive the long-term memory store |
| `includeProjects` | `true` | Archive the workspace registry and project folders |
| `projectExcludes` | `.git`, `node_modules`, `dist`, `build`, `out`, `target`, `coverage`, `__pycache__`, `.venv`, `venv`, `.next`, `.turbo`, `.cache`, `.DS_Store` | Path segments never walked; one per line or comma-separated |
| `maxBackups` | `10` | Archives kept after a run; `0` keeps every archive |

The generated [configuration catalog](../../../docs/config-catalog.md#prismprism-backup) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as the feature registers no prompt, tool, or session event and no archive byte reaches a model request.

#### KV Cache effect

No direct effect; a backup never reads or writes a model request context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Restore is not implemented: an archive is self-describing through its manifest, but nothing reads it back into a Harness home yet.
- There is no schedule. Backups run only when the user presses the button, and a Host that is closed backs up nothing.
- One target exists at a time. Switching protocols keeps the other protocols' fields in the same section but runs only the selected one, so two destinations need two manual runs.
- S3 rotation reads one `ListObjectsV2` page, so it reasons about at most 1000 archives; a wider directory keeps the newest page's worth.
- A run whose history append is refused still reports success and its archive still lands; only durable history is lost.
- SMB runs through the operating system's file session. A Windows path gets one `net use` bootstrap when a password is stored, and that call's password argument is visible in the process table; macOS and Linux need the share mounted already.
- The archive contains `.env` and `.credentials.yaml`, so the destination must be a server the user trusts.
- Session data is deliberately excluded; it has its own export under [`dsh-session-log-export`](../../session-query/session-log-export/README.md).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The feature is a plugin, not a loop change: the Host half is `apply` plus `src/run.ts`, and the browser half registers one `settings.section`. Three seams it does not own carry the product: `ctx.settings` projects this package's Config into the page, `ctx.credentials` stores the passwords, and `ctx.storageDomain` keeps run history under `prism_backup`. The POST route exists because a backup is a file transfer with progress rather than a JSON Remote call; `dsh-client-file-upload` registers its own POST route for the same reason.

SigV4 is implemented over the process-global fetch rather than an SDK: the transport signs `UNSIGNED-PAYLOAD` so the staged archive streams without a body hash, and the signed headers are exactly the ones sent, which is why a caller-supplied `x-amz-date` also decides the credential scope. AWS's published Signature Version 4 test vector is the unit test that keeps this honest.

Two additions are easy to get wrong on a later change. An archive member's name is also its restore path, so a new source needs an explicit `prism-backup/<area>/...` member name in `collect.ts`. And rotation compares archive names, not server timestamps, so the `prism-backup-<yyyyMMdd-HHmmss>.zip` spelling in `run.ts` is the ordering contract.

</details>
