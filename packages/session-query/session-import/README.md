---
description: "Settings import of conversation history from Claude Code, Codex, Grok, DeepSeek Harness, MiMo Code, OpenCode, OpenClaw, Hermes, Pi, and Gemini CLI."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-import

English | [中文](README.zh.md)

## Summary

`dsh-session-import` adds an Import page under Settings that reads conversation history from ten other coding agents and writes each conversation as a normal durable session in this harness. Imported sessions appear in the sidebar under the project for their recorded working folder, and the next prompt continues the conversation with the imported text in the request history. Sources are opened read-only.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package in a Web or desktop bundle that already provides Connection, Session persistence, and the workspace registry. The plugin registers two authenticated routes and a browser settings section.

### Composition

```yaml
- id: session-import
  name: '@deepseek-ai/dsh-session-import'
```

The browser half loads through the same row because the manifest declares `dsh.client`.

### Sources

The package looks for each store at its documented root under the OS home. A source that is absent, unreadable, or the current harness home itself is listed as unavailable rather than hidden.

| Source | Default root |
|---|---|
| Claude Code | `~/.claude/projects` |
| Codex | `~/.codex` |
| Grok | `~/.grok/sessions` |
| DeepSeek Harness | `~/.dsh/sessions` |
| MiMo Code | `~/.local/share/mimocode` |
| OpenCode | `~/.local/share/opencode` |
| OpenClaw | `~/.openclaw/agents` |
| Hermes | `~/.hermes` |
| Pi | `~/.pi/agent/sessions` |
| Gemini CLI | `~/.gemini/tmp` |

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `roots` | documented roots | Absolute root overrides keyed by source id. |
| `maxMessages` | `2000` | Most recent messages retained per conversation. |
| `maxMessageTextBytes` | `32768` | UTF-8 byte budget for one imported message; longer text ends with `[truncated]`. |

### Route contract

| Route | Body | Result |
|---|---|---|
| `GET /api/session.import.candidates` | none | One availability summary per source: root, session count, bytes, latest activity, and an unavailable reason code. |
| `POST /api/session.import` | `{ "op": "plan", "source": "claude" }` | Sessions grouped by canonical working folder, each group's existing workspace, and skipped sessions. Writes nothing. |
| `POST /api/session.import` | `{ "op": "apply", "source": "claude", "sessionIds": ["…"], "confirmMerge": true }` | One outcome per requested session and the workspaces that received sessions. |

`apply` rejects with `merge-confirmation-required` (HTTP 409) when a selected conversation would be added to a project that already exists and `confirmMerge` is not `true`.

### What to expect

The page scans a source, previews projects, and imports either all sessions or the projects the user leaves checked. A conversation whose folder no longer exists imports without a project and is named in the result. The same session source and id always map to the same durable session id, so repeating an import reports `duplicate` instead of writing a second copy. Each imported session carries its source title when the store records one; otherwise the existing fallback title applies after the next message.

### Failures

A malformed or unreadable transcript is skipped with its reason while the rest of the batch continues. An unknown source, a missing root, a malformed request, and an unconfirmed merge are request failures; an unexpected storage failure is a server failure. A per-session write failure is reported in the result rather than aborting the batch.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design split

The Host half ([`src/index.ts`](src/index.ts)) validates configuration, registers both Fetch routes, and constructs [`SessionImportEngine`](src/engine.ts). Source readers under [`src/sources/`](src/sources/) turn native stores into one normalized transcript ([`src/types.ts`](src/types.ts)). The engine groups sessions by canonical `cwd`, writes each selected conversation through `ctx.sessionPersistence`, and registers projects through `ctx.workspaceRegistry`. The browser half ([`src/client/ImportSection.tsx`](src/client/ImportSection.tsx)) renders the source shelf, the project preview, the merge confirmation, and the result.

### Session synthesis

The engine writes a top-level header (`version: 4`, `isSeeded: false`, `delegationDepth: 0`) with the conversation's first message time, then one turn per user prompt: `turn/start`, `user/message`, `assistant/message` with an empty stream, and `turn/end`. Consecutive assistant messages merge into one; a title from the store becomes a `session/title` event. The final events are appended, flushed, and closed through a normal persistence handle, so `sessionPersistence.list()` exposes the session before the next sidebar refresh and the next prompt's derived history includes the imported messages.

### Read-only sources

File readers stream JSONL and decode concatenated Zstandard frames; SQLite readers open the database with `readOnly: true`. Plan performs no writes, and apply never modifies a source root.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session Query package map](../README.md) — the retrieval family this package belongs to.
- [Session persistence](../../session/session-persistence/README.md) — the durable writer the engine uses.
- [Workspace registry](../../workspace/workspace/README.md) — the live project membership service.

-----

<a id="model-experience"></a>
## Model Experience

### Imported conversation history

#### What the model sees

The next user prompt in an imported session is preceded by the imported user and assistant text as ordinary derived history. System prompts, reasoning, tool calls, tool results, attachments, subagent sessions, and synthetic reminders are absent.

#### Token effect

The imported text consumes input tokens on the next request, bounded by `maxMessages` and `maxMessageTextBytes`. Truncated messages end with `[truncated]`, and the retained window keeps the most recent messages, starting at a user prompt.

#### KV Cache effect

None for the import itself; the session is new. Later turns share the normal session prefix cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Text only** — tool calls, tool results, reasoning, images, attachments, and subagent transcripts are not reconstructed.
- **No incremental sync** — a repeated import of the same source session is a duplicate; newer messages in the foreign store are not appended to the existing DSH session.
- **Best-effort undocumented stores** — OpenClaw and Hermes payload schemas vary across builds; events that carry no recognizable role and text are skipped, and a session with no usable text reports as skipped.
- **One workspace per folder** — the workspace registry keys projects by canonical path. Importing into an existing project therefore requires the explicit merge confirmation; it cannot create a second project for the same folder.
- **Message window** — older messages beyond `maxMessages` are not imported, so very long histories continue from a truncated prefix.

<a id="dev-note"></a>
### Dev Note

None.
