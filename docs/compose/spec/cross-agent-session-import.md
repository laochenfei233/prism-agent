---
feature: cross-agent-session-import
status: in-progress
updated: 2026-10-29
branch: feat/session-import
commits: c64d35c4..HEAD
---

# Cross-Agent Session Import

English | [中文](cross-agent-session-import.zh.md)

## [S1] Problem

Users arrive with conversation history in other CLI agents: Claude Code, Codex, Grok, DeepSeek Harness, MiMo Code, OpenCode, OpenClaw, Hermes, Pi, and Gemini CLI. Prism Agent shows an empty sidebar for that history, and the only import work in this repository targets another DSH home ([SESSION-IMPORT-PLAN.md](../../../SESSION-IMPORT-PLAN.md)), not foreign formats.

Reading the history is not enough: the user must be able to open an imported conversation and continue it, with the prior text in the model request. The imported conversations must also land in projects: one project per working folder, and when that folder is already a project here, merging the imported sessions into it is a decision the user confirms, never a silent side effect.

## [S2] Design

### [S2.1] Package and process placement

A new package `packages/session-query/session-import` (`@prism/prism-session-import`) holds both halves: a Host function plugin that registers one authenticated Fetch route, and a browser plugin that registers a `settings.section`. The package follows the `session-log-export` shape: `apply(ctx, config)`, `dsh.client`, Host and Client tsconfig faces, `clientBundle(..., { hostPhase: true })`.

The route is `POST /api/session.import` for `plan` and `apply`, and `GET /api/session.import/candidates` for discovery. It uses `ctx.connection.fetch` rather than a Typert Remote namespace because the payloads are plain JSON, the client needs no generated types, and the same package already owns its settings UI. The route is reachable only by the owner peer under the shared API channel's authentication policy.

### [S2.2] Source catalog

Each source has one reader that turns its native store into the normalized transcript of [S2.3]. The roots are the tools' documented defaults under the OS home; `Config.roots` overrides any of them.

| Source | Default root | Read unit |
|---|---|---|
| Claude Code | `~/.claude/projects` | `<project>/*.jsonl`, excluding `<session>/subagents/**` |
| Codex | `~/.codex` | `sessions/**/rollout-*.jsonl[.zst]` and `archived_sessions/*.jsonl[.zst]`, grouped by `session_id` |
| Grok | `~/.grok/sessions` | `<encoded-cwd>/<session>/chat_history.jsonl` plus `summary.json` |
| DeepSeek Harness | `~/.dsh/sessions` | `<projectKey>/<sessionDir>/session.v4.jsonl[.zstd]` |
| MiMo Code | `~/.local/share/mimocode` | `mimocode.db` (`session`, `message`, `part`) |
| OpenCode | `~/.local/share/opencode` | `opencode.db` or legacy `storage/session/**` JSON |
| OpenClaw | `~/.openclaw/agents` | `*/agent/openclaw-agent.sqlite` (`session_windows`, `transcript_events`) |
| Hermes | `~/.hermes` | `state.db` (`sessions`, `messages`) or exported `session_*.json` |
| Pi | `~/.pi/agent/sessions` | `--<cwd>--/<timestamp>_<uuid>.jsonl` |
| Gemini CLI | `~/.gemini/tmp` | `<project>/chats/session-*.jsonl` or legacy `.json` |

The current home (`ctx.dshHomePath()`) is excluded from the DeepSeek Harness source and reported as unavailable instead of listed twice.

### [S2.3] Normalized transcript

For the nine converted sources, one reader returns:

```ts
interface ImportedSession {
  readonly key: string
  readonly source: string
  readonly title?: string
  readonly cwd?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly model?: string
  readonly messages: readonly ImportedMessage[]
}

interface ImportedMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly time: number
}
```

Only genuine user prompts and assistant text survive. System prompts, developer messages, synthetic reminders, reasoning, tool calls, tool results, attachments, and subagent sessions are dropped. Dropping tool activity keeps the next request small and avoids inventing tool-call identities DSH would try to replay; the imported conversation reads as the dialogue the user remembers. DeepSeek Harness does not use this path; it takes the native copy in S2.3a.

Limits bound memory and the model request: `Config.maxMessages` keeps the most recent messages, and `Config.maxMessageTextBytes` truncates one message with a visible marker. Both default to values sized for real stores (2000 messages, 32 KiB).

### [S2.3a] Native DeepSeek Harness copy

A DeepSeek Harness reader instead exposes the original log: the header's id, createdAt, and cwd, plus the complete committed event sequence. Apply validates the envelope, replays the events under the original session id, and never synthesizes messages. Tool calls, tool results, request headers, title events, and interruption markers therefore remain part of the session and its derived history.

A log whose format version is not the current `SESSION_FORMAT_VERSION`, or whose events the persistence validator rejects, fails that session with a reason. It is never downgraded to the text path. Before the first native write, the source home's `attachments/` directory is copied into the current home with existing files preserved, so attachment references in the history resolve.

### [S2.4] Durable session synthesis

For converted sources, the engine writes a normal top-level session through `ctx.sessionPersistence`:

