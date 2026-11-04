---
feature: context-menu-plugins
status: designed
updated: 2026-11-04
branch: feat/context-menu-plugins (worktree .worktrees/context-menu-plugins)
commits: none
---

# Context Menu Plugin Rows

## Report

Designed; not implemented yet.

## [S1] Problem

The secondary-press menus added to five client surfaces build their rows inline. The conversation-text menu is the clearest gap: the assistant message's hover strip renders plugin entries through `conversation.chat.assistant-actions` (ui-message-feedback registers its Like/Dislike controls there), while right-clicking the same text offers only the three rows ui-chat hardcodes — copy, add to the composer, ask in a side conversation. The plugin action is unreachable from the menu, and any future per-message action would have to edit ui-chat itself.

## [S2] Design

**S2.1 — One message-menu slot.** `@deepseek-ai/dsh-client-ui-chat` declares a new list slot `conversation.chat.message.menu.item` (session scope, owner `{ messageId }`), as a child of the `assistant-step` node renderer. Its entries render after the shipped rows in the same `Menu` list and dismiss the menu through an injected `useMenuOpenState` hook, matching the Session row's `sidebar.workspaces.session.menu.item` contract. Only a settled assistant message carries a durable `messageId` (`AssistantChatData.finalNode`), so streaming messages, user bubbles, and an empty body render no plugin rows.

**S2.2 — Standard verbs stay shipped.** Copy, add-to-composer, and ask-in-side-conversation remain inline rows in `chat-message-actions.tsx`, rendered before the slot's entries. A plugin can add rows; it cannot remove a standard verb.

**S2.3 — Feedback registers menu rows.** `@deepseek-ai/dsh-client-ui-message-feedback` adds `MessageFeedbackMenuItems`, two rows that open the existing per-message feedback dialog with the chosen rating through the same `openDialog` verb the strip uses. The strip keeps its retract-on-second-click behavior; the menu deliberately always opens the dialog, which is the product's canonical way to record or change a judgment.

**S2.4 — No new lifecycle.** The contribution uses the existing `ctx.slots.inject` wait and leaves with the plugin fiber; the menu's dismissal is the press-point state `useContextMenu` already owns.

**S2.5 — Copy comes from the owning dictionary.** The rows reuse `action.like` / `action.dislike` from the feedback namespace, so no new product string exists.

## [S3] Scope

- In scope: the message-menu slot and its hook, the feedback menu rows and registration, focused component and disposal tests, the regenerated client slot catalog, and the two package README notes.
- Out of scope: project-row, file-tree, and composer menus — no plugin registers rows there, so no zero-consumer slot is added; branch and usage rows in the message menu (they are not plugin contributions); changing the assistant-action strip or its retract behavior.

## Tasks

- [ ] T1: declare the slot, its owner props, and its open-state hook factory (depends: none) covers: S2.1
- [ ] T2: render the slot in the message menu and pass the settled message id down (depends: T1) covers: S2.1, S2.2
- [ ] T3: add the feedback menu rows and their registration (depends: T1) covers: S2.3, S2.5
- [ ] T4: focused tests, slot-catalog regeneration, and README notes (depends: T2, T3) covers: S2.4

## [S4] Acceptance

- [ ] Right-clicking a settled assistant message shows the two feedback rows after the standard rows.
- [ ] Selecting a feedback row dismisses the menu and opens the feedback dialog for that message with the chosen rating.
- [ ] Right-clicking a user message, a streaming message, or a body with no settled message shows only the standard rows.
- [ ] Disposing the feedback contribution removes its rows from the menu while the strip keeps rendering.
- [ ] Focused client tests, typecheck, and the regenerated slot catalog pass.
