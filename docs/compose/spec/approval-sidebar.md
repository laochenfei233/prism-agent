---
feature: approval-sidebar
status: delivered
updated: 2026-11-01
branch: feat/approval-sidebar
commits: c22ec9f0b9..aec898c7d8
---

# Approval in the Session Row

English | [中文](approval-sidebar.zh.md)

## Report

**What was built** — An approval request now has a second presentation, in the Session list. `ui-workspace` declares `sidebar.workspaces.session.pending` as a per-row list seat and renders it as a full-width second line on any non-archived, non-blank Session row whose `pendingInteraction` is set; the row switches to the two-line `flex-wrap` layout only while that seat rendered an occupant, so a question or plan review keeps the 32 px single line. `ui-approval` registers the occupant, which reads the row's request from `useSessionStatus`, narrows it with `instanceof PendingApproval`, and renders the requester's one-line summary beside 拒绝 / 允许一次. The summary is the localized `displayReason` when supplied, else `reason`, else the tool copy; the line repeats neither the warning dot nor the "Approval" label the row's first line already carries. Both buttons answer through the settle guard the composer card used, now extracted into `useApprovalAnswer`, keep their clicks out of the row, and carry accessible names that include the Session title, so the composer card keeps the only exact "Allow once" name that existing tests and shortcuts rely on. Answering on either surface settles the same Host waterfall and withdraws the other.

**Verification** — `node ./node_modules/vitest/vitest.mjs run packages/client/ui-approval packages/client/ui-workspace` passes 15 files and 520 tests, including the nine `RowApproval` cases and the row-seat case. `pnpm run typecheck` passes all five gates (host compiler, host aggregate, Host Typert, client compiler, client aggregate), and `pnpm run build` passes all eight (adds Host bundle, Client bundle, Web build). `DSH_SNAPSHOT=replay node ./node_modules/vitest/vitest.mjs run --config vitest.web.config.ts apps/web/tests/built-boot.expected.e2e.ts` passes 2 tests against the rebuilt plugin bundle, including the added assertions that the assembled sidebar row shows the fixture approval's summary, offers both Session-named decisions, and loses its line once the composer answers. `pnpm run verify-client-catalog` reports the regenerated slot catalog up to date. `pnpm run test:gui` reports 11008 passed with 8 failed suites and 6 failed tests; the same suites and 5 of those tests fail identically with this feature stashed (the sixth is the same `connection` suite's second variant), so they are PRE-EXISTING. `pnpm exec tsx scripts/run-oxlint.ts packages/client/ui-approval packages/client/ui-workspace packages/extensions/cordis-client-runner` reports no finding in a changed file; its single remaining error is the pre-existing `unbound-method` at `packages/client/ui-workspace/tests/apply.client.spec.ts:923`, a file this change does not touch. `pnpm run verify-translation-pairing` reports the four edited pairs consistent, and `pnpm run verify-client-ui-i18n` scans 1098 files clean.

**Journey log**

