---
feature: context-menu-plugins
status: delivered
updated: 2026-11-04
branch: feat/context-menu-plugins (worktree .worktrees/context-menu-plugins)
commits: 50ff54bd96..ed3b1116f0
---

# Context Menu Plugin Rows

## Report

**What was built** — A settled assistant message's secondary-press menu now carries plugin rows. ui-chat declares `conversation.chat.message.menu.item` as a child of the `assistant-step` node renderer; the message menu renders its entries after the shipped copy, add-to-composer, and side-conversation rows, and each entry dismisses the menu through the injected `useMenuOpenState` hook. The gate is the durable message id the node view already holds (`AssistantChatData.finalNode`), so streaming, user, and empty bodies keep the three shipped rows. ui-message-feedback registers its two rating rows there (order 10) and opens the same per-message feedback dialog the hover strip opens; the strip keeps its retract-on-second-click behavior. The Session row's existing `sidebar.workspaces.session.menu.item` path is untouched.

**Verification** — `node node_modules/typescript/bin/tsc -b tsconfig.client.json` exits 0. Focused vitest suites (`packages/client/ui-message-feedback/tests`, `packages/client/ui-chat/tests/chat-message-actions.client.spec.tsx`) pass 106/106, including the new menu-row and registration tests. `gen-client-catalog --check` reports the catalog up to date. The two edited documentation pairs pass `verify-translation-pairing`; the repository-wide run reports unrelated pre-existing out-of-sync pairs. `chat-view.client.spec.tsx` could not run on this host (the sandbox cannot create the symlinks pnpm needs, and the hoisted alternative duplicates React), so its single type-only helper change rests on the client aggregate typecheck and the stream/user gating rests on the tested "no extras renders the shipped rows" path rather than an assembled right-click.

**Journey log**

- Passing `messageId` into `AssistantMarkdown` and widening its `renderSlot` prop broke contextual typing of existing test stubs; the settled-message extras became one object supplied by the node view, keeping the component's own `renderSlot` type unchanged.
- A callback-shaped extras prop left a lambda that only ran when a menu opened, with no honest way to cover it; the object form keeps the slot call in the hook the tests drive.
- This worktree needs pnpm's hoisted layout for vitest (no symlink privilege) but the isolated one for tsx, so tests ran in the main checkout with the changed files copied in and restored, and script gates ran after switching back.

## [S1] Problem

The secondary-press menus added to five client surfaces build their rows inline. The conversation-text menu is the clearest gap: the assistant message's hover strip renders plugin entries through `conversation.chat.assistant-actions` (ui-message-feedback registers its Like/Dislike controls there), while right-clicking the same text offers only the three rows ui-chat hardcodes — copy, add to the composer, ask in a side conversation. The plugin action is unreachable from the menu, and any future per-message action would have to edit ui-chat itself.

## [S2] Design

**S2.1 — One message-menu slot.** `@deepseek-ai/dsh-client-ui-chat` declares a new list slot `conversation.chat.message.menu.item` (session scope, owner `{ messageId }`), as a child of the `assistant-step` node renderer. Its entries render after the shipped rows in the same `Menu` list and dismiss the menu through an injected `useMenuOpenState` hook, matching the Session row's `sidebar.workspaces.session.menu.item` contract. Only a settled assistant message carries a durable `messageId` (`AssistantChatData.finalNode`), so streaming messages, user bubbles, and an empty body render no plugin rows.

**S2.2 — Standard verbs stay shipped.** Copy, add-to-composer, and ask-in-side-conversation remain inline rows in `chat-message-actions.tsx`, rendered before the slot's entries. A plugin can add rows; it cannot remove a standard verb.

**S2.3 — Feedback registers menu rows.** `@deepseek-ai/dsh-client-ui-message-feedback` adds `MessageFeedbackMenuItems`, two rows that open the existing per-message feedback dialog with the chosen rating through the same `openDialog` verb the strip uses. The strip keeps its retract-on-second-click behavior; the menu deliberately always opens the dialog, which is the product's canonical way to record or change a judgment.

**S2.4 — No new lifecycle.** The contribution uses the existing `ctx.slots.inject` wait and leaves with the plugin fiber; the menu's dismissal is the press-point state `useContextMenu` already owns.

**S2.5 — The rows are verbs.** `menu.like` and `menu.dislike` join the feedback dictionary in both languages ("标记为好的回答" / "Mark as a good response") instead of reusing the strip's action labels.

## [S3] Scope

- In scope: the message-menu slot and its hook, the feedback menu rows and registration, focused component and disposal tests, the regenerated client slot catalog, and the ui-chat README, slots tree, and feedback subsystem notes.
- Out of scope: project-row, file-tree, and composer menus — no plugin registers rows there, so no zero-consumer slot is added; branch and usage rows in the message menu (they are not plugin contributions); changing the assistant-action strip or its retract behavior.

## Tasks

- [x] T1: declare the slot, its owner props, and its open-state hook factory (covers: S2.1)
- [x] T2: render the slot in the message menu and pass the settled message id down (covers: S2.1, S2.2)
- [x] T3: add the feedback menu rows and their registration (covers: S2.3, S2.5)
- [x] T4: focused tests, slot-catalog regeneration, and README notes (covers: S2.4)

## [S4] Acceptance

- [x] Right-clicking a settled assistant message shows the two feedback rows after the standard rows. (hook test plus order assertion)
- [x] Selecting a feedback row dismisses the menu and opens the feedback dialog for that message with the chosen rating. (menu-row spec, registration spec)
- [x] Right-clicking a user message, a streaming message, or a body with no settled message shows only the standard rows. (no extras renders the shipped rows; the node view derives extras from `finalNode?.messageId`)
- [x] Disposing the feedback contribution removes its rows from the menu while the strip keeps rendering. (disposal spec removes the registry entry; the strip entry keeps its own spec)
- [x] Focused client tests, typecheck, and the regenerated slot catalog pass.
