---
feature: sidebar-git-workbench
status: delivered
updated: 2026-11-01
branch: feat/sidebar-workbench
commits: c22ec9f0b9..HEAD
---

# Git Workbench

English | [中文](sidebar-git-workbench.zh.md)

## Report

**What was built** — A native Git workbench tab in the right Sidebar. The panel lists the repository's branch, its divergence from the upstream, and every changed path in staged, unstaged, and untracked sections; a row opens that file's comparison against the index or the work tree, its action stages or unstages that one path, and the footer commits the staged content. Five authenticated Host routes serve status, one comparison, stage, unstage, and commit over the Connection fetch fence, reusing the shared `GitRunner` rather than copying git execution.

**Verification** — `tsc -b tsconfig.client.json` and `pnpm run build:lib:client` pass; the package's eight suites run 76 tests at 100% per-file coverage; the touched client suites (`ui-primitives`, `ui-deliverables`, `ui-sidebar-right`, `ui-sidebar-git`) pass except one pre-existing icon-count assertion that also fails on the untouched checkout; `verify-client-packages`, `verify-package-dependencies`, `gen-tsconfig-paths --check`, `verify-client-ui-i18n`, `verify-md-links`, `verify-translation-pairing`, and both catalogs are clean for this change.

**Journey log** — The first review found pathspec globbing (`[ab].txt` staging three files), the wrong comparison side for a file that is both staged and modified, a staged deletion reported as untracked, and a missing per-tab teardown; all four were fixed and covered by tests rather than by widening the panel.

## [S1] Problem

The right column already had a file tree, read-only previews, a terminal, and the turn-change review, but no Git status, staging, or commit: users had to leave for an external terminal or another client. The Host exposed only turn snapshots, never a repository status, staging, or commit channel. The community plugin `dsh-better-sidebar` shows the demand exists, but it carries an editor, a task view, and a side conversation in one 19 MB third-party package; this project needed the commit loop, natively.

## [S2] Design

### S2.1 Data channel

No Typert Remote service. The panel exchanges small request-and-response records, needs no stream, and gains nothing from generated wire types, so it reuses the `ctx.connection.fetch.register` route fence that `ui-deliverables` already proves, with the Host half in the same plugin package.

### S2.2 Routes

Every route resolves the Session's working directory on the Host; no client-supplied path is trusted.

| Route | Method | Meaning |
|---|---|---|
| `/api/git.status` | GET | `{ repo: false }`, or `{ repo: true, root, branch, ahead, behind, entries: [{ path, index, worktree }] }` |
| `/api/git.diff` | GET | `?path=&side=index\|worktree` → `{ kind: 'text', hunks }`, `{ kind: 'binary' }`, or `{ kind: 'untracked' }` |
| `/api/git.stage` | POST | `{ paths }` → the status after staging |
| `/api/git.unstage` | POST | `{ paths }` → the status after unstaging |
| `/api/git.commit` | POST | `{ message }` → the status after the commit, or 422 with the stderr tail |

### S2.3 Safety

A path is accepted only as a repository-relative spelling: absolute paths, `..` segments, NUL bytes, and empty strings are refused, and every path command runs with `GIT_LITERAL_PATHSPECS=1` so a name such as `[ab].txt` acts on one file instead of every glob match. Commands run as argv arrays, never through a shell, and inherit `GitRunner`'s scrubbed environment, timeout, and output cap; a truncated listing or comparison is refused rather than drawn with wrong numbering. Only the panel's user gestures reach the three mutations; no model-facing entry exists.

### S2.4 Reuse

`GitRunner` and `resolveGitExecutable` moved to the `workspace-changes` package root (one re-export plus a `SAFE_HOST_DEPENDENCY_EXPORTS` classification), so the new package runs git through the same scrubbed environment instead of a second implementation. `locateGitWorkspace` stays out: it redirects the object store and index for turn snapshots, which conflicts with staging and committing against the real index, so the panel locates the repository with `git rev-parse --show-toplevel`.

### S2.5 Diff row model

The pure hunk line-numbering (`hunkRows`, `DiffRow`) moved to `ui-primitives` over a structural `{ oldStart, newStart, lines }` parameter, with no dependency on a diff producer. The turn review imports it from there; the Git panel renders the same rows with its own minimal chrome (unified view only).

### S2.6 Client

The `git` tab type registers with kind `git`, a guide entry at order 15, and the `sidebar.right.pane.tab` and `.title` seats. The panel is a branch bar, three sections, an in-place comparison, and a commit footer. The store is a `defineStore` instance owned by the tab lifecycle, and the tab record's abort ends its bucket.

### S2.7 Refresh and races

The panel reads at mount and after every mutation; a mutation answers with the status it leaves behind, so no second round trip happens. It polls nothing and watches nothing. One read per tab is in force: a newer request retires an older settlement, and a request issued after abort returns without sending anything.

### S2.8 Failures

Outside a repository: an empty state. No git on the Host: an empty state. A read failure: an in-place error line. A refused commit: the stderr tail, with the draft kept.

### S2.9 Deliberately not built

- Editing and saving: writing needs a new sandboxed write channel and conflicts with the review and delivery surfaces; the native editor already handles it through `ui-open-in-app`.
- File-tree search: the composer's `@` reference already searches workspace paths.
- A `sidebar_open` tool: inline file references and Markdown links already open files in the Sidebar.
- Side conversations and a subagent topology: `ui-subagent`'s chat tab and the session header's jobs and subagent catalog already cover them.

### S2.10 Candidate enhancements, not in this change

- Change attribution: mark each row with the turn and tool that touched it, from the recorded deliverables operations.
- A model-drafted commit message: needs a new model-visible input channel, which costs more than the panel itself.
- Inline diff questions: a selection referenced as `path:line`; inline code references do not carry line numbers yet.
- LSP navigation: definitions and references inside the Sidebar, on top of `ctx.lsp`; a separate change with its own Host channel.

## [S3] Scope

- In scope: S2.1–S2.8, the two promoted exports, the new package's registration surfaces, bilingual README, and tests.
- Out of scope: branch switching, history, pull and push, conflict resolution, inline diff comments, multiple repositories, hunk-level staging.

## Tasks

- [x] T1: Export `GitRunner` and `resolveGitExecutable` from `workspace-changes` and classify them (covers: S2.4)
- [x] T2: Move `hunkRows` and `DiffRow` into `ui-primitives` and rewire the review (covers: S2.5)
- [x] T3: New package skeleton and its three registration surfaces
- [x] T4: Host read routes: repository location, status parsing, comparison parsing, argument checks (covers: S2.2, S2.3)
- [x] T5: Host write routes: stage, unstage, commit, and failure reporting
- [x] T6: Client data layer: fetch face, store, read generations (covers: S2.6, S2.7)
- [x] T7: Tab definition, guide entry, sections, comparison view, commit box, dictionaries
- [x] T8: Host and client tests, README pair, zh/en dictionaries
- [x] T9: Verification: client build, per-file coverage, gui suites, documentation gates

## [S4] Acceptance

- [x] Opening the Git tab in a repository Session shows the branch, ahead/behind, and three file sections; a non-repository Session sees an empty state instead of an error.
- [x] A row opens a unified comparison on the side its section represents; a binary file shows that it cannot be previewed.
- [x] Stage, unstage, and commit update the lists and counts; a successful commit clears the input.
- [x] A refused commit shows the stderr tail and keeps the draft.
- [x] Absolute paths, `..`, and glob-like names cannot act outside the clicked path, and each rejection has a test.
- [x] The panel starts no polling and reads the status once per write.
- [x] The package's per-file coverage is 100%, and the client build passes.
