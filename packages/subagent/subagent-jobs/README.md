---
description: "Job-registry bridge for users and maintainers composing subagent delegations into the background-job controls."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-jobs

English | [中文](README.zh.md)

## Summary

`dsh-subagent-jobs` mirrors subagent delegations into the background-job registry: every parent-delivered activation epoch registers a `subagent`-kind job owned by the delegating session, so `job_list`, `job_kill`, and the job roster govern delegations alongside shell and workflow background work. The child's answer itself is not carried by the job — the subagent settlement notice already reports it to the parent — and `dsh-tool-jobs` sends no completion notice for this kind. Stopping the job interrupts the child exactly like `interrupt_agent`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this bridge in any composition that should control delegations through the job tools. It requires the subagent service, the job registry, and a job controller (`dsh-tool-jobs`) in the owning composition; without a controller, registration fails per delegation with a contained warning and delegation itself is unaffected.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-tool-jobs'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
- name: '@deepseek-ai/dsh-subagent-jobs'
```

This package takes no configuration.

### What one job covers

One job covers exactly one activation epoch — the residency from `subagent/start` to the paired `subagent/end`. A continuable child that later accepts a follow-up starts a new epoch and therefore a new job. Settled records stay listed like settled `bash` jobs. Caller-delivered activations — the workflow engine's internal plumbing, whose result never reaches a parent session — produce no job.

### Job outcomes

| Stop reason | Job status |
|---|---|
| `completed` | `completed` |
| `aborted` | `killed` |
| `max-tokens`, `error`, `refusal`, backend-added variants | `failed` |

The stop reason travels as the terminal detail. A kill reason supplied to `job_kill` is merged in by the registry, and the job settles `killed` after the interrupt lands.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

A thin adapter over the subagent lifecycle bus events (`subagent/start`, `subagent/end`) and `ctx.jobs.start`. No lifecycle routing happens here: residency, settlement, and interrupt authorization belong to the subagent service; identity, terminal state, and the output ring belong to the registry.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Lifecycle listeners, kind declaration merge, outcome mapping, kill delegation |

### Kill path

`job_kill` reaches `JobHandle.cancel`, which calls `ctx.subagents.interrupt(childId, { kind: 'user', parentSessionId })`. The job-owner fence already proved the killer is the delegating session, and the interrupt authority re-checks the same parent lineage, so the two fences agree. A local child keeps its parked inbox, matching `interrupt_agent`; an external execution stops permanently.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Job controls over delegations

#### What the model sees

`job_list` gains `subagent`-kind rows (`<id> [subagent] <status> — <provider> subagent <childId>`). `job_output` on one returns no output ring content, only the status line. Settling a delegation produces no `tool-jobs` notice; the parent's settlement notice remains the single completion report.

#### Token effect

One `job_list` row per live epoch; no per-settlement notice cost beyond the existing settlement notice.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the bridge is the wrong choice; they are current package constraints.

- **No child progress in the ring** — the output ring stays empty; a running child's activity is visible only through its own session and the host UI. Streaming child transcript activity into the ring is deferred until a consumer needs it.
- **The label names the provider and child id, not the task** — the lifecycle payload carries no delegation task text; the label identifies the epoch, and `list_agents` remains the tool for child context.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
