---
description: "Browser approval UI that answers Host permission requests through the scoped interaction path."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-approval

English | [中文](README.zh.md)

## Summary

Browser approval presentation over the Agent-scoped Remote Event waterfall. The plugin publishes each pending request through `ctx.uiSession`, takes over the Conversation composer, optionally renders correlated Tool detail, and returns the user's decision to the waiting Host request. The same request also appears as the second line of its Session's sidebar row — the requester's one-line summary plus Reject and Allow once — so a background Session waiting on an approval is answered without opening it. Use it when a browser must collect approval for a waiting Host operation. The card answers from the keyboard: Enter allows once and Escape rejects while the card owns focus, and the arrow keys move focus between the two actions so Enter presses the focused one; both run the same handlers as the buttons.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

Focus the approval detail region to approve with Enter or reject with Escape. The mounted plugin reserves both keys against editable shortcuts. Enter on the focused Reject button retains its native reject action. Input controls and IME candidates keep their own keys. Keyboard and pointer actions share one pending-request lock; a withdrawn or replaced request cannot accept another answer, and an earlier failed answer cannot unlock its replacement. The sidebar line answers only through its two buttons and binds no keys; its accessible names include the Session title, so a screen reader reading the list knows which Session it decides. Answering in either place settles the same Host request, and the other presentation disappears with it.

<a id="model-experience"></a>
## Model Experience

None, as this package presents approval requests in the browser and registers nothing model-facing.

#### KV Cache effect

None; approval request and response rendering does not alter a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The panel exposes transient decisions only** — it supports allow-once and reject; persistent permission policy remains owned by Host-side approval packages. Requester-supplied localized presentation copy follows the UI language without changing the audit reason or translating model-generated text.
- **The row summary is requester text** — the line shows `displayReason` or `reason` verbatim, so a sandbox escalation reads `escalate sandbox to <mode>: <sentence>`. A structured target (a command's first line, a file path, a diff size) needs a summary field on the approval request and its audit event.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
