---
feature: session-autoarchive
status: in-progress
updated: 2026-11-01
branch: feat/session-autoarchive
commits: 724259145a..HEAD
---

# Auto-archive idle Sessions

English | [中文](session-autoarchive.zh.md)

## Report

## [S1] Problem

The Session list only grows. Archiving is a manual per-Session action in the sidebar, so a user who has talked in several hundred Sessions keeps every one of them in the list until they clean up by hand, and nobody does that. The wanted behavior is a scheduled sweep: a top-level conversation with no dialogue for 30 days (default) joins the existing archive set on its own, and the threshold is adjustable from Settings.

Two facts constrain the design. The archive set already exists — `workspaceRegistry.archiveSession()` hides a Session from every grouping surface, keeps its workspace slot, and the client learns about the write through the Workspace follow frames. The session read model does not expose when a Session was last active: `SessionHeader` carries `createdAt` only, and the `sessionListMetadata` projection that a Session list uses for `lastPromptAt` exists only for Sessions the projection cache has checkpointed.

## [S2] Design

**Decisions confirmed in the grill (2026-11-01):**

| Axis | Decision |
|---|---|
| Where the behavior lives | A new Prism plugin, not a core package: `plugins/prism-session-autoarchive` |
| What "archive" means | The existing durable archive set (`workspaceRegistry.archiveSession`), restorable by the user |
| Base branch | A new branch off the current checkout tip |

**D1 — Last-activity fact.** `SessionPersistenceSnapshot` gains an optional `updatedAt` (epoch milliseconds), filled by the JSONL backend from the artifact `mtime` it already reads for `sizeBytes` in `stat()` and `list()`. This is the smallest source that is correct for every Session: the header cannot answer it, the projection cache answers it only for checkpointed Sessions, and reading event logs to find the last event would decompress the whole store on every sweep. `mtime` is a conservative bound — a write only advances it, so the sweep can archive a Session late but never one that was used inside the window. The field is a read-model fact, not persisted Session data, so no Session format version changes.

**D2 — Which Sessions the sweep touches.** Only top-level user conversations: skip a Session that is already archived, that is pinned (archiving would silently drop the pin), that carries `origin: 'subagent'` or a `parentSession` (archiving a parent's still-resumable child would make the archived-session gate refuse that child's later steps), and that is newer than the cutoff. The one clock is `max(header.createdAt, snapshot.updatedAt ?? 0)`.

**D3 — Archiving an active Session.** The sweep calls `archiveSession(id)` without `stopActivity`. The registry's own `workspace/session-activity` waterfall then refuses a Session with running work (`WorkspaceActiveSessionError`), and the sweep logs it at debug level and continues with the next Session. Auto-archiving must never cancel a user's running turn, so the refusal is the intended outcome rather than something to work around.

**D4 — Scheduling.** `ctx.interval` (the injected `timer` service) runs the sweep every `sweepIntervalMinutes`, plus one sweep 60 seconds after load so a restart does not postpone the first pass by a full interval; the 60-second delay is a boot guard, not a deployment choice. One sweep at a time: a tick that arrives while the previous sweep is still running returns immediately, so a slow listing cannot stack. A failing sweep logs a warning and leaves the next tick armed; nothing is retried inside the same pass.

**D5 — Configuration.** Three fields, all `.volatile()` so the Settings page generated from the schema edits them live: `enabled` (default `true`), `idleDays` (default `30`, 1–3650), `sweepIntervalMinutes` (default `1440`, 5–10080). The values live in `cordis.patch.yml` as the shipped defaults, and `resolveConfig` states each one explicitly rather than relying on the Loader to apply it.

**D6 — Required services.** `inject = ['workspaceRegistry', 'sessionPersistence', 'timer']`. A composition without any of them cannot sweep correctly, so the plugin fails at load instead of degrading to a silent no-op.

## [S3] Scope

- In scope: the `updatedAt` read-model field on `SessionPersistenceSnapshot` and its JSONL backend fill; the new plugin package (config, sweep, selection, `cordis.patch.yml`, README pair); unit tests for selection and archiving; installing the built plugin into the local `~/.prism` profile so the running app exposes the Settings switch.
- Out of scope: a client UI beyond the auto-generated Settings page; any change to what the archive set means or how the sidebar renders archived Sessions; deleting Session data; archiving blank Sessions (Sessions that never received a user message); a manual "archive now" command; headless profiles without the Workspace registry.

## Tasks

- [x] T1: add `updatedAt` to `SessionPersistenceSnapshot` and fill it in the JSONL backend's `stat`/`list`, with a spec assertion (depends: none)
- [x] T2: scaffold `plugins/prism-session-autoarchive` (package.json, tsconfig, tsdown, vitest, cordis.patch.yml, .gitignore) (depends: none)
- [x] T3: implement config resolution and the sweep selection/archiving in `src/` (depends: T1, T2)
- [x] T4: unit tests for selection and archiving, and a composition test that a running Session is refused (depends: T3)
- [x] T5: README pair plus bilingual pairing record (depends: T3)
- [x] T6: build the plugin and install it into the local profile, then verify the Settings entry (depends: T4, T5)

## [S4] Acceptance

- A top-level Session whose last activity is older than `idleDays` is added to the archive set by one sweep; a Session inside the window is not.
- Already-archived Sessions, pinned Sessions, subagent Sessions, and forked Sessions are never archived by the sweep.
- A Session with running work is refused by the registry and the sweep continues with the remaining Sessions.
- `idleDays` and `enabled` are editable from the Settings page and the next sweep uses the new values.
- `sessionPersistence.list()` reports `updatedAt` for a stored Session in the JSONL backend, and the field's contract is documented on the snapshot type.

## Delivery notes

- The plugin is installed in `~/.prism/profiles/web` as a profile dependency (`prism plugin --profile web add file:…`), and `prism --profile web --dump-config` composes its entry with the shipped config. Activation in the running app waits for the next launch: the desktop shell rewrites the profile bundle list at start-up, which dropped a hand-written entry, and the profile's plugins mount only when the app spawns the server.
- `gen-cordis-catalog` already fails on this checkout before this change (24 signature type-link violations in unrelated services such as `speechToText`), so the generated API catalog cannot be refreshed; the hand-maintained `docs/subsystems/persistence.md` copy of `SessionPersistenceSnapshot` is updated instead.
