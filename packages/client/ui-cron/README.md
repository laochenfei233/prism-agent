---
description: "The Web scheduled-task panel: task rows with rule, zone, next occurrence, and state, plus create, edit, delete, run-now, and recent results."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-cron

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-cron` shows the deployment's scheduled tasks in one Session-header control. Each row carries the Cron rule, its IANA zone, the next occurrence in that zone, and whether it is enabled; a row can be edited, enabled or disabled, deleted on a confirming second press, or run once immediately, and its recent runs expand in place. The panel is opt-in — the Web bundle ships it disabled and the Cron overlay enables it together with the Host capability.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load the plugin through the Cron overlay; the shipped Web graph resolves the package but leaves its row disabled, so an ordinary deployment never grows a control for a capability it is not running.

### What a row shows

A row states the rule as written, the zone it is stated in, the next occurrence rendered in that zone, and the enabled state. Rendering the next occurrence in the task's own zone rather than the browser's is the point of the row: a task stated in `Europe/Berlin` fires at 09:00 Berlin time whatever the viewer's zone is. Recent runs expand in place with their outcome, settle time, and duration.

### What a row offers

Editing opens the same form the create action uses, prefilled from the stored task. The destination switches between a new Session per run (workspace directory plus agent and permission presets) and continuing one named Session. A blank run ceiling states nothing, so the capability's own default stays in force rather than a fabricated number becoming the stored bound. Deleting needs a confirming second press; running now needs one, and a failed run leaves its reason in place.

### When the panel cannot serve

A process that does not hold the scheduler lease reports that another process is the scheduler instead of showing rows it cannot confirm — an empty list would tell the operator there are no tasks. A lost carrier keeps the last rows visible while the stream reconnects, and a terminal stream failure names its reason.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One slot entry in the header actions band (after static Session identity and the job list) renders the trigger and its panel. All data arrives through `ctx.cronJobs`, which owns the single follow generation for the whole Client; a second mounted header shares the same rows rather than opening a second subscription. The panel holds only its own draft, notice, and armed-delete state.

| File | Role |
|---|---|
| [`src/client/CronPanel.tsx`](src/client/CronPanel.tsx) | The panel: rows, the form, run-now, and recent results |
| [`src/client/logic.ts`](src/client/logic.ts) | Pure draft, time, and duration derivations |
| [`src/client/index.ts`](src/client/index.ts) | Slot registration, the command face, and the dictionaries |
| [`src/client/locales.ts`](src/client/locales.ts) | The `cron.panel` namespace copy (zh source of truth) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-api-cron-controller`](../../api/cron-controller/README.md) — the schedule Remote namespace and the follow stream behind every row.
- [`dsh-cron`](../../cron/cron/README.md) — the capability that owns the expression domain, the store, and the leader lease.
- [`dsh-tool-cron`](../../cron/tool-cron/README.md) — the model's own path to the same tasks.
- [`dsh-client-ui-primitives`](../ui-primitives/README.md) — the `StateDot` marker the rows use.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders the scheduled-task projection for a human and touches no prompt, message, schema, stream, or tool result. The model's own path to the same tasks stays with [`dsh-tool-cron`](../../cron/tool-cron/README.md).

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define current package constraints, not a task backlog.

- **Model selection is not editable.** A task that names a provider and model keeps them, and the form states the deployment default; a task cannot be pointed at a different model from the panel.
- **No pagination or filtering.** Every stored task renders in one list, which is fine at the scale a deployment schedules by hand and would not be at a much larger one.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package is a read-and-command projection of the `cron` Remote namespace onto one header slot entry; the follow generation belongs to `dsh-api-cron-controller`, and the plugin's own slot registration proves disposal through the HMR-safety spec.
