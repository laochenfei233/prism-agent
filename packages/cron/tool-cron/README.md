---
description: "The model-facing scheduled-task tools for users and maintainers composing, or debugging cron_create, cron_list, cron_update, cron_delete, and cron_run."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-cron

English | [中文](README.zh.md)

## Summary

`dsh-tool-cron` registers the five scheduled-task tools over `ctx.cron`. A task states its cron expression, its IANA time zone, where each run happens, and the message a firing delivers. Creating a task or re-pointing its target is the act that authorizes unattended spending, so both require a direct human message in the live root-agent turn; a target that creates its own session must also state the workspace, agent preset, and permission preset its runs act under. Every management failure reaches the model as one code from the closed `CronErrorCode` union.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount `dsh-tool-cron` beside [`dsh-cron`](../cron/README.md) when the model should manage scheduled tasks itself. The capability owns the rule, the store, the lease, and the run; this package owns only the schemas and results the model reads.

### Tools

| Tool | What it does |
|---|---|
| `cron_create(expression, time_zone, target, prompt, max_run_ms?, overlap_policy?, misfire_policy?)` | Creates one unattended task from a direct human turn |
| `cron_list()` | Lists every task with its rule, target, prompt, ceiling, enabled state, next occurrence, and recent runs |
| `cron_update(id, expression?, time_zone?, target?, prompt?, max_run_ms?, overlap_policy?, misfire_policy?, enabled?)` | Replaces the stated fields of one task from a direct human turn |
| `cron_delete(id)` | Removes one task and its recorded runs |
| `cron_run(id)` | Runs one task once, now, without moving its schedule |

`cron_create` and `cron_update` answer with the stored task's id, its next occurrence in RFC 3339 UTC, and its enabled state, so a caller never re-reads a task it just wrote. Every other result is the canonical JSON for the task or the run.

A `new-session` target states `workspace_path`, `agent_preset`, and `permission_preset`: the runs happen with nobody present, so the task itself must name what it runs as. Nothing here substitutes a default preset. `model_provider` and `model` are stated together or not at all, and override the deployment's default route for that task's runs.

### Configure it

```yaml
- id: tool-cron
  name: '@deepseek-ai/dsh-tool-cron'
  config:
    defaultMaxRunMs: 600000
```

`defaultMaxRunMs` is the run ceiling for a task whose creation states none. It must be a positive safe integer.

### Authority rules

`cron_create` and `cron_update` require a direct human message in the live root-agent turn, the same grant the model-facing goal tools require. An autonomous model round, a subagent, a nested caller, and a call with no open turn are all refused before the capability is reached, and the refusal names the tool that needed the human turn. `cron_list`, `cron_delete`, and `cron_run` take authority away rather than spend it, so they need the live root-agent turn but not a human message.

### Errors

Every tool's failure branch is `{ ok: false, code, message }`, where `code` is one of `cron_invalid_expression`, `cron_invalid_time_zone`, `cron_not_found`, `cron_not_leader`, and `cron_run_in_progress`. `cron_not_found` means exactly that the store holds no task under the stated id. A malformed argument and a throw from outside the capability are not domain states, so they surface as a failed call with their own text instead of borrowing a code.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the tools authenticate a caller and translate a failure; the observable contract is covered in [Use this package](#use-this-package).

### Design

- **Borrowed authority reading.** `src/authority.ts` reuses `goalToolExecution` and `requireDirectHuman` from [`dsh-tool-goal`](../../goal/tool-goal/README.md) rather than owning a second reading of the turn boundary. The dependency is on that package's library, not on its plugin: the check reads `ctx.agents` and `ctx.sessionProjections`, so composing these tools does not require the goal tools to be mounted.
- **Schema validates, body does not re-validate.** `defineTool` validates arguments before `execute`, so a missing field or a wrong type is refused by the registry. The body checks only the cross-field rules the schema DSL cannot express, such as a `new-session` target leaving out the presets its runs act under, and it fails those loud with their own text.
- **Provider refusals keep their code.** A `CronServiceError` becomes `{ ok: false, code, message }` under the code the capability raised. Any other throw is rethrown, so unexpected infrastructure failure stays an `isError` result rather than being laundered into a domain code.
- **One effect per tool.** Each registration runs inside its own `ctx.effect(...)`, so disposing the plugin fiber unregisters all five tools.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, the five tool registrations, result rendering, and the failure translation |
| [`src/authority.ts`](src/authority.ts) | The unattended-authority check the create and update tools require |
| — | No runtime invariant companion is published; the tools own no independent state, and the relationship they depend on (a process serves `ctx.cron` only while it leads) is enforced inside `dsh-cron`. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Cron capability](../cron/README.md) — the rule, store, lease, and run the tools manage.
- [Model-facing goal tools](../../goal/tool-goal/README.md) — the authority check this package reuses.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-cron) — the exact schemas the model receives.
- [Cron scheduled tasks Agent Note](../../../.agents/notes/proposed/feature/2026-09-26-cron-scheduled-tasks.md) — why creation is the authorizing act.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas and results

#### What the model sees

The generated [`cron_create`, `cron_list`, `cron_update`, `cron_delete`, and `cron_run` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-cron). Arguments, results, and refusals name only the expression, the zone, the target, the prompt, and the run ceiling; no panel, transport, storage, or leadership vocabulary reaches the model. `cron_create` and `cron_update` answer with the task id, the next occurrence as an RFC 3339 UTC instant, and the enabled state.

#### Token effect

Fixed schema cost on every request where these tools are visible, plus one result per call. `cron_list` grows with the number of stored tasks and the bounded run history each one keeps.

#### KV Cache effect

Schemas are prefix-stable while their definitions and visibility are unchanged. Calls and results append after the reusable request prefix without invalidating earlier entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the scheduled-task tools are a poor fit or need special care. They are current package constraints, not a task backlog.

- **A ceiling is a wall-clock bound, not a resource budget** — `max_run_ms` cancels a run that overruns; it does not bound tokens or tool calls within it.
- **No unattended full access** — a `new-session` task must state its permission preset, and this package never substitutes a permissive one for a task that named none.
- **Deletion carries no authority check of its own** — cancelling a task takes authority away, so an autonomous round may delete one; only creating and re-pointing require the human turn.
- **`cron_run` is not a firing** — it records one run and leaves the stored schedule and its next occurrence untouched.
- **Result instants are UTC** — the model reads every occurrence as an RFC 3339 UTC instant and must convert to the task's declared zone itself when reporting local time.
- **No snapshot pins the rendered text yet** — the schemas and results are pinned by this package's focused tests; a keyless recorded-session scenario for a Cron-fired run belongs to T15.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
