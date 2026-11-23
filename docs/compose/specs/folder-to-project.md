---
feature: folder-to-project
status: delivered
updated: 2026-11-24
branch: feat/folder-to-project
commits: 26b7c472a5..dd14a7ee93
---

# Folder-to-project pull

English | [中文](folder-to-project.zh.md)

## Report

**What was built** — Dropping a folder onto the desktop app now asks whether to register it as an independent project. The attachment layer's document-level drop handler detects directory members (entry API, desktop-only path resolution via `__DSH_HOST_PATHS__` / WebView2 `File.path`) and, instead of silently creating a citation chip, opens a confirm dialog for the first dropped folder: create the project, add as reference (the legacy chip behavior), or cancel. Creating calls `workspaces.create({ path })` and then `uiWorkspace.openWorkspace(workspaceId)` through lazily resolved, structurally cast services, so the new project points at the folder's original path and opens with a connected session. Further drops while a decision is pending or a creation is in flight take the legacy intake, so no batch is lost; browser drops without a host path keep the existing desktop-only guidance; files-only drops are unchanged.

The confirm dialog, the pending-decision state, and the injected `createProjectFromDirectory` face live in `ui-attachment`'s `ComposerAttachments`; the interception callback threads through `drop-events.ts`. The host-path bridge helpers exist as private per-package copies (`ui-conversation/src/client/host-path.ts` beside the composer intake, `ui-attachment/src/client/host-path.ts` beside the dialog) because client feature packages may not value-import across plugins (`verify-client-packages`). New `attachment.folderProject.*` keys ship in all eight conversation locales; the ui-attachment README documents the flow bilingually.

**Verification** — `pnpm run build` (build:artifacts + build:check): 9/9 gates PASS on the final tree, including the client compiler, Client bundle purity, Web build, and both aggregate typechecks. `pnpm exec vitest run packages/client/ui-attachment/tests packages/client/ui-conversation/tests`: 940 + 59 tests PASS, including 7 new folder-to-project cases (create/reference/cancel/web-fallback/cannot-accept/pending-race/failure). `pnpm exec tsc -b packages/client/ui-attachment`: exit 0. `pnpm run verify-client-packages`: PASS. Scoped oxlint over the two packages: 0 errors in changed files (6 pre-existing in `InputBar.tsx`). `verify-translation-pairing`, `verify-md-wrap`, `verify-export-jsdoc`, `verify-concrete-terms`: no hits in changed files (remaining failures are the master baseline's known reds — speech/experimental/webserver/subagent JSDoc and model-experience, meeting-*/http-asr/hachimodock pairing records, root README "Provenance" row, ui-conversation README summary length, ui-file-actions/prism-meeting dead links, cordis catalog, persistence inventory — all in files outside this diff).

**Journey log** — The first implementation shared the host-path helpers by re-exporting them from `ui-conversation`'s client entry and declaring the subpath in `dsh.client.external`; the tsdown bundle-purity gate accepted it, but the independent review caught `verify-client-packages` rejecting runtime cross-plugin imports for client feature packages — the helpers are now private per-package copies, with consolidation deferred until a third consumer appears. A second review finding was a lost-update race: a folder dropped while the confirm dialog was pending overwrote the first pickup; pending/in-flight drops now fall back to the legacy intake, with a regression test.

## [S1] Problem

Dropping a folder onto the app only inserts an `@path/` reference chip into the composer draft. There is no path that turns a dragged-in folder into an independent project (workspace), so the user must manually re-select the folder through the sidebar's directory picker after deciding they want a project.

## [S2] Design

### S2.1 Directory-drop interception

`installDocumentDropEvents` gains an optional `onDirectories(files, directories, addAsReferences)` callback. When a drop carries at least one directory and the view accepts drops (`canAcceptDrop`), the callback replaces the direct `onAddFiles` call; `addAsReferences()` re-runs the previous intake for users who want the legacy chip behavior. A drop that arrives while a folder decision is pending or a creation is in flight also takes `addAsReferences()`, so no batch is ever lost or overwritten. Files-only drops are unchanged. Only the desktop shell can resolve a dropped directory's absolute path (`__DSH_HOST_PATHS__` / WebView2 `File.path`); a browser drop with no resolvable path falls through to the existing intake, which reports `attachment.directoryDesktopOnly`.

### S2.2 Create-project dialog

`ComposerAttachments` owns a confirm dialog (primitives `Modal` + `Button`) for the first dropped directory: title, folder name, and three actions — create the project (primary), add as reference (legacy behavior), cancel. Creating closes the dialog; a failure keeps it open with the error text. The dialog renders only while a folder pickup is pending.

### S2.3 Workspace wiring

The attachment plugin's inject face gains an optional `createProjectFromDirectory(path)`: `ctx.get('workspaces').create({ path })` then `ctx.get('uiWorkspace').openWorkspace(workspaceId)` — the registry registers the project and `openWorkspace` connects a session in it. Services are read lazily at drop time through minimal structural casts; no new package dependencies. A created project points at the original directory (reference semantics — no files are copied, consistent with the workspace registry).

### S2.4 Copy and locales

New `attachment.folderProject.*` keys are added to the `conversation` namespace dictionaries (zh, en, ja, es, fr, de, ru, pt). The dropped-folder host-path helpers stay package-private: `ui-conversation` keeps them beside the composer intake and `ui-attachment` carries a private copy, because client feature packages may not value-import across plugins (`verify-client-packages`); consolidate into a shared non-row package if a third consumer appears.

## Scope

- In scope: document-level directory-drop interception, the confirm dialog, workspace create+open wiring, eight-locale copy, unit tests, README notes.
- Out of scope: copying folder contents into an app-owned directory, Git URL pull, Web-platform folder pull, changing the composer's file (non-directory) drop behavior, re-pointing an existing session's cwd.

## Tasks

- [x] T1: extract `host-path.ts` helpers and re-export them (depends: none)
- [x] T2: add the `onDirectories` interception to `drop-events.ts` (depends: none)
- [x] T3: dialog + injected `createProjectFromDirectory` in `ui-attachment` (depends: T1, T2)
- [x] T4: locale keys in eight languages (depends: T3)
- [x] T5: unit tests for create / reference / cancel / web-fallback (depends: T3)
- [x] T6: README updates (depends: T3)

## [S4] Acceptance

- [x] Dropping a folder on the desktop app asks whether to create an independent project; confirming registers the workspace over the folder's original path and opens it with a connected session.
- [x] Choosing "add as reference" reproduces today's chip behavior exactly; cancel adds nothing.
- [x] A browser (no host-path bridge) directory drop still reports the desktop-only guidance and creates nothing.
- [x] Files-only drops are byte-for-byte behaviorally unchanged.
- [x] All eight conversation locales carry the new keys; typecheck and the package's client tests pass.