- Answering from the row needs no Host change: `useSessionStatus` already publishes the whole `PendingApproval` per Session and `answer()` settles the Remote waterfall directly.
- The first review found three defects the acceptance criteria did not catch: the decision buttons let their click bubble into the row's open handler, the two-line layout applied to question and plan-review rows whose seat renders nothing, and the pending line overflowed the list because it added a 20 px indent outside a content-box width. The layout now keys on rendered content (`.sessionRow:has(> .pendingLine:not(:empty))`, `.pendingLine:empty { display: none }`), the line is `border-box`, and the decisions stop propagation on their own span.
- Only an occupied line grows the row. The first line already shows the warning dot and the "Approval" trailing label, so the second line spends its width on the requester's text instead of repeating them.
- The summary stays requester text. `approval/request` deliberately omits tool arguments, so a structured target (a command's first line, a file path, a diff size) would need a new summary field on the request and its audit event; that is recorded as a limit rather than guessed out of the reason string.
- The committed client slot catalog was already stale beyond this feature (a feedback row, the DeepSeek sign-in card, the command palette), so regenerating it folds that drift in; `verify-client-catalog` compares the whole file and cannot accept a partial edit.

## [S1] Problem

A pending approval reaches the user in exactly one place: the takeover card above the composer of the Session that asked. The Session row names the wait ("Waiting for approval") and nothing else, so who asks and for what is knowable only by opening that Session, and answering it only happens there. With several Sessions in flight, a background Session blocked on an approval waits on a row the user has no reason to open.

The row is also where the user already scans, and the data is already there: `useSessionStatus` publishes the pending interaction for every Session the client holds, and the workspace browser folds it into each row's status. What the row lacks is content and an action, not transport.

## [S2] Design

### S2.1 What the client already holds

`ui-approval` answers the forwarded `approval/request` waterfall for its owning Session and publishes a `PendingApproval` through `uiSession.registerPendingInteraction`. The global standard hook `useSessionStatus` exposes that value per Session as `SessionStatus.pendingInteraction`, and `WorkspaceBrowser` already selects the whole status map, so a row's occupant reads the exact request without opening the Session. Answering calls `PendingApproval.answer` (`allowed-once` or `rejected`), which settles the Remote waterfall; no Host call, storage change, or new session event is involved.

Delivery does not depend on the Session being open: each row's occupant reads `SessionStatus.pendingInteraction`, which `ui-session` publishes for every Session the client holds. The assembled-boot fixture carries both a question and an approval for a Session that is not open; the row reports the question first under the existing precedence, and once the questions are answered the test asserts the approval's summary, its two decisions, and their disappearance after an answer (`apps/web/tests/built-boot.expected.e2e.ts`).

The request carries `toolName`, optional `reason`, optional localized `displayReason`, and `callId`; it deliberately omits tool arguments ([approval.md](../../subsystems/approval.md)). A one-line summary therefore comes from `reason` and `displayReason` alone.

### S2.2 The row seat

`ui-workspace` declares one list slot:

`sidebar.workspaces.session.pending` — scope `root`, owner `SessionRowOwnerProps` (`sessionId`, `displayTitle`), rendered inside the Session row as its second line.

The declaration stays domain-neutral, the way the status cell already is: the browser renders the seat for any row whose `pendingInteraction` is present, the tree derives that field for all three interaction kinds, and ui-workspace names no approval type. `ui-approval` registers the occupant, so approval presentation stays in the package that owns the request.

Archived and blank rows keep their current rule. The status cell stays blank on an archived row and the row verbs stay off on a blank row, so the pending line renders only for a non-archived, non-blank row.

### S2.3 The occupant

`ui-approval` registers one compact component into the seat. It reads the pending value from `useSessionStatus` by `sessionId`, narrows it with `instanceof PendingApproval`, and renders one line:

`<summary>  [拒绝] [允许一次]`

- `summary` is `displayReason` resolved through the injected locale seat when present, else `reason`, else the localized "Tool requests privileged execution" copy.
- The row's own status cell already carries the warning dot and the compact "Approval" label on the first line, so the second line repeats neither and spends its width on the requester's text.
- The line is single-line with an ellipsis; the element's `title` carries the full text.
- Both buttons are ui-primitives `Button size="sm"` and answer through `PendingApproval.answer`. The settle guard the composer card already implements moves into one internal hook (`useApprovalAnswer`) that both presentations use, and a failed settlement restores the buttons.
- The buttons keep the row's own click out (`stopPropagation`), as the row action strip does.

### S2.4 Layout

A Session row becomes two lines only while the seat rendered an occupant, which the stylesheet reads from the DOM: `.sessionRow:has(> .pendingLine:not(:empty))` switches that row to `flex-wrap: wrap` with `height: auto; min-height: 32px`, while `.pendingLine:empty { display: none }` keeps an unoccupied seat at no height. A question or plan review therefore keeps the 32 px single line, because its own interaction UI lives in the composer and it registers no occupant here. The line takes `flex: 0 0 100%`, `box-sizing: border-box`, and the title's indent, so it never widens the row past the list's scroll clip.

### S2.5 Copy and accessibility

The buttons show the existing `拒绝` / `允许一次` copy and carry an `aria-label` that includes the Session title (`允许一次：<title>`), so a screen reader reading the list knows which Session a button decides, and the composer card keeps the only exact "Allow once" accessible name that existing tests query.

The import of approval copy stays in ui-approval's namespace; ui-workspace adds no approval words. The composer card keeps the Enter/Esc shortcuts; the row answers through its buttons and takes no keys of its own.

### S2.6 Limits

- The summary is the requester's own text. A sandbox escalation currently reads `escalate sandbox to <mode>: <model sentence>`, so that fixed English prefix stays visible. A structured target (a command's first line, a file path, a diff size) needs a summary field on `approval/request` and `approval/asked`, which this change does not add.
- A pending approval exists only in the client that received it. A reload or reconnect ends the Host's waterfall as `unavailable` under the existing fail-closed rule, so the row does not reappear for a request that is gone.

### S2.7 Tests and snapshots