1. Header `{ version: 4, id, createdAt: <first message time>, cwd, isSeeded: false, delegationDepth: 0 }`. The id is deterministic: `session-import-<sha256(source + ':' + key)>` in lowercase hex. A repeated import therefore finds the same id and skips instead of duplicating.
2. For each turn: `turn/start`, `user/message` (`surfaceOp: 'append'`), `assistant/message` (`surfaceOp: 'append'`, `stream: []`), `turn/end` with `reason: { kind: 'completed' }`. Consecutive assistant messages merge into one; a leading assistant message without a user prompt is skipped.
3. After the last event, `session/title` carries the imported title when the store provides one; otherwise the existing fallback title derives from the first user message.
4. `handle.append(events)`, `handle.flush()`, `handle.close()`. Events carry contiguous `seq` starting at 0 and monotonically non-decreasing `time`.

Because the log is a normal session log, `sessionPersistence.list()` exposes it before the next UI refresh, `session-query` decodes it, and the next prompt's request header includes the imported surface history through `deriveMessages()`. No DSH restart is required.

### [S2.5] Projects and merge confirmation

The plan groups sessions by `realpath` of the transcript's `cwd`; sessions with no cwd, or a cwd that no longer exists, import without workspace registration and are named in the result.

For each group the plan resolves `ctx.workspaceRegistry.resolveByPath(path)`:

- No workspace: the group creates one on apply, titled with `defaultWorkspaceTitle(path)`.
- Existing workspace: applying would attach imported sessions to a project the user already knows. The plan marks the group `merge: true` and `apply` rejects with `merge-confirmation-required` unless the request sets `confirmMerge: true`. The settings UI shows each affected project with its current session count and asks for one confirmation covering the listed projects.

One folder is one workspace in this registry, so imports from several tools into the same folder converge on that project by construction. The registry is the only writer; `workspace.json` is never edited from this feature.

### [S2.6] Route contract

`GET /api/session.import/candidates` returns each source's availability, root, session count, byte count, and latest activity; an unavailable source carries a reason. `POST /api/session.import/plan` takes `{ source, sessionIds?: string[] }` and returns the groups of [S2.5] plus per-session skip reasons, without writing anything. `POST /api/session.import/apply` takes `{ source, sessionIds, confirmMerge }` and returns one result per session (`imported`, `duplicate`, `skipped`, `failed` with an error message) plus the grouped workspace outcome.

Errors are structured JSON with a `code` and a human-readable `message`. Unknown source, unavailable root, malformed body, and an unconfirmed merge are 4xx; unexpected write failures are 5xx. A failure for one session does not abort the batch, and the response reports it by key.

### [S2.7] Settings UI

A new settings section `import` (order 25, after Agent presets) titled "Import conversations". The page shows one card per detected source with count, size, and last activity; a source with no data shows its expected root and an unavailable reason. A deployment that keeps a store elsewhere overrides that root through `Config.roots`. Selecting a source scans it and renders the plan grouped by project: folder path, session count, date range, and a "merges into existing project" badge. The import button opens a confirmation modal listing every project that will receive sessions, then runs `apply` with `confirmMerge` set only after that confirmation. The result view lists imported, duplicate, and failed sessions, and states that imported conversations are already in the sidebar.

Copy lives in a typed locale namespace (`settings.sessionImport`) with English and Chinese dictionaries; no product string is hardcoded in JSX.

### [S2.8] Read-only source guarantee

Readers open files with read access and SQLite databases with `readOnly: true`. Nothing under a source root is renamed, written, or deleted. Credentials, settings, model caches, and attachment blobs are never read.

## [S3] Scope

- In scope: the ten readers, the normalized transcript, plan/apply, the route, the settings section, project grouping with merge confirmation, unit tests, one real-composition test, README and package registration.
- Out of scope: importing attachments or tool-call transcripts, bidirectional sync, live watching for new foreign sessions, importing another DSH home's workspace grouping and memory (owned by [SESSION-IMPORT-PLAN.md](../../../SESSION-IMPORT-PLAN.md)), and reverse export.

## Tasks

- [ ] T1: create the package skeleton, manifest, tsconfig faces, tsdown config, and bundle registration (depends: none)
- [ ] T2: implement the normalized model, source catalog, and file readers (depends: T1)
- [ ] T3: implement the SQLite readers for MiMo Code, OpenCode, OpenClaw, and Hermes (depends: T2)
- [ ] T4: implement discovery, plan, apply, session synthesis, and workspace merge confirmation (depends: T2, T3)
- [ ] T5: implement the route and the settings section with confirmation and result views (depends: T4)
- [ ] T6: add unit tests per reader plus plan/apply tests and one real-composition test (depends: T4, T5)
- [ ] T7: write README pairs, update the group README and root layout, then run the repository gates (depends: T6)

## [S4] Acceptance

- [ ] A1: each of the ten sources is discovered at its documented root, and its reader returns user and assistant text in order with cwd, timestamps, and a stable key.
- [ ] A2: applying a plan creates decodable session logs whose `deriveMessages()` equals the imported dialogue; a second apply reports every session as `duplicate` and changes no bytes.
- [ ] A2b: a native DeepSeek Harness import keeps the original session id and complete event sequence, including `tool/call` and `tool/result`, and `Session.create` over the stored log derives the tool result into model history; attachments are present in the current home.
- [ ] A3: imported sessions appear under the project for their folder; a folder whose project already exists is merged only when `confirmMerge` is true, and rejected with `merge-confirmation-required` otherwise.
- [ ] A4: source roots are unchanged after plan and apply (file hashes and SQLite mtimes).
- [ ] A5: the settings page lists sources, previews projects, blocks import until the merge confirmation is acknowledged, and reports per-session results.
- [ ] A6: focused tests, `pnpm run typecheck`, `pnpm run build`, the package README checks, and `verify-client-ui-i18n` pass.
