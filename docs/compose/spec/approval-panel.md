---
feature: approval-panel
status: delivered
updated: 2026-11-01
branch: feat/approval-panel
commits: c22ec9f0b9..HEAD
---

# Approval in the Progress Panel

English | [中文](approval-panel.zh.md)

## Report

**What was built** — A session waiting on an approval now carries a strip under its row in the Progress panel: the request's own one-line text and its two decisions. The panel reads the pending value structurally and answers it, so nothing new crosses the Host or the browser wire. Built in the out-of-tree `plugins/dsh-agent-progress` bundle.

## [S1] Problem

The approval card lives above the composer of the Session that asked, so seeing what is being asked and answering it both require opening that conversation. The Progress panel is the one place that already watches every running Session — it shows a "waiting" chip from the same status snapshot — but the chip says only that something waits. A user watching progress therefore has to leave the panel to find out what.

## [S2] Design

### S2.1 Where the value comes from

`ui-session` publishes, per Session, the pending interaction the approval package registered (`SessionStatus.pendingInteraction`). The Progress panel already selects that snapshot for its waiting chip, so it holds the exact request — the same object the conversation's approval card answers — without opening the Session and without a new RPC.

The value's class belongs to `ui-approval`, which the panel must not import. It reads the shape instead: `kind === 'approval'`, `key`, `toolName`, `reason`, optional `displayReason`, `answerable`, and an `answer(decision)` callback. A value that lacks the discriminator or the callback (a question, a plan review, a settled request) is not an approval and renders no strip.

### S2.2 Where the strip sits

Under the Session's row, inside the same list item. The row is itself a `<button>` that opens the Session, so a decision nested inside it would be a button inside a button — not a control the browser activates. The strip is its sibling, which also keeps a decision click from opening the conversation.

### S2.3 What the strip shows and does

- Text: `displayReason` resolved through the locale seat (`ctx.locale.resolveText`) when the requester supplied copy; else the audit `reason`; else the panel's localized "Tool `{tool}` requests privileged execution" line.
- Decisions: 拒绝 and 允许一次, each with an accessible name that includes the Session title, so a list reader knows which Session it decides.
- Answering calls `approval.answer(decision)`, occupies a one-shot guard, disables both buttons while the settlement runs, and restores them if it fails. It settles the same Host waterfall as the conversation card; the card and the strip disappear together because both read the same published request.

### S2.4 Limits

- The text is the requester's own: a sandbox escalation reads `escalate sandbox to <mode>: <sentence>`. A structured target (command, path, diff) needs a summary field on the approval request; this change does not add one.
- A pending approval exists only in the client that received it; after a reload or reconnect the Host has already settled it as `unavailable`, so no strip reappears.
- The strip appears only while the panel is open over a live status snapshot; it is not a notification.

### S2.5 Tests

`plugins/dsh-agent-progress/scripts/smoke.mjs` loads the built `lib/client.js` through the same module-loader handoff the shell uses, renders the page against a synthetic list and status snapshot, and now asserts: one approval strip for the approving Session and none for a question-kind wait, the requester's text and both decisions present, and a decision click delivering `allowed-once` to the request.

## [S3] Scope

- In scope: the panel's derivation of the approval, its strip, the decisions, the dictionary keys, the strip styles, and the plugin smoke assertions.
- Out of scope: the conversation approval card, Host approval semantics, structured summary fields, notifications, and any change to the session list.

## Tasks

- [x] T1: Derive the pending approval from the status snapshot (`progress.ts`)
- [x] T2: Render the strip and its decisions beside the row (`index.tsx`)
- [x] T3: Add the dictionary keys and the strip styles
- [x] T4: Resolve requester-owned copy through the locale seat
- [x] T5: Extend the plugin smoke with the strip, the decisions, and the no-strip case
- [x] T6: Rebuild `lib/client.js` and update the package README pair

## [S4] Acceptance

- [x] A Session waiting on an approval shows the requester's text and both decisions in the panel (`smoke.mjs`: one strip, text, `reject`/`allowOnce`)
- [x] A decision from the strip answers that request (`smoke.mjs`: the allow click delivers `allowed-once`)
- [x] A Session waiting on another interaction kind shows its chip and no strip (`smoke.mjs`: the question-kind Session)
- [x] The plugin typechecks and bundles (`tsc -p plugins/dsh-agent-progress/tsconfig.json`, tsdown)