- `ui-approval` component spec: the occupant renders the summary and answers through `answer`; the buttons disable while the settlement is in flight and restore on failure; a decision click stays out of the row that contains it; nothing renders for a Session holding another interaction kind.
- `ui-workspace` component spec: the seat renders only for a row with a pending interaction. Its stylesheet spec asserts the row grows only for an occupied line, that an empty line takes no height, and that the line stays inside the row's box.
- Assembled output: the resident approval in `apps/web/tests/built-boot.expected.e2e.ts` gains the line, and the recorded output changes only there.
- `pnpm run test:gui` covers the client suites; `DSH_SNAPSHOT=replay` over `apps/web/tests/built-boot.expected.e2e.ts` covers assembled output.

## [S3] Scope

- In scope:
  - the `sidebar.workspaces.session.pending` seat and its occupant in the Session row
  - the one-line summary plus 拒绝 / 允许一次 in the row
  - the shared `useApprovalAnswer` guard used by both approval presentations
  - locale keys, component specs, and the affected sidebar snapshots
- Out of scope:
  - Host approval semantics, approval triggers, and the `approval/request` payload
  - structured targets (command, path, diff) and any new summary field
  - notifications, toasts, and the hover card
  - reworking the composer card beyond sharing the answer guard

## Tasks

- [x] T1: Declare `sidebar.workspaces.session.pending` in ui-workspace's slot contract and carry it through the browser's children and props type (depends: none)
- [x] T2: Render the seat as the row's second line and add the pending-row layout class (depends: T1)
- [x] T3: Extract `useApprovalAnswer` from `ApprovalPanel` and use it there (depends: none)
- [x] T4: Register the row occupant in ui-approval with the summary, the two buttons, and the new locale keys (depends: T1, T3)
- [x] T5: Component specs for the occupant and the seat (depends: T2, T4)
- [x] T6: Update assembled-output expectations and the sidebar snapshots (depends: T4)
- [x] T7: Mark each divergent site with `PRISM-DIVERGENCE` and fill S5 (depends: T2, T4)

## [S4] Acceptance

- [x] A Session row with a pending approval shows the requester's one-line summary and 拒绝 / 允许一次 without that Session being open (ui-approval spec)
- [x] Answering from the row settles the approval the composer card shows with, and both surfaces disappear (ui-approval spec)
- [x] A row without a pending interaction keeps the 32 px single line and renders no pending line (ui-workspace spec)
- [x] A Session holding a question or a plan review renders no approval line (ui-approval spec)
- [x] A failed settlement leaves both buttons usable (ui-approval spec)
- [x] The assembled sidebar shows the new line for the resident approval, and answering from the composer withdraws it (`apps/web/tests/built-boot.expected.e2e.ts`)

## [S5] Upstream divergence

This checkout imports upstream as one baseline commit, so a later upstream import replaces these files wholesale instead of merging with them. Every source file below carries a `PRISM-DIVERGENCE` comment, so `rg PRISM-DIVERGENCE` finds them without reading this section; the two package manifests and the tsconfig reference are named here because they carry no comment syntax.

| File | Divergent site | What a replay must keep |
| --- | --- | --- |
| `packages/client/ui-workspace/src/client/contract/slots.ts` | the `sidebar.workspaces.session.pending` declaration and its doc | the slot, its owner type, and the domain-neutral occupancy rule |
| `packages/client/ui-workspace/src/client/index.ts` | the declared child in the `sidebar.workspaces` registration | the seat declaration beside the row's two existing list seats |
| `packages/client/ui-workspace/src/client/rows/Rows.tsx` | the pending line inside `SessionNodeItem` | the second line, its gate, and the displayed title it hands the occupant |
| `packages/client/ui-workspace/src/client/rows/Rows.module.css` | the pending-row and pending-line rules | the two-line layout and its collapse |
| `packages/client/ui-approval/src/client/index.ts` | the second slot registration and the shared `approvalInjected` factory | the occupant registration, its `id`, and one reason resolver for both presentations |
| `packages/client/ui-approval/package.json`, `packages/client/ui-approval/tsconfig.json` | the `@deepseek-ai/dsh-client-ui-workspace` devDependency, its `dsh.client.inject` row, and the project reference | all three wiring lines; JSON and tsconfig references carry no comment syntax, so a replay reads them here |
| `packages/client/ui-approval/src/client/RowApproval.tsx` | the row occupant | the summary fallback order and the `displayReason` resolution |
| `packages/client/ui-approval/src/client/RowApproval.module.css` | the line, summary, and action rules | the one-line summary and the right-aligned decisions |
| `packages/client/ui-approval/src/client/use-approval-answer.ts` | the shared answer guard | one answer attempt per request and the failed-settlement restore |
| `packages/client/ui-approval/src/client/ApprovalPanel.tsx` | `useApprovalAnswer` in place of its own guard | both presentations answering through one guard |
| `packages/client/ui-approval/src/client/locales.ts` | the row aria-label keys | their pairing with the composer copy |
