---
description: "Auto-answer approval requests under the autonomous-guarded permission preset while keeping sandbox escalations and deny rails under human control."
kind: "package-reference"
---
# Prism Autonomy

English | [中文](README.zh.md)

## Summary

`@prism/prism-autonomy` implements the autonomous tier of the permission presets. The `autonomous-guarded` preset (shipped in the base bundle's permission table, `workspace-write` + `ask`) engages the plugin: every approval request raised in such a session is answered `allowed-once` through the approval seam instead of reaching the client's approval card, except requests matching the configured require-human matchers — shipped default: sandbox escalations (`escalate sandbox to …`). Deny rails never produce an ask, so command guards and plan-mode refusals stay exactly as they are. Every auto-answer keeps the `approval/asked` + `approval/decided` audit pair, indistinguishable in the log from a human allow.

## Table of Contents

- [Use this package](#use-this-package)
- [Switching](#switching)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Host half is one Loader row in `dsh-web-app` (`prism-autonomy`) and requires `sessionProjections`, `permissionPresets`, and `agents`. Its config has two fields: `preset` names the permission preset that engages autonomy (default `autonomous-guarded`; the name must exist in the permission-presets catalog or the plugin fails to load), and `requireHuman` lists matchers (`tool`, `reasonPrefix`) whose requests keep their human decision.

The session's current preset folds from the durable `permission/preset` events into a session projection (`autonomy`), so the derived state survives reload and restart. Under any other preset the answerer delegates untouched — default sessions behave exactly as before. The `never` approval policy is inert for autonomy: the approval service rejects before any answerer runs, so the preset deliberately pairs `workspace-write` with `ask`.

<a id="switching"></a>
## Switching

Switching uses the existing permission surfaces: the `/permission autonomous-guarded` command or the Settings permission picker. A live switch to or from the engaging preset injects exactly one model-facing user message (`prism-autonomy` source) so the model knows approvals are now auto-granted — or manual again. Replay and session restore never re-inject the notice; restored sessions simply resume answering.

<a id="model-experience"></a>
## Model Experience

The model sees no approval cards and no new tools. Under the engaging preset, a request that would have waited for the user settles immediately as granted, so the tool result reads like any other success; a require-human match (shipped default: sandbox escalations) still produces the normal ask. The one new model-visible input is the switch notice, which states that approvals are granted automatically except sandbox escalations and that denial rules still apply — the model should not request sandbox escalation without evidence of a denial.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- An ACP-owned session switched to the autonomous preset is auto-answered too; the ACP permission channel is bypassed for it. The default is off, so this needs an explicit switch.
- The audit pair does not distinguish auto-answers from human allows; a separate autonomy event type was deferred.
- No client UI: the mode rides the existing permission picker and `/permission`.
- Only one tier ships (`autonomous-guarded`); finer tiers (edit-only, full yolo) were deferred.

<a id="dev-note"></a>
## Dev Note

The answerer registers with `prepend` on the `approval/request` waterfall, ahead of the remote client bridge, so an auto-answered request never renders a card. The unit tests cover the ladder, the matchers, fail-loud validation, the live notice, and restore; a recorded-session snapshot covers the switch notice (model-visible).
