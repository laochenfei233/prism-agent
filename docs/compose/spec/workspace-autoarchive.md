---
feature: workspace-autoarchive
status: in-progress
updated: 2026-11-21
branch: feat/workspace-autoarchive
commits: f9433f3732..HEAD
---

# Auto-archive idle Workspaces

English | [中文](workspace-autoarchive.zh.md)

## Report

## [S1] Problem

Projects never leave the sidebar. The session auto-archive sweep already hides every conversation idle for `idleDays`, so a project ends up rendering an empty section — and a workspace the user has abandoned months ago still occupies the list forever. The wanted behavior rides the same sweep: once a project holds no visible conversations and its newest activity is older than the project window (7 days of conversation idle plus 7 more, 14 total in this deployment), the project itself joins an archive set and disappears from the sidebar, the workspace picker, and search. Re-adding the same folder later must bring the original project back — same identity, title, order, and session accounting — never a second registration, and Settings gains an "archived projects" section listing what is hidden with per-row restore.

## [S2] Design

**Decisions confirmed in the grill (2026-11-21):**

| Axis | Decision |
|---|---|
| Where the behavior lives | The existing `prism-session-autoarchive` plugin: the same sweep pass evaluates Workspaces after archiving conversations |
| What "archive a project" means | A new registry-global archive set, display-level only: records, order, titles, pins, and session accounting stay untouched |
| Restore entries | Re-adding the folder (registry `create`) restores, and a Settings "archived projects" section lists hidden Workspaces with per-row restore |
| Project window | `projectIdleDays`, default 14, absolute from newest activity — with the deployment's `idleDays: 7` this is exactly 7+7 |

**D1 — The Workspace archive set.** `workspaceDomainState` gains `archivedWorkspaceIds: z.array(workspaceId).default([])`, the same defaulted-field pattern `archivedSessionIds` introduced; stored globals written before the field parse unchanged, so the domain version stays 2. Like the Session archive set, the set is advisory display state: `WorkspaceRecord`, `workspaceIds` order, membership, and pins never change when a Workspace is archived or restored, so a restore is byte-identical to the state before the archive. The set is not validated against the `workspaces` table at startup — a stale id after a crash-window delete is harmless (every consumer tolerates unknown ids) and the Session sets set the same lenient precedent.

**D2 — Registry API.** `WorkspaceRegistry` gains `archivedWorkspaceIds`, `archiveWorkspace(id)`, and `unarchiveWorkspace(id)`, both queue-serialized, idempotent, and tolerant of unknown ids like their Session counterparts. `deleteKnown` drops the id from the set in its durable writes. `createCanonical`'s existing canonical-path reuse branch drops the id inline (inside the queued operation, never through the public method — the queue would wait on itself): re-adding a folder restores the original registration. `validateStoredState` is unchanged.

**D3 — Re-add restores through every create path.** `WorkspaceCommands.create` currently early-returns on a `resolveByPath` hit; it now always calls `registry.create(path)` — which unhides on reuse — and computes `created` from the pre-resolve, so the controller, the import engine, and any other internal caller all restore instead of registering anew. The canonical-path canon already guarantees no duplicate record can exist, so "project (2)" is impossible by construction.

**D4 — Wire and client model.** `WorkspaceBaseline` gains `archivedWorkspaceIds`, and one new follow increment `{ type: 'archived-workspaces', archivedWorkspaceIds }` joins the existing `archived`/`pinned` set frames; the feed diffs the field off the parsed domain state exactly as it does the Session sets. The client model carries the set in its snapshot, the service decodes the frame, and `UiWorkspaceService` gains `unarchiveWorkspace(workspaceId)` calling the new Remote method with the same echo discipline as the Session mutations.

**D5 — New Remote methods.** `workspace.archiveWorkspace` and `workspace.unarchiveWorkspace` accept a `workspaceId` and return the complete updated set. Archiving an unknown id rejects with `WorkspaceUnknownWorkspaceError`, the loud match of `archiveSession`; unarchiving tolerates any id because removal cannot introduce an unknown one, matching `unarchiveSession`.

**D6 — Client projection filter.** Snapshots stay authoritative — hidden Workspaces remain in `items` — and every projection filters by the set: sidebar tree sections, the conversation-hero Workspace picker, and session search. A hidden Workspace's Sessions render nowhere, exactly like archived Sessions.

