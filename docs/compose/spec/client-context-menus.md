---
feature: client-context-menus
status: delivered
updated: 2026-10-30
branch: feat/client-context-menus (worktree .worktrees/client-context-menus)
commits: 1a63913bd9..8e2ba69e14
---

# Client Context Menus

English | [中文](client-context-menus.zh.md)

## [S1] Problem

Every client surface currently shows the browser's default context menu. The session list, the project (workspace) header, conversation text, the composer, and the file tree have no secondary-click affordance, even though most of the actions a reader wants there already exist in the product.

## [S2] Design

**S2.1 — One pointer-anchored menu primitive.** `@deepseek-ai/dsh-client-ui-primitives` gains `ContextMenu`, a thin wrapper over the existing `Menu` in portal mode: the caller hands it a pointer position, it supplies `getAnchorRect` and `preventDefault`s the browser menu. `Menu` already owns keyboard walk, Escape, outside-press dismissal, and viewport clamping.

**S2.2 — Session rows reuse the shipped action list.** A secondary press on a session row opens the same `sidebar.workspaces.session.menu.item` entries the "..." menu shows, so the two surfaces cannot drift. New shipped entries are registered in `ui-workspace` beside the existing ones: reveal in file manager (`session.openWorkspacePath` with `action: 'reveal'`), copy path (`cwd`), and open settings (`settings.open` command). Items with no backing capability are omitted rather than disabled: move to group (a session belongs to the workspace its `cwd` resolves to), copy task path and copy log path (the client is never given Session storage paths), and mark unread (no durable unread fact exists).

**S2.3 — Project rows get their own menu.** New task, move to top, move to bottom, reveal directory, rename, delete, and a disabled export placeholder. "Copy" is omitted: a directory has exactly one Workspace registration, so there is no entity to duplicate. "View files" is not a separate row because the file tree is session-scoped; reveal covers browsing the directory.

**S2.4 — Conversation text is selection-aware.** A secondary press on a message copies the selected text when there is one and the whole message otherwise. "Add to current task" inserts the text as a quotation (each line prefixed with `>`) into the current composer through the public `inputActions` face. "Ask in a side conversation" starts a new Session in the same workspace with the quotation prefilled; it does not send, so nothing reaches a model without a second confirmation.

**S2.5 — The composer menu edits in place.** Undo, redo, cut, copy, paste, delete, and select all dispatch the composer's own Lexical commands. Paste reads the clipboard through `navigator.clipboard.readText()`; a refused read surfaces a notice asking for the keyboard shortcut instead of failing silently.

**S2.6 — File rows open through the Host.** Preview reveals the existing right-Sidebar document tab. Open and open-with call `session.openWorkspacePath`, listing handlers from `session.workspacePathApplications`. Both copy rows work from the absolute tree path and the tree root.

**S2.7 — Every label is dictionary copy.** New keys live in the owning package's `locales.ts`; no string literals reach the UI.

**S2.8 — Programmatic command invocation.** `ShortcutsService` exposes the `invoke(id, context)` the registry already implements, so a menu row can run a registered product command such as `settings.open`.

## [S3] Scope

- In scope: the five context menus, the shared primitive, the new session menu entries, the settings command invoke, and their tests.
- Out of scope: durable unread state, cross-workspace session moves, exposing Session storage/log paths, workspace duplication, project export, and touching the `...` menu's existing orders.

## Tasks

- [x] T1: `ContextMenu` primitive + test (covers S2.1)
- [x] T2: `ShortcutsService.invoke` + test (covers S2.8)
- [x] T3: Session-row context menu and new shipped entries (covers S2.2)
- [x] T4: Project-row context menu (covers S2.3)
- [x] T5: Conversation text menu (covers S2.4)
- [x] T6: Composer menu (covers S2.5)
- [x] T7: File-tree menu (covers S2.6)
- [x] T8: Locale entries and docs (covers S2.7)

## [S4] Acceptance

- [x] A secondary press on a session row, project row, message, composer, and file row opens the product menu and suppresses the browser menu.
- [x] Session and project menus run their actions; unavailable capabilities are absent from the menu.
- [x] Copy actions write the clipboard; open/reveal actions reach the Host desktop API.
- [x] Composer verbs operate on the Lexical draft, and a refused clipboard read shows a localized notice.
- [x] Every visible label resolves through a typed dictionary.
- [x] Focused tests, typecheck, and the client build pass.
