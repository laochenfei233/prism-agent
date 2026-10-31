---
feature: keyboard-control
status: in-progress
updated: 2026-10-31
branch: feat/keyboard-control
commits: 13707d2897..<head> (filled at delivery)
---

# Keyboard Control for the Prism Agent GUI

English | [中文](keyboard-control.zh.md)

## Report

Design gate: nothing is implemented yet. Phase 1 starts after this document is accepted.

## [S1] Problem

The GUI already owns a complete command layer — registration with conflict-checked defaults per runtime and platform, persisted user overrides, and a searchable reference opened with the reference binding — but that layer only helps users who have memorized the keycaps.

Four gaps make a large part of the product pointer-only:

- **Nothing runs a command by name.** `Shortcuts.invoke` exists and is called only by the Desktop native-menu adapter, so the reference list can open an edit dialog for a row but cannot execute it. A user who does not remember a keycap has no keyboard path to the command.
- **The session tree is not keyboard reachable.** Its rows carry `role="treeitem"` and an `onClick` opener, but no `tabindex` and no key handler, so focus can never land on a row. Session search gives a text path to sessions, but browsing and reading the tree cannot be done without a pointer.
- **No command moves focus between regions.** The sidebar, the conversation, and the right panel are separate keyboard islands; the modal primitive restores focus inside a dialog only, and nothing else crosses region boundaries.
- **Focusing the composer is pointer work.** Returning to typing after reading a panel means clicking the editor.
- **A pending question can only be answered with the pointer.** Its options are buttons, its question flow advances by clicking, and neither arrows, `Tab`, nor `Esc` mean anything there, so a request that arrives while the user is typing forces a mouse trip.

The result is the reported symptom: most of the interface needs a mouse, and the existing shortcuts only cover the actions a user already knows.

## [S2] Design

### [S2.1] A palette that runs the registered catalog

A new command `commands.open` in `ui-shortcuts` opens a searchable list of every registered command and runs the selected one through `ctx.shortcuts.invoke`.

The list is the existing observable catalog, so it needs no second registry: rows render `label`, the effective keycaps, and filter through `rankByName` over the localized label and the command's aliases. A command registered after the palette mounted appears immediately, and a command whose plugin unloaded disappears.

The palette owns a small store (`createCommandPaletteStore`) with `open`, `close`, `search`, and the selected row index; all state is JSON-compatible, and the store is created in `apply` and passed to one `shell.overlay` registration, following the reference dialog's pattern.

Keys inside the palette: typing filters and resets the selection, `ArrowDown`/`ArrowUp` move, `Home`/`End` jump, `Enter` runs, and `Escape` plus backdrop closure stay with the `Modal` primitive.

Running closes the palette first, then calls `invoke` on the next animation frame, so the modal primitive has already restored focus to the invoking element; the context passed is `{ region: 'page', modal: null, target: document.activeElement }`. `commands.open` declares `modals: []`, so the palette only opens while no other dialog is up, which keeps `modal: null` truthful.

A blocked resolution must not be silent. `Shortcuts.invoke` returns `ShortcutResolution | undefined`, where `undefined` means the command is unregistered or its modal gate refused the call, and `ShortcutResolution` joins the package's client-entry type exports; the palette stays mounted while closed and shows the localized `reason` in its own toast, the way the reference reports save failures. A handled run closes without a notice.

Rows keep no second availability model: an unbound command still runs, a conflicting binding still runs, and only availability resolved at execution time can block. The palette is a launcher, not a second settings surface.

### [S2.2] Region landmarks and cycling

Three elements gain `data-dsh-region` and `tabIndex={-1}`: the session tree container in `ui-workspace`, the composer editor root in `ui-conversation`, and the active right-panel page container in `ui-sidebar-right`.

`focus.cycle` and `focus.cycleReverse`, registered by `ui-layout`, collect `[data-dsh-region]` in document order, find the current region from `document.activeElement.closest('[data-dsh-region]')`, focus the next or previous landmark, and wrap. With no landmark mounted the command returns blocked with a localized reason, so a collapsed layout reports instead of swallowing the key.

Discovery is by attribute rather than a new service because the three owners already resolve commands from the DOM — `ui-sidebar-right` decides from `focusedTarget(element)` — and the attribute keeps each landmark inside the package that renders it.

### [S2.3] Composer focus

`focus.composer`, owned by `ui-conversation`, focuses the main region's landmark — the composer editor root — and returns blocked with a localized reason when no composer is mounted.

### [S2.4] Session tree keyboard navigation

The tree container keeps `role="tree"` and gains one `onKeyDown` handler inside `AnimatedRows`: `ArrowDown`/`ArrowUp` move focus between the visible `[role="treeitem"]` nodes in DOM order, `Home`/`End` go to the first and last, and `Enter` activates the focused row by delegating to its own click handler, so opening, expanding, and collapsing keep the single behavior the pointer already uses.

