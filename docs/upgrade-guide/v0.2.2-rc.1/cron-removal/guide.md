---
kind: upgrade-guide
description: "The Cron scheduling packages, their model tools, Remote namespace, and panel are removed; rebuild those tasks as Schedule tasks."
---

# Cron scheduling is retired in favor of Schedule

English | [中文](guide.zh.md)

## Change

The repository carried two scheduling systems. Schedule owns the Host task store behind the Automation tasks page, and Cron was a separate opt-in stack: `@deepseek-ai/dsh-cron`, `@deepseek-ai/dsh-tool-cron`, `@deepseek-ai/dsh-api-cron-controller`, the `@deepseek-ai/dsh-client-ui-cron` panel, and the `apps/cli/config/examples/cron/cordis.yml` overlay. That stack is removed.

- The model tools `cron_create`, `cron_list`, `cron_update`, `cron_delete`, and `cron_run` no longer exist. Prompts, skills, and scripts that called them fail on an unknown tool.
- The `ctx.cron` capability, the `ctx.cronController` Host service, and the `ctx.remote.cron` Client namespace are gone, along with the Refused Remote codes `cron/invalid-expression`, `cron/invalid-time-zone`, `cron/not-found`, `cron/not-leader`, and `cron/run-in-progress`.
- The Cron overlay is deleted. A profile or configuration that listed any of these packages as Loader rows now fails to resolve that row.
- Stored `cron` domain records stay on disk unchanged and are no longer read. No migration converts them: Cron's per-task agent preset, permission preset, model, overlap policy, and misfire policy have no Schedule equivalent, so a conversion would lose them silently.
- A message source of `{ kind: "cron", jobId }` is no longer produced. Sessions that recorded one remain readable, because consumers fall through unknown source kinds.

Schedule already covers the vocabulary this removal loses: the Automation tasks page and `schedule_*` tools accept five-field Cron timing (with an explicit IANA zone), repetition by RRULE, and the same three delivery targets (an existing Session, one Session created and reused, or a new Session per delivery).

## Migration

1. In the Automation tasks page, recreate each Cron task as a Schedule task, then disable it in the old overlay deployment. A task that used a Cron expression keeps that rule under Schedule's Custom timing, with the same IANA zone.
2. In prompts, skills, and scripts, replace the `cron_*` calls with `schedule_create`, `schedule_list`, `schedule_view`, `schedule_edit`, and `schedule_delete` as the [Schedule tools guide](../../v0.2.2-alpha.2/schedule-agent-tools/guide.md) describes; delegated subagents may not manage tasks.
3. Remove every removed package from custom `cordis.yml` compositions and profile overlays. Read `ctx.cron` nowhere; the `schedule` service is the remaining scheduling capability.
4. If a Client read the `cron` Remote namespace, follow the schedule Remote surface instead. Nothing replaces the per-task run history: Schedule records each task's own view, so a scheduled run's outcome is read from that task.
5. Confirm the result by opening the Automation tasks page and listing the recreated tasks, then running one task once.
