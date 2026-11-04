---
feature: side-chat-panel
status: delivered
updated: 2026-11-04
branch: feat/side-chat-panel (worktree .worktrees/side-chat-panel)
commits: 50ff54bd96..HEAD
---

# Side Chat Panel

## Report

**What was built** — A secondary press on selected message text now asks beside the conversation. The existing "Ask in a side conversation" entry creates a Session in the viewing Session's Workspace and opens it as a right-Sidebar tab (`dsh-resource://sidechat/session/<id>`) with the selected passage staged as a quotation in that conversation's composer; nothing sends, and the main conversation keeps its own selection and scroll position. `ui-chat` registers the `sidechat` resource protocol, its `builtin` tab type, the tab body over the shared `conversation.content` Factory, and the nested Conversation seat the body hosts. The resource retains one Session reference for the tab's lifetime, stages the quotation once after the Session's opening settles, reports an unexpected open failure as a resource failure frame, and releases the reference when the tab closes.

**Verification** — `pnpm exec vitest run packages/client/ui-chat` PASS (53 files, 869 tests); `pnpm run test:gui` PASS except six suites that fail identically on untouched master (`ui-directory-picker-native` client-flow, `connection` binary-rpc, `ui-primitives` icons, `ui-theme` corner-shape, menu-surfaces, scrollbar-styles) — PRE-EXISTING; `pnpm exec tsc -b packages/client/ui-chat/tsconfig.client.json` and the client aggregate `tsc -p tsconfig.client.json` PASS; `pnpm run build` PASS for artifacts, host bundle, client compiler, client bundle, client aggregate check, and Web build, with the host aggregate check failing on master too (`connection/tests/browser-auth.host.spec.ts:100`) — PRE-EXISTING; `pnpm run verify-client-ui-i18n` PASS; `pnpm run lint` clean for the changed files (the repository-wide report already fails on master); the remaining documentation-gate failures are pre-existing fork drift.

**Journey log** — Requiring `resources` and `conversation` as hard plugin injections broke 27 then 18 unrelated mount suites; both moved to scoped optional injections, matching the pre-existing optional tab registry. The resource provider's first shape threw out of `open()` when a tab closed mid-open, while the resource model only reads failure frames, so it now yields `{ ok: false }` and releases. Creating with `{ cwd }` alone leaves the Session ungrouped until the next Host bootstrap, because the Host attaches Workspace membership only for an explicit `workspaceId`.

## [S1] Problem

A secondary press on conversation text offers "Ask in a side conversation". It creates a Session for the selected passage and replaces the main conversation with it, so the reader loses the passage they were reading and the answer arrives in a different view. The `dsh-sidebar-qa` plugin showed the alternative shape: ask beside the conversation, in the right Sidebar, without leaving the main view.

## [S2] Design

**S2.1 — Creation moves, the gesture does not.** The menu entry keeps its label and its selection-aware text. It creates the Session through `sessions.create({ workspaceId })` for the Workspace that holds the current Session (falling back to `{ cwd }` when no Workspace lists it) and opens it as a right-Sidebar tab; the main view keeps showing the current conversation.

**S2.2 — One tab type hosts the side conversation.** `ui-chat` registers a `sidechat` resource protocol addressed as `dsh-resource://sidechat/session/<id>` and a builtin tab type of the same kind. The resource provider retains one Session reference for the tab's lifetime (`source: 'sideChat'`) and releases it when the tab closes; the tab body wraps `SessionProvider` around the nested `chat.side.conversation` seat, which renders the shared `conversation.content` Factory with `variant: 'embedded'` and the active phase, so the panel carries the ordinary transcript and its own composer.

**S2.3 — The quotation is staged, never sent.** The action records the quoted text under the created Session id in the plugin's own map; the resource provider awaits `reference.ready`, consumes that entry, and hands it to `conversation.input.requestDraftInitialization` with `whenDraftExists: 'append'`. The reader still writes the question and sends it.

**S2.4 — Failures stay local.** A refused creation reports on the console and leaves the current view untouched. An unexpected failure opening the retained Session becomes a `sidechat/open-failed` failure frame on the tab instead of a throw, and a draft initialization the input hub refuses leaves the panel open with an empty composer.

**S2.5 — Dictionary copy.** The tab chip's title is a Chat locale key.

## [S3] Scope

- In scope: the message-menu action's destination, the `ui-chat` resource provider and `sidechat` tab type with its body, the draft handoff, the locale key, tests, and the package README.
- Out of scope: `dsh-sidebar-qa`'s context strategies (fork, compress, trim), summary generation, nested follow-ups, the follow-up history tree, per-panel model selection, and the selection overlay. The panel hosts an ordinary Session with the workspace's default Agent preset and model.

## Tasks

- [x] T1: `sidechat` resource, tab type, and tab body in `ui-chat` (covers: S2.2)
- [x] T2: Menu action creates and opens the side Session; locale title (covers: S2.1, S2.3, S2.5)
- [x] T3: Specs for the address, the provider handoff, the body, and the changed action (covers: S2.2, S2.3, S2.4)
- [x] T4: Package README and manifest updates (covers: S2.5)

## [S4] Acceptance

- [x] A secondary press on selected message text opens the right Sidebar with a new side conversation holding the quotation in its composer, and the main conversation still shows its own Session. (`apply-inject.client.spec.tsx` "opens a side conversation in the right Sidebar and stages its quotation"; `side-chat.client.spec.tsx` "creates the Session in the Workspace holding the viewing Session" and both `SideChatTab` cases.)
- [x] Closing the tab releases the retained Session reference. (`retainedBy.sideChat` is absent after the abort, and the resource provider's disposer runs on plugin teardown.)
- [x] A failing creation or resource open leaves the current conversation and Sidebar unchanged. (Creation refusal logs without opening a tab; a rejected `reference.ready` yields an `ok: false` frame and still releases.)
- [x] Focused client tests, `test:gui`, typecheck, and the client build pass.