Rows carry `tabIndex={-1}` and the tree container carries `tabIndex={0}`, so one Tab stop reaches the whole tree; arrows move focus onto a row, and `Enter` presses it.

The handler ignores input-method composition and events from controls inside a row — the row menu trigger and the row action buttons keep their own keys.

### [S2.5] Phase 1 keymap

| Command | Owner | Desktop macOS / Windows | Desktop Linux | Web Windows / macOS |
|---|---|---|---|---|
| `commands.open` | `ui-shortcuts` | `Mod+Shift+P` | `Mod+Shift+P` | `Mod+Alt+C` |
| `focus.cycle` | `ui-layout` | `F6` | unbound | `Mod+Alt+F6` |
| `focus.cycleReverse` | `ui-layout` | `Shift+F6` | unbound | `Mod+Alt+Shift+F6` |
| `focus.composer` | `ui-conversation` | `Mod+L` | `Mod+L` | `Mod+Alt+L` |
| Tree arrows, `Home`/`End`, `Enter` | `ui-workspace` | local DOM keys, not a binding | same | same |

Every default must pass `bindingIssue` and, for Web, `isWebBindingAllowed` at registration. A bare `F6` is rejected wherever the modifier rule applies, so it is declared for macOS and Windows Desktop only, where Desktop input accepts any complete combination; Ctrl+Alt+F6 stays off Linux Desktop because it collides with virtual-console switching. Web Linux is omitted because its admitted set is three specific combinations, and unbound is a legal declaration. Web follows the house rule that a default without Alt uses `Mod+Alt`; `Ctrl+Shift+P` opens a private window in Firefox, and `Mod+Alt+P` belongs to `workspace.files` while `Mod+Alt+K` belongs to `session.search`, so the palette takes `Mod+Alt+C`. No new default overlaps an existing command or a fixed action.

### [S2.6] Phase 2 backlog (out of scope here)

- Commands for pointer-only actions that still have none: model selection, theme, message copy/retry/feedback, queue send, plan and todo dock toggles, settings section jumps.
- `page.next`/`page.prev` cycling across right-panel pages.
- Desktop native menu entries for the new commands.
- A single-key or leader-sequence layer, and user-defined command groups.

### [S2.7] Compatibility, feedback, and gates

New defaults are additive: no existing binding moves, and saved overrides key off command IDs, so a user's stored profile keeps working and new commands inherit their defaults.

Locale copy for the palette, the reason strings, and the three focus commands lives in each owner's dictionary in English and Chinese, and `verify-client-ui-i18n` must pass.

New fork-owned files under `packages/client` carry the `PRISM-DIVERGENCE` marker on line 1, and the existing fork-owned `invoke` seam keeps its marker.

Tests: a palette spec (filter by label and alias, run, blocked reason, close and focus return), a cycle spec (order, wrap, missing landmark), a composer-focus spec, a tree-navigation spec (arrows, `Home`/`End`, `Enter`, roving tab index), and a question spec (option movement, question advance, dismissal). Verification runs `pnpm run test:gui`, then `DSH_SNAPSHOT=replay pnpm run test:web` because the change is product-visible.

Delivered evidence: `pnpm run typecheck` passes all five gates; the seven touched packages run 93 files and 1800 tests green; `CommandPalette.tsx`, `ApprovalPanel.tsx`, and `AnimatedRows.tsx` reach 100% of statements, branches, functions, and lines. `DSH_SNAPSHOT=replay` on the two shortcut browser files runs 11 tests: the shortcut-dialog goldens were refreshed for the four new rows and 10 pass. That lane caught a defect no unit spec could see — `commands.open` and `workspace.files` both claimed `Mod+Alt+P` on Web, `register()` rejected the pair, and `ui-sidebar-files` never mounted — so the palette's Web default is `Mod+Alt+C`. The eleventh test compares a committed golden that embeds the workspace path with POSIX separators against this Windows host, which renders backslashes.

### [S2.8] Questions and approvals on the keyboard

A pending question answers with the keys the dialog already implies: `ArrowUp`/`ArrowDown` move the selected option and carry focus with it, `Home`/`End` reach the first and last option, `Enter` confirms the current question, `Tab` and `Shift+Tab` move to the next and previous question of a multi-question request, and `Esc` dismisses the request through the existing dismissal path — the same action its Cancel control performs, with the same confirmations and busy state.

The custom-answer field keeps `Enter` to continue and `Shift+Enter` for a line break, so the pointer and the keyboard reach the same handlers and a typed answer is never submitted twice.

An approval carries two actions, and it uses the same movement: `ArrowUp`/`ArrowDown` and `ArrowLeft`/`ArrowRight` move focus between Reject and Allow once, `Enter` confirms the focused action and still confirms Allow once while no action holds focus, and `Esc` rejects. Both paths call the handlers the buttons already call, so the recorded outcome does not depend on the input device.

