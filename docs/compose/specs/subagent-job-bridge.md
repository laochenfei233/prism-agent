---
feature: subagent-job-bridge
status: delivered
updated: 2026-11-10
branch: feat/subagent-job-bridge
commits: df1583090a..afdc2e943b
---

# Subagent Job Bridge

English | [中文](subagent-job-bridge.zh.md)

## Report

**What was built** — `@prism/prism-subagent-jobs` (`packages/subagent/subagent-jobs/`) bridges subagent delegations into the background-job registry: every parent-delivered activation epoch registers a `subagent`-kind job owned by the delegating session, so `job_list` and `job_kill` govern delegations alongside shell and workflow background work, closing the `check_async_task` / `cancel_async_task` / `list_async_tasks` vocabulary of the LangChain async-subagent model. Killing a job interrupts the child exactly like `interrupt_agent` (inbox parked; external executions stop permanently). The child's answer is never carried by the job — the subagent settlement notice remains the single completion report — and `dsh-tool-jobs` suppresses its completion notice for this kind. The lifecycle payloads gained additive observe-only `parentId` and `delivery` fields (cordis bus events, not `SessionEventMap` members), and caller-delivered workflow activations produce no job so the suppression is always correct.

**Verification** — `pnpm run typecheck` PASS (5 aggregate gates); vitest `packages/subagent/subagent-jobs` 10/10, `packages/jobs/tool-jobs` 62/62, plus `packages/sdk/server` + `packages/experimental/hooks-claude-code` + `packages/subagent/subagent/tests` 574 passed (1 skipped); `pnpm run duplication` 27 clones, identical to base, none in changed packages; `verify-cordis-catalog`, `verify-plugin-packages`, `verify-tsconfig-paths`, `verify-package-readme-model-experience` PASS on changed files; `verify-translation-pairing` PASS on changed files. Pre-existing on base and left untouched: real-product spec failures (subagent-codex/subagent-claude-code, need external binaries), 27 jscpd clones, speech-to-text-http README/product-use/pairing failures, MeetingSpeechStatus type-equiv drift.

**Journey log** — The delegation seam was already async end to end (non-blocking `subagent` tool, steer/followup settlement delivery in `manager.ts`); the one real gap was control-plane vocabulary, so the bridge mirrors activations into `ctx.jobs` instead of new tools. Caller-delivery activations (the workflow engine) had to be excluded from jobs — otherwise the tool-jobs suppression would drop the only completion report for them. The review caught four stale generated artifacts (cordis catalogs, plugin-packages reference, tsconfig aliases) and the missing product-package classification; all fixed by regeneration plus one optional-category row.

## [S1] Problem

The LangChain Deep Agents async-subagent model (`start_async_task` / `check_async_task` / `cancel_async_task` / `list_async_tasks`) maps almost entirely onto capabilities this harness already ships: non-blocking delegation with auto-delivered settlement notices, `send_message`, `interrupt_agent`, and `list_agents`. The one real gap is control-plane vocabulary: a running child cannot be listed or stopped through the same tool family the model uses for every other background work (`job_list`, `job_kill`), because subagent activations never register with the job registry.

## [S2] Design

### S2.1 Bridge package

New composition plugin `@prism/prism-subagent-jobs` at `packages/subagent/subagent-jobs/`. It couples the subagent service to the job registry without a dependency between them:

- Declares a `JobKindMap` merge: `subagent: 'subagent'`.
- Injects `subagents` and `jobs`.
- Subscribes to the subagent lifecycle bus events inside `ctx.effect()`:
  - `subagent/start` — starts a job: `kind: 'subagent'`, owner = the delegating parent's session id, label `<provider> subagent <childId>`; hooks resolve on the paired end edge.
  - `subagent/end` — settles the paired job: `completed` → `completed`; `aborted` → `killed`; `max-tokens`/`error`/`refusal` → `failed`, with the stop reason as terminal `detail`. `result` stays unset — the manager's settlement notice already carries the child's answer to the parent, so the job is a control-plane record, never a second delivery channel.
- `cancel` on the job handle delegates to the subagent service's interrupt for that child under the human-parent authority naming the owner session; the service re-checks the same parent lineage the job-owner fence already proved, and the child keeps its inbox, matching `interrupt_agent`.
- Requires a job controller in the owning composition (`dsh-tool-jobs`); without one, `ctx.jobs.start` throws its "no job controller serves this agent" error, contained by lifecycle containment and logged — delegation itself is unaffected.

### S2.2 Parent identity on the lifecycle payload

The lifecycle payloads (`SubagentRunInfo`, `SubagentRunEndInfo`) gain an additive observe-only `parentId: SessionId` field, populated by the manager, which already holds the parent at observer creation. Cordis bus payload extension only — these payloads are not `SessionEventMap` members, so no session-format or reader-compatibility work is triggered. All in-repo payload consumers are additive readers.

### S2.3 Completion-notice suppression

`dsh-tool-jobs` skips completion notices for `subagent`-kind jobs: the subagent settlement notice is the single completion report for a child, and a second "job finished, read its output" notice would duplicate it against an empty ring. Other kinds keep today's behavior.

### S2.4 Job = activation epoch

One job covers exactly one activation epoch (start edge → end edge). A continuable child that later accepts a follow-up starts a new epoch and therefore a new job, mirroring how the harness reports child work. Settled job records persist in `job_list` like settled `bash` jobs.

## [S3] Scope

- In scope: the bridge package with unit tests; the additive `parentId` payload field; the tool-jobs suppression with a test; READMEs for the new package, the subagent group map, and a tool-jobs note; a changelog entry.
- Out of scope: streaming child transcript activity into the job ring; carrying the delegation task text or answer through the job record; approval/`waiting` states for children (fixed child permission scope is a deliberate security stance); injecting in-flight children into the parent system prompt (trips the model-visible ⟺ logged rule); remote/browser projection changes beyond the open-string `kind`.

## Tasks

- [x] T1: Add `parentId` to the lifecycle payloads and populate it in the manager (depends: none) — covers S2.2
- [x] T2: Implement `prism-subagent-jobs` bridge package with tests (depends: T1) — covers S2.1, S2.4
- [x] T3: Suppress tool-jobs completion notices for `subagent` kind, with a test (depends: T2) — covers S2.3
- [x] T4: READMEs (new package, group map row, tool-jobs note) + changelog entry (depends: T2) — covers S2.1

## [S4] Acceptance

- [ ] A delegation produces a `subagent`-kind job owned by the delegating session; it is visible in `ctx.jobs.list(owner)` while running and settles with the mapped status when the child settles.
- [ ] `ctx.jobs.kill` on a running subagent job stops the child's current turn (inbox parked) and the job settles `killed`.
- [ ] Settled subagent jobs emit no tool-jobs completion notice; a settled `bash` job still does.
- [ ] Without a job controller, delegation still completes and the failed registration is logged, not thrown into the delegation path.
- [ ] `pnpm run typecheck` passes; focused unit tests pass; `pnpm run duplication` reports no new clones.
