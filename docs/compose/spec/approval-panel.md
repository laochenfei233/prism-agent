---
feature: approval-panel
status: delivered
updated: 2026-11-02
branch: feat/approval-panel
commits: d26a0ebaee..HEAD
---

# Approval Surfaces

English | [中文](approval-panel.zh.md)

## Report

**What was built** — A pending approval is readable in two places — the second line of its Session row in the conversation list, and a strip under its row in the Progress panel — and exactly one of them carries the decisions. A placement preference (Progress panel by default) selects which; both surfaces always show the request's text, and the surface that does not own the decisions shows a short hint saying where they are.

## [S1] Problem

The approval card lives above the composer of the Session that asked, so seeing what is being asked and answering it both require opening that conversation. Two places already watch every Session without opening it — the conversation list and the Progress panel — and both showed only that something waits.

## [S2] Design

### S2.1 Where the value comes from

`ui-session` publishes, per Session, the pending interaction the approval package registered (`SessionStatus.pendingInteraction`). Both surfaces read that snapshot: the row occupant through the seat's Session-status hook, the panel through the same global hook it already used for its waiting chip. No Host call and no new wire field.

The panel does not import the package that publishes the value. It reads the shape: `kind === 'approval'`, `key`, `toolName`, `reason`, optional `displayReason`, `answerable`, and an `answer(decision)` callback. A value without the discriminator or the callback (a question, a plan review, a settled request) renders no strip.

### S2.2 The two surfaces

- **Session row** (`sidebar.workspaces.session.pending`, declared by `ui-workspace`, filled by `ui-approval`): a full-width second line on a non-archived, non-blank row whose `pendingInteraction` is set, shown only while the seat renders an occupant and leaving any other row at its single 32 px line.
- **Progress panel strip**: a block under the Session's row inside the same list item. The row is itself a button, so a decision nested in it would not be activateable; the strip is its sibling.

### S2.3 The placement preference

One browser preference, written and read on both sides: key `dsh.approval.placement`, window event `dsh:approval-placement`, values `progress` (shipped default) and `list`. The panel's header carries a two-button group that writes it, using `aria-pressed` for the active choice. Each surface reads the placement through its own channel — the row occupant through the injected `hooks` compartment, the panel through local state it refreshes on the event and on `storage` changes — and renders either the decisions or a hint naming the other surface.

The preference is per browser and per origin, like the other view preferences; it is not a Host setting and does not travel between devices.

### S2.4 Answering

Only the owning surface renders 拒绝 / 允许一次. Each decision calls the request's `answer(decision)` behind a one-shot guard, disables both buttons while it settles, and restores them on failure. Both surfaces display the same published request, so answering on either settles the same Host waterfall and the other surface loses its line or strip with it. Accessible names include the Session title, which keeps the composer card's plain "Allow once" unique.

### S2.5 Limits

- The text is the requester's own: a sandbox escalation reads `escalate sandbox to <mode>: <sentence>`. A structured target (command, path, diff) needs a summary field on the approval request.
- A pending approval exists only in the client that received it; after a reload or reconnect the Host has already settled it as `unavailable`.
- Neither surface is a notification: they appear only where the list or the panel is open.

### S2.6 Tests

- `ui-approval` spec: the occupant shows the summary in both placements, offers the decisions only when the placement names the row, and answers through the request.
- `ui-workspace` spec: the seat renders only for a row with a pending interaction, and the stylesheet grows the row only for an occupied line.
- `prism-progress` smoke (`scripts/smoke.mjs`): loads the built bundle through the module-loader handoff, asserts the strip with decisions under the shipped placement, switches the placement through the header control, and asserts the strip keeps the text with a hint and no decisions.

## [S3] Scope

- In scope: the row seat and its occupant, the panel strip, the placement preference and its control, the dictionary keys, the styles, and the tests above.
- Out of scope: the composer card, Host approval semantics, structured summary fields, notifications, and per-Session placement.

## Tasks

- [x] T1: Declare the row seat and render its occupant (`ui-workspace`, `ui-approval`)
- [x] T2: Derive the pending approval for the panel and render its strip (`prism-progress`)
- [x] T3: Store, publish, and read the placement preference on both sides
- [x] T4: Put the placement control in the panel header
- [x] T5: Component specs and the plugin smoke for both placements
- [x] T6: Rebuild `lib/client.js` and update the three README pairs and this document

## [S4] Acceptance

- [x] A waiting Session shows the request text in the list and in the panel (`ui-approval` spec, smoke)
- [x] The shipped placement puts the decisions in the panel and leaves a hint in the list (smoke, `ui-approval` spec)
- [x] Switching the placement moves the decisions to the list and leaves a hint in the panel (smoke)
- [x] A decision answers the request and disables both buttons (`ui-approval` spec, smoke)

## [S5] Upstream divergence

This checkout imports upstream as one baseline commit, so a later upstream import replaces these files wholesale instead of merging with them. The sites below carry a `PRISM-DIVERGENCE` marker naming this document, except the two manifests and the tsconfig reference, which carry no comment syntax and are named here.

| File | Divergent site | What a replay must keep |
| --- | --- | --- |
| `packages/client/ui-workspace/src/client/{contract/slots.ts,index.ts,rows/Rows.tsx,rows/Rows.module.css}` | the `sidebar.workspaces.session.pending` seat, its child declaration, the second line, and its `:has()` layout | the seat and the pending line; these files already carry the A12 marker for other fork work |
| `packages/client/ui-approval/src/client/{index.ts,ApprovalPanel.tsx,locales.ts,RowApproval.tsx,RowApproval.module.css,use-approval-answer.ts,placement.ts}` | the occupant, the shared answer guard, the placement preference, and the row keys | re-apply on upstream's copies; `placement.ts`, `RowApproval*`, and `use-approval-answer.ts` have no upstream counterpart |
| `packages/client/ui-approval/{package.json,tsconfig.json}` | the `@deepseek-ai/dsh-client-ui-workspace` devDependency, its `dsh.client.inject` row, and the project reference | all three wiring lines; no comment syntax, so a replay reads them here |
| `plugins/prism-progress/{src/client/{index.tsx,progress.ts,placement.ts,locales.ts,styles.ts},scripts/smoke.mjs,README*}` | the panel strip, the placement control, and the smoke assertions | the whole plugin is fork-only, so copy it unchanged |