**D7 — Sweep evaluation.** After the conversation pass, one Workspace pass over `registry.list()`: visible means a top-level unarchived Session (`origin` not `subagent`, no `parentSession`, pinned counts as visible) among the entity's accounted ids; activity is `max(header.createdAt, snapshot.updatedAt)` over every accounted Session — archived and subagent included, the conservative anchor — or `Date.parse(record.createdAt)` for a Workspace with no accounted Sessions. A Workspace hides when it has no visible Sessions and its activity is at least `projectIdleDays` old; a hidden Workspace with a visible Session is restored on the spot, so a scheduled follow-up, import, or webhook that attaches into a hidden Workspace brings the project back within one sweep instead of stranding Sessions in an invisible section. The default Workspace (`registry.defaultWorkspaceId`) is exempt: the pass skips it unless `includeDefaultWorkspace` is on, so the first-use Workspace stays visible. Writes go through the registry methods, so every write reaches the client through the follow frames.

**D8 — Config.** `projectIdleDays` (natural, 1–3650, default 14) and `includeDefaultWorkspace` (boolean, default `false`) join the existing fields; all volatile, and `resolveConfig` states each explicitly. There is no per-sweep cap: the pass is idempotent and bounded by the registry size.

**D11 — Opt-in by default (grill, 2026-11-22).** The master switch `enabled` defaults to `false`: automatic hygiene never runs until the user turns the switch on in the plugin's generated Settings page or states `enabled: true` in the deployment row. The shipped `cordis.patch.yml` row states every default explicitly. The user-facing behavior is documented in the plugin README pair and in the website guide page `docs/user/guide/auto-archive.md` (Automation section).

**D9 — Settings section.** The plugin's browser half (the `prism-about` packaging recipe: `dsh.client`, `./client` export, `window.__ModuleLoader__` CJS banner, shell seats declared structurally) registers `settings.section` id `archived-projects`, order 45. It reads the client Workspace snapshot, lists each hidden Workspace (title, path, age of newest activity), and restores per row through `ctx.uiWorkspace.unarchiveWorkspace`. No restore-all: restoring everything would defeat the hygiene the section exists for. Localization: zh and en dictionaries.

**D10 — Unchanged consumers.** `registry.list()`, the transfer/backup exports, and every other registry reader keep seeing hidden Workspaces; only the named projections filter. No Session data is touched, no Workspace is deleted, and the sweep never cancels running work (the Session pass's refusal semantics are untouched).

## [S3] Scope

- In scope: the domain field and registry API; the controller methods, feed frame, and client model/service plumbing; the sidebar/picker/search filters; the sweep's Workspace pass and `projectIdleDays`; the plugin's browser half with the Settings section; unit tests for each; the plugin README pair; this spec trio; a changelog entry.
- Out of scope: deleting Workspace records or Session data; a manual "archive project" gesture in the client; restoring archived conversations (the conversations section owns that); the merge of the archived-conversations client half from `feat/prism-session-autoarchive`; recorded-session snapshot support beyond what the existing harness covers; Python SDK projection of Workspace frames.

## Tasks

- [ ] T1: domain field + registry set/get/archive/unarchive, create-reuse restore, delete cleanup (covers: D1, D2, D3)
- [ ] T2: controller methods + feed baseline/frame + client model/service/UiWorkspace (covers: D4, D5)
- [ ] T3: client filters in tree, picker, and search (covers: D6)
- [ ] T4: sweep Workspace pass + `projectIdleDays` config (covers: D7, D8)
- [ ] T5: plugin browser half, Settings section, locales, packaging (covers: D9)
- [ ] T6: README pair, changelog entry, spec trio pairing records (covers: S3)

## [S4] Acceptance

- [ ] A Workspace with no visible top-level Session and newest activity at least `projectIdleDays` old is in `archivedWorkspaceIds` after a sweep; its record, order, title, and `sessionIds` are unchanged.
- [ ] A Workspace with a visible top-level unarchived Session is never hidden; a hidden Workspace that gains one is unhidden by the next sweep pass.
- [ ] The default Workspace is never hidden while `includeDefaultWorkspace` is `false`, and hides like any other when it is `true`; the sweep performs no work while `enabled` is `false` (the shipped default).
- [ ] `registry.create(path)` over a hidden Workspace's canonical path unhides it and returns the existing entity; the controller reports `created: false`; no second record exists.
- [ ] The baseline carries `archivedWorkspaceIds`; a mutation publishes the new frame; the sidebar, picker, and search exclude hidden Workspaces and the Settings section lists them with a working per-row restore.
- [ ] Deleting a Workspace removes it from the set; an unknown id in the set breaks nothing.
- [ ] A stored global without the new field opens unchanged at domain version 2.
