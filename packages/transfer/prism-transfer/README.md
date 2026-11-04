---
description: "Settings import and export of projects (workspace folder plus attached sessions) and settings values as archive files."
kind: "package-reference"
---

# @prism/prism-transfer

English | [中文](README.zh.md)

## Summary

`prism-transfer` adds an Import & Export page under Settings that moves projects and settings between installs as files. Export writes a standard zip per selection — the workspace folder, every attached session's log with subagents, media, and files — plus an optional JSON file of the settings page's editable values. Import verifies the archive entry by entry, publishes each project with one atomic rename, restores sessions under their original ids, re-stores media through the attachment service, registers the workspace, and reapplies settings. Import never overwrites existing data. The project row's secondary-press menu also carries **Export project**, which downloads that Workspace's single-project archive through the same streaming route; the settings page remains the place for multi-project and settings archives.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package in a Web or desktop bundle that already provides Connection, Session persistence, the workspace registry, the attachment service, and the settings service. The plugin registers four authenticated routes and a browser settings section.

### Composition

```yaml
- id: prism-transfer
  name: '@prism/prism-transfer'
```

The browser half loads through the same row because the manifest declares `dsh.client`.

### Route contract

| Route | Body | Result |
|---|---|---|
| `GET /api/prism.transfer/export` | query `projects` (comma-separated workspace ids), `settings=0\|1`, `secrets=0\|1` | Streamed zip (single-project or combined layout) or a settings JSON attachment; 404 for an unknown workspace. |
| `POST /api/prism.transfer/import` | streaming octet-stream zip, query `dest?` (absolute destination root) | `{ "jobId": "…" }`; the background job extracts, restores, and registers. One import at a time; a second concurrent upload answers 409. |
| `GET /api/prism.transfer/job` | query `jobId` | The job snapshot: phase, byte and session counters, per-project results, or a typed error. Unknown ids answer `{ "state": "idle" }`. |
| `POST /api/prism.transfer/settings` | buffered `prism-settings` JSON | One outcome per namespace: `applied`, `skipped` (inactive or no editable field), or `failed` with a reason. |

### Archive formats

Three version-1 formats, each self-describing through a root manifest:

- `prism-project` (single-project zip): `.prism-project.json`, `project/**` for the folder, `sessions/<id>/session.v4.jsonl` with `subagents/`, `media/`, and `files/` beside it.
- `prism-transfer` (combined zip): `.prism-transfer.json`, `projects/<n>-<title>/` children each carrying a complete `prism-project` layout, and an optional `settings.json`.
- `prism-settings`: `format`, `includeSecrets`, and `namespaces` mapping each active settings namespace to its editable values.

Export refuses a single file of 4 GiB or more (the zip writer's per-entry ceiling), skips symbolic links and unreadable files with a count, and never follows a link out of a project folder. Secrets are excluded unless the export explicitly includes them, and credential records are never exported.

### What to expect

Import validates before writing: entry-name guards (traversal, absolute paths, backslashes, drive prefixes, colon segments), duplicate and case/NFC-folded conflicts, ancestor conflicts, entry-count and per-entry size caps, and a free-space guard. The archive spools to `$DSH_HOME/cache/prism-transfer`, never memory. Sessions restore through the ordinary persistence handle with the projection checkpoint that makes their titles appear in the sidebar without being opened; media and files stream into the attachment service, whose content addresses must match the names the archive claims. A failed import leaves no staging directory and no half-published project; stale `.prism-import-*` residue is swept after 24 hours.

### Failures

Every refusal carries a stable code the page maps to zh/en copy: `bad-archive`, `bad-manifest`, `unsafe-path`, `path-conflict`, `too-many-entries`, `entry-too-large`, `crc-mismatch`, `disk-space`, `session-version`, `attachment-mismatch`, `busy`, and others. A workspace-registration failure keeps the restored files and is reported per project instead of rolling back.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design split

The Host half ([`src/index.ts`](src/index.ts)) registers the four routes and drives the job store. The export engine ([`src/export-engine.ts`](src/export-engine.ts)) scans folders under the guards and yields archive entries, reusing `sessionLogZipEntries` from `@deepseek-ai/dsh-session-log-export` for every session's log, subagents, media, and files. The import engine ([`src/import-engine.ts`](src/import-engine.ts)) reads the spooled archive through the central-directory zip reader ([`src/zip-reader.ts`](src/zip-reader.ts)), which verifies each entry's CRC-32 because fflate's streaming inflate does not. The settings transfer ([`src/settings-transfer.ts`](src/settings-transfer.ts)) projects the live settings document to its editable values and reapplies them through the revision-fenced write path with one conflict retry. The browser half ([`src/client/TransferSection.tsx`](src/client/TransferSection.tsx)) renders the export and import cards and follows the job snapshot.

### Never overwrite

Project publication renames a fully extracted staging directory onto a name probed free at publish time. Sessions dedupe by id through `sessionPersistence.stat`. Settings apply per namespace with the descriptor's revision, retrying once against a fresh revision before reporting the namespace as failed. Attachments are content-addressed, so re-importing the same archive re-publishes nothing.

### Nothing model-visible

The plugin registers no prompt, tool, or session event; it is ordinary Host file transfer plus browser settings state.

### Test coverage

`pnpm vitest run packages/transfer/prism-transfer` covers the zip reader's guards, the export and import engines, the settings transfer, the job store, and both routes' failure vocabulary. The settings-only export path needs no session services, so a composition without them can still move configuration.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Transfer package map](../README.md) — the group this package belongs to.
- [Session log export](../../session-query/session-log-export/README.md) — the session-entry producer the export reuses.
- [Workspace registry](../../workspace/workspace/README.md) — the live project membership service.
- [Prism backup](../../backup/prism-backup/README.md) — the remote whole-machine backup for a different need.

-----

<a id="model-experience"></a>
## Model Experience

None, as the feature registers no prompt, tool, or session event and no archive byte reaches a model request.

#### KV Cache effect

None; an imported session's next request carries the same derived history any stored session carries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Session logs are copied verbatim** — the header's `cwd` names the exporting machine's path and is never rewritten; grouping and resume follow the workspace record. A log whose format version this build does not run fails that import instead of being migrated.
- **No cancel, pause, or resume** — a running import runs to completion or fails; closing the app loses the job, and its staging is swept later.
- **4 GiB per file** — the zip writer's per-entry ceiling is a hard export guard, not a compression choice; larger material must be compressed or split first.
- **No encryption or foreign zips** — archives this app did not produce (no manifest) are refused, and there is no password protection.
- **The project-row export skips the page's validation pass** — the route streams the archive, or its error response, straight to the browser's download manager, so a refusal arrives as a downloaded error file instead of in-page copy; the settings page remains the place that surfaces typed failures before downloading.
- **Empty directories and very large logs** — empty folders inside a project are not archived, a session log larger than 256 MiB is refused at import (export has no such cap), and a mid-import failure keeps already-restored sessions; re-importing the same archive then reports those sessions as duplicates under the newly published folder.