### [S2.9] What can be rebound and what stays fixed

Everything registered with `ctx.shortcuts.register()` is rebindable in Settings → Keyboard, including every Phase 1 command; a saved override applies to the runtime and platform the user is on, exactly as the existing profiles do.

Keys a focused control must own stay fixed and read-only: `Enter` to send and `Shift+Enter` for a newline in the composer, the double-`Escape` stop, the `/` and `@` triggers, and approval `Enter`/`Esc`. They are contributed with `registerFixed`, so they still show their keycaps, take part in conflict checks, and cannot be assigned to a command.

The question keys stay local to the card instead of becoming fixed rows: reserving `Tab` and the arrow keys for a listing the card already shows would take them away from every editable binding. The card's README states those keys.

The dividing rule is ownership, not importance: an application action is a command and can move; a keystroke that belongs to the control holding focus is fixed, because rebinding it would break typing in that control.

## [S3] Scope

- In scope: [S2.1] through [S2.5], [S2.8], [S2.9], and the gates in [S2.7].
- Out of scope: the [S2.6] backlog, touch and mobile layouts, terminal input, in-chat slash commands (`ui-commands`), and any change to how bindings are stored or edited.

## Tasks

- [x] T1: Confirm the toolchain in the worktree — `pnpm install --frozen-lockfile`, baseline `pnpm run test:gui`, and record any pre-existing failure. (depends: none)
- [x] T2: Make `Shortcuts.invoke` return `ShortcutResolution | undefined`, export that type from the package's client entry, and cover the return in the shortcuts service spec. (depends: T1, covers: S2.1)
- [x] T3: Add the palette store, component, locale copy, `commands.open` command with its defaults, and the reference ordering entry. (depends: T2, covers: S2.1)
- [x] T4: Add `data-dsh-region` and `tabIndex={-1}` to the three landmarks. (depends: T1, covers: S2.2)
- [x] T5: Register `focus.cycle`/`focus.cycleReverse` in `ui-layout` over the landmarks. (depends: T4, covers: S2.2)
- [x] T6: Register `focus.composer` in `ui-conversation`. (depends: T4, covers: S2.3)
- [x] T7: Add tree arrow navigation and the roving tab index in `ui-workspace`. (depends: T1, covers: S2.4)
- [x] T8: Write the five specs named in [S2.7]. (depends: T3, T5, T6, T7, T10, covers: S2.7)
- [x] T9: Update the affected package READMEs and the Web client subsystem page. (depends: T5, T6, T7, T10, covers: S2.7)
- [x] T10: Answer a pending question from the keyboard — option movement, question advance, confirm, and dismissal — and keep its keys local to the card as [S2.9] states. (depends: T1, covers: S2.8, S2.9)
- [ ] T11: Record the bilingual pair with `pnpm run verify-translation-pairing --write docs/compose/spec/keyboard-control.md`, then run the gates: `pnpm run test:gui`, `DSH_SNAPSHOT=replay pnpm run test:web`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run doc-sync`. (depends: T8, T9, T10)

## [S4] Acceptance

- [ ] `commands.open` opens the palette from a page, from the composer, and from a right-panel page, and lists every registered command with its effective keycaps.
- [ ] Typing filters the list by label and by alias; `ArrowDown`/`ArrowUp`/`Home`/`End` move the selection; `Enter` runs the selected command; `Escape` closes and focus returns to the element that opened the palette.
- [ ] A command registered after the palette mounted appears without reopening it.
- [ ] Running a blocked command shows that command's localized reason and leaves the session and layout unchanged.
- [ ] `focus.cycle` moves focus sidebar → conversation → right panel → sidebar, `focus.cycleReverse` walks the other way, and a layout without a right panel skips it instead of stalling.
- [ ] `focus.composer` puts the caret in the current session's composer, and reports a reason when the main view has no composer.
- [ ] With focus on a session tree row, arrows move between rows, `Home`/`End` reach the first and last row, and `Enter` opens the focused session; Tab enters and leaves the tree once, not once per row.
- [ ] In a pending question, `ArrowUp`/`ArrowDown`/`Home`/`End` move the option selection, `Enter` confirms the question, `Tab` and `Shift+Tab` move between questions, and `Esc` dismisses through the same path as Cancel; the answer the agent receives is unchanged.
- [ ] Every new command appears in the `⌘/` reference with its keycaps and can be rebound in Settings; the fixed composer, stop, and approval actions appear there read-only; en and zh copy both exist.
- [ ] `pnpm run test:gui` and `DSH_SNAPSHOT=replay pnpm run test:web` pass, and no existing default binding changed. The full browser lane is red on this Windows host for suites this change does not touch, and one committed path golden is POSIX-only.
