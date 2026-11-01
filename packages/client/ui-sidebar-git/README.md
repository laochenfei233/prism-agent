---
description: "The right Sidebar's Git workbench tab type for the dsh web client: repository status, staged, unstaged, and untracked sections, one file's comparison, and staging or committing from the panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-git

English | [中文](README.zh.md)

## Summary

Work with the Session's repository without leaving the conversation. The panel lists the branch, its divergence from the upstream, and every changed path in three sections; a row opens that file's comparison against the index or the work tree, and the footer stages or commits. Two of the three index mutations — stage and unstage — sit on the rows themselves. The Host half serves the five authenticated routes the panel reads; the browser half registers the tab type and never talks to git.

## Table of Contents

- [What it registers](#what-it-registers)
- [Routes](#routes)
- [The panel](#the-panel)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="what-it-registers"></a>
## What it registers

The tab type takes the public two-stage path every right-Sidebar type takes: `ctx.sidebarRightTabs.register` declares a page type with kind `git`, no resource patterns, and one guide entry (order 15, between the file tree's 10 and the terminal's 20); the keyed `sidebar.right.pane.tab` seat renders the body and `sidebar.right.pane.tab.title` renders the chip title. Both sit inside the package's own `ctx.effect`, so they leave with it.

The Host half registers five routes on the Connection authentication fence through `ctx.connection.fetch.register`. This package does not add a Typert Remote service: the panel exchanges small request-and-response records, needs no stream, and gains nothing from a generated wire type.

<a id="routes"></a>
## Routes

| Route | Method | Answer |
|---|---|---|
| `/api/git.status` | GET | `{ available, repo, root?, branch?, ahead?, behind?, entries }`; `entries` is empty when `repo` is false |
| `/api/git.diff` | GET | `?path=&side=index\|worktree` → `{ kind: 'text', hunks }`, `{ kind: 'binary' }`, or `{ kind: 'untracked' }` |
| `/api/git.stage` | POST | `{ sessionId, paths }` → the status after staging |
| `/api/git.unstage` | POST | `{ sessionId, paths }` → the status after unstaging |
| `/api/git.commit` | POST | `{ sessionId, message }` → the status after the commit |

Every route resolves the Session's working directory on the Host and locates the repository with `git rev-parse --show-toplevel`; the client never supplies a path the Host trusts. A path that is absolute, empty, contains a NUL byte, or escapes the repository root is refused with 400. A failed git command answers 422 with its stderr tail, which the panel shows in place.

Commands run through `GitRunner` from `@deepseek-ai/dsh-workspace-changes`, so the scrubbed environment, timeout, and output cap are shared with turn-change recording. `timeoutMs`, `outputMaxBytes`, and `maxMessageBytes` are validated `Config` fields.

<a id="the-panel"></a>
## The panel

The header shows the branch, the commits ahead of and behind the upstream, and a refresh control that also answers the tab's refresh command. The body groups the entries into staged, unstaged, and untracked sections; a row's action stages or unstages exactly that path, and a press on the row itself opens its comparison under the row. The footer holds the commit message and the commit control, which is unavailable while nothing is staged, while the message is empty, or while a commit is in flight.

The panel reads at mount and again after every mutation; a mutation answers with the status it leaves behind, so there is no second round trip. It does not poll and does not watch the repository, and one read per tab is in force: a newer request retires an older settlement, and a tab whose record has gone writes nothing.

<a id="model-experience"></a>
## Model Experience

None, as the package adds a browser-side panel and Host routes and registers nothing model-facing.

#### KV Cache effect

None; no request is assembled or sent by this package.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The panel commits whole paths. Hunk-level staging, branch switching, history, pull and push, and conflict resolution are out of scope.
- An untracked file has no comparison until it is staged; its row says so instead of reading the file.
- Unstaging tries `git reset HEAD` first and falls back to `git rm --cached` only for a repository whose HEAD is unborn.
- The status is a snapshot the panel asked for. Nothing refreshes it while the panel sits open and the working tree changes elsewhere.
