---
description: "Host and Client scheduled-task control: mutate stored tasks and follow their complete projection."
kind: "package-reference"
---
# Cron Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-cron-controller` owns the Host `ctx.cronController` service and the generated Client `ctx.remote.cron` namespace. Its Remote methods create, edit, and remove stored tasks and run one on demand, and its `follow()` stream carries one complete baseline followed by ordered increments. Use it through API Gateway when a Client must change or follow scheduled tasks.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Host controller reads [`ctx.cron`](../../cron/cron/README.md) at call time and maps every declared refusal to a stable Remote code, so a surface branches on `cron/invalid-expression`, `cron/invalid-time-zone`, `cron/not-found`, `cron/not-leader`, or `cron/run-in-progress` instead of matching a message. A process that holds no scheduler lease answers `cron/not-leader` for every verb, and its follow generation opens with that same refusal rather than an empty list: an empty list on a panel reads as "this deployment has no tasks", which is the one conclusion a follower cannot support.

`follow()` opens one generation per subscription: a complete baseline first, then one frame per committed write to the `cron` domain's job table. A reconnect starts another generation with a replacement baseline, so no consumer depends on receiving every increment while disconnected. A write the controller did not make still reaches an open generation, because the feed follows the domain's own commit events rather than the requests that produced them.

The Client entry provides `ClientCronModel`, `CronJobs`, and `createCronStateStream()`. The model owns the task rows, the generation lifecycle, unary mutation echoes, and stream/unary race resolution: the newest `updatedAt` wins, and a removed identity can never be revived by delayed data. The service exposes bare observable state and commands, leaving rows, copy, and formatting to the UI owner.

Run history reaches a row through the stored record's own write, so `runNow` installs no local echo: a panel that showed a run the task never committed would report work that did not happen.

| Method | Purpose |
| --- | --- |
| `create(request)` | Store one task and answer with its decoded projection |
| `update(request)` | Replace the stated fields of one stored task |
| `delete({ jobId })` | Remove one task and answer with the row it showed |
| `runNow({ jobId })` | Run one task once without changing its schedule |
| `follow()` | Stream a complete baseline, then ordered stored-task increments |

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is the browser and Host control surface for scheduled tasks and registers no prompt, tool, or session event. The model reaches the same capability through [`dsh-tool-cron`](../../cron/tool-cron/README.md); a task's own runs are what later reach a model request, and those belong to the Session that performed them.

#### KV Cache effect

No direct effect; scheduling control does not alter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `follow()` replaces the whole projection after reconnect and has no durable cursor or incremental catch-up protocol.
- The Client model keeps process-local removal markers for its own lifetime, so a delayed frame cannot revive a removed task only while that model lives.
- A generation that opens with `cron/not-leader` stays open without further frames; the panel learns that leadership changed only from a later generation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The `cron` storage domain owns persistence, and every stream generation is a full projection.
