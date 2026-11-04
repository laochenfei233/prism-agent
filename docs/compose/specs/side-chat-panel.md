---
feature: side-chat-panel
status: designed
updated: 2026-11-04
branch: feat/side-chat-panel (worktree .worktrees/side-chat-panel)
commits: pending
---

# Side Chat Panel

## [S1] Problem

A secondary press on conversation text offers "Ask in a side conversation". It creates a Session for the selected passage and replaces the main conversation with it, so the reader loses the passage they were reading and the answer arrives in a different view. The `dsh-sidebar-qa` plugin showed the alternative shape: ask beside the conversation, in the right Sidebar, without leaving the main view.

## [S2] Design

**S2.1 — Creation moves, the gesture does not.** The menu entry keeps its label and its selection-aware text. It creates the Session through `sessions.create({ cwd })` in the current Session's Workspace and opens it as a right-Sidebar tab; the main view keeps showing the current conversation.

**S2.2 — One tab type hosts the side conversation.** `ui-chat` registers a `sidechat` resource protocol addressed as `dsh-resource://sidechat/session/<id>` and a builtin tab type of the same kind. The resource provider retains one Session reference for the tab's lifetime (`source: 'sideChat'`) and releases it when the tab closes; the tab body wraps `SessionProvider` around the shared `conversation.content` Factory with `variant: 'embedded'` and the active phase, so the panel carries the ordinary transcript and its own composer.

**S2.3 — The quotation is staged, never sent.** The action records the quoted text under the created Session id in the plugin's own map; the resource provider consumes that entry after `reference.ready` and hands it to `conversation.input.requestDraftInitialization` with `whenDraftExists: 'append'`. The reader still writes the question and sends it.

**S2.4 — Failures stay local.** A refused creation or open reports on the console and leaves the current view untouched. A draft initialization the input hub refuses leaves the panel open with an empty composer rather than failing the tab.

**S2.5 — Dictionary copy.** The tab chip's title is a Chat locale key.

## [S3] Scope

- In scope: the message-menu action's destination, the `ui-chat` resource provider and `sidechat` tab type with its body, the draft handoff, the locale key, tests, and the package README.
- Out of scope: `dsh-sidebar-qa`'s context strategies (fork, compress, trim), summary generation, nested follow-ups, the follow-up history tree, per-panel model selection, and the selection overlay. The panel hosts an ordinary Session with the workspace's default Agent preset and model.

## Tasks

- [ ] T1: `sidechat` resource, tab type, and tab body in `ui-chat` (covers: S2.2)
- [ ] T2: Menu action creates and opens the side Session; locale title (covers: S2.1, S2.3, S2.5)
- [ ] T3: Specs for the address, the provider handoff, the body, and the changed action (covers: S2.2, S2.3, S2.4)
- [ ] T4: Package README and manifest updates (covers: S2.5)

## [S4] Acceptance

- [ ] A secondary press on selected message text opens the right Sidebar with a new side conversation holding the quotation in its composer, and the main conversation still shows its own Session.
- [ ] Closing the tab releases the retained Session reference.
- [ ] A failing creation or resource open leaves the current conversation and Sidebar unchanged.
- [ ] Focused client tests, `test:gui`, typecheck, and the client build pass.
