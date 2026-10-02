---
description: "The cron group map: calendar scheduled tasks that fire unattended on a five-field rule in an explicit time zone, for users and maintainers navigating the group."
kind: "package-group"
---

# cron/ — Calendar scheduled tasks

English | [中文](README.zh.md)

## Summary

The cron group schedules work that runs whether or not a conversation is open. A task states a five-field cron rule, the IANA zone it is read in, where each run happens, and the message a firing delivers; a run needs no open Session, so creating or re-pointing a task authorizes unattended spending. The group owns the rule vocabulary, a durable task store behind a cross-process leader lease, the timer that fires due tasks, and delivery into a Session. Model-facing and browser-facing packages manage tasks over that capability; the browser panel is opt-in and carries no runtime.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`cron/`](cron/README.md) | The `ctx.cron` capability: expression parsing and day matching, occurrence resolution, the `cron` storage domain behind a leader lease, the segmented timer, and delivery into a Session | `ctx.cron` |
| [`tool-cron/`](tool-cron/README.md) | The five model-facing scheduled-task tools with their unattended-authority check | — (tools only) |

-----

<a id="related-documentation"></a>
## Related documentation

- [Calendar scheduled tasks subsystem](../../docs/subsystems/cron.md) — expression semantics, durable records, leadership, run lifecycle, and the management surfaces.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-cron) — the `cron_create`/`cron_list`/`cron_update`/`cron_delete`/`cron_run` schemas the model receives.
- [Cron scheduled tasks Agent Note](../../.agents/notes/proposed/feature/2026-09-26-cron-scheduled-tasks.md) — the decision, its authority model, and its rejected alternatives.
- [Session-local Schedule](../schedule/README.md) — the in-conversation reminder it is deliberately distinct from.
- [Scheduled-task panel](../client/ui-cron/README.md) and [Remote controller](../api/cron-controller/README.md) — the browser and Host management surfaces over the same capability.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The capability ships as one package with its provider rather than a service/provider split: a provider seam is justified by a second provider, and none exists. The lease is the only cross-process relationship, and it is enforced inside `CronOwnership` instead of asserted by a runtime invariant.

</details>
