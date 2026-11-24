---
feature: deepseek-import-entry
status: designed
updated: 2026-11-24
branch: feat/deepseek-import-entry
commits: backfill on delivery
---

# Move the DeepSeek export import entry into the "Import conversations" page as its first card

English | [中文](deepseek-import-entry.zh.md)

## Report

To backfill after delivery.

## [S1] Problem

The upstream `packages/experimental/deepseek-chat-import` package (which imports `deepseek_data-*.zip` exports from chat.deepseek.com) hangs its entry off the sidebar: `src/client/mount.ts` injects a button into the `sidebar.session.action` slot, next to "New session". The fork already has a unified "Import conversations" page — `packages/session-query/session-import`, mounted in the data settings section through the `settings.data.page` slot (id `cross-agent`) — which lists eleven sources in `IMPORT_SOURCE_IDS` order (claude, codex, grok, dsh, mimocode, opencode, openclaw, hermes, pi, gemini, zcode). One job, two entries: one in the sidebar and ten-plus on the import page. Decision: retire the upstream sidebar entry and make the DeepSeek export the import page's first source card.

## [S2] Design

### S2.1 Remove the sidebar entry

In `packages/experimental/deepseek-chat-import/src/client/mount.ts`, `registerUi` drops the whole `ctx.slots.inject('sidebar.session.action', ...)` block; the Remote mount, the `limits()` pre-check, the `uploadArchive` upload, and the progress/result dialog machinery all stay (they are the engine and do not retire with the entry). The sidebar no longer shows the DeepSeek import button.

### S2.2 session-import gains an ordered extension slot for sources

The session-import client gains the slot `settings.sessionImport.source` (a SlotMap with `order`), rendered ahead of the built-in source list; when nothing contributes, no container renders. The page's display order becomes: extension source cards (by `order`) → the `IMPORT_SOURCE_IDS` stores. session-import stays unaware of any concrete extension.

### S2.3 deepseek contributes the first card

When enabled, the deepseek-chat-import client contributes one source card to `settings.sessionImport.source`:

- id `deepseek-export`, with an `order` that places it first.
- Copy: "DeepSeek web export (ZIP)" — imports a `deepseek_data-*.zip` exported from chat.deepseek.com, keeping the original titles, times, reasoning, and search cards, and the conversations continue (reusing the package's existing 8-language locale).
- Action: clicking opens the existing `ImportSessions` dialog (file choice + workspace choice + upload/import progress + result), reusing the existing flow with no protocol or route changes.
- When the bundle is not enabled the client never mounts, so the import page naturally has no card — the optional semantics fall out of slot contribution.

### S2.4 Dependency direction and gates

`verify-client-packages` forbids cross-plugin runtime imports between feature packages, so session-import does **not** import deepseek-chat-import; the card component is registered by deepseek-chat-import itself through the slot (the same mechanism as the sidebar HOC and the settings extension). Each package keeps its own locale namespace (`settings.sessionImport` still belongs to session-import; the DeepSeek card uses its own namespace).

### S2.5 Tests and documentation

- `packages/experimental/deepseek-chat-import/tests/mount.client.spec.ts`: the sidebar-injection assertions become "contributes the first `settings.sessionImport.source` card + no longer injects `sidebar.session.action`".
- `packages/session-query/session-import/tests/section.client.spec.tsx`: new extension-card rendering-order cases (a contribution renders ahead of the built-in sources; without one, nothing extra renders).
- Both packages' README entry descriptions are rewritten in step (including the `.zh.md` files and the `i18n.yaml` pairing re-records).

## [S3] Scope

- In scope: the deepseek-chat-import mount rework, the session-import extension slot and render order, both packages' tests, and the README pairing.
- Out of scope: the import engine / upload protocol / NDJSON progress (`src/{archive,importer,upload,conversation}.ts` and the Host routes) stay untouched; the scan logic of the session-import stores; other optional bundles.

## Tasks

- [ ] T1: session-import adds the ordered `settings.sessionImport.source` slot and renders it first (depends: none)
- [ ] T2: deepseek-chat-import mount rework — drop the sidebar injection, contribute the first card through the slot (depends: T1)
- [ ] T3: update both packages' tests (mount assertions, section order cases) (depends: T2)
- [ ] T4: README/upgrade-guide entry descriptions + pairing re-record (depends: T2)

## [S4] Acceptance

- [ ] No DeepSeek import button next to "New session" in the sidebar (`sidebar.session.action` has no deepseek-chat-import contribution).
- [ ] With the bundle enabled, the first source card of the "Import conversations" page is DeepSeek web export (ZIP), and clicking it opens the original import dialog and completes one real upload import.
- [ ] Without the bundle, the import page matches the current behavior (the built-in sources, no empty container).
- [ ] session-import source imports nothing from deepseek-chat-import; `verify-client-packages` passes.
- [ ] Both packages' typecheck, tests, and doc-sync (including pairing) pass.
