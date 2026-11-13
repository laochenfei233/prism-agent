---
description: "Browser approval UI that answers Host permission requests through the scoped interaction path."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-approval

English | [中文](README.zh.md)

## Summary

Browser approval presentation over the Agent-scoped Remote Event waterfall. The plugin publishes each pending request through `ctx.uiSession`, takes over the Conversation composer, optionally renders correlated Tool detail, and returns the decision to the waiting Host. Its Session's sidebar row shows it as a second line: the requester's one-line summary, and the two decisions wherever the reader's placement preference puts them. That preference (`dsh.approval.placement`; defaulting to the `plugins/prism-progress` Progress panel; a General-settings row) means exactly one surface carries them and the other shows a hint naming it. Choose it when a browser collects approval for a waiting Host operation.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

Focus the approval detail region to approve with Enter or reject with Escape. The mounted plugin reserves both keys against editable shortcuts. Enter on the focused Reject button retains its native reject action. Input controls and IME candidates keep their own keys. Keyboard and pointer actions share one pending-request lock; a withdrawn or replaced request cannot accept another answer, and an earlier failed answer cannot unlock its replacement. The sidebar line answers only through its two buttons, and only while the placement names that surface; it binds no keys, and its accessible names include the Session title, so a screen reader reading the list knows which Session it decides. Answering in either place settles the same Host request, and the other presentation disappears with it.

When offered, **Always allow** is the highlighted primary button. Otherwise, the current-request allow action is primary. Enter in the detail region always grants the limited scope: once for a tool approval, or the current session for CUA. Persistent access requires explicitly activating Always allow. The shortcut reference uses Allow because the caller supplies that scope.

<a id="model-experience"></a>
## Model Experience

None, as this package presents approval requests in the browser and registers nothing model-facing.

#### KV Cache effect

None; approval request and response rendering does not alter a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The shared `conversation.approval.card` Factory presents reject, allow and an optional always-allow action, with caller-owned scope, subject metadata and answer callbacks. Tool approvals retain their two outcomes. Application consent can reuse the card without adopting tool-approval policy. Subject metadata enables left-aligned content and wrapping actions; callers that omit it retain inherited alignment and a single action row. Icons and labels identify the subject visually; the caller owns identity verification and saved grants.
- **The row summary is requester text** — the line shows `displayReason` or `reason` verbatim, so a sandbox escalation reads `escalate sandbox to <mode>: <sentence>`. A structured target (a command's first line, a file path, a diff size) needs a summary field on the approval request and its audit event.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
