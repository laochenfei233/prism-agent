# Agent Note: Enforce four advisory capabilities from an out-of-tree bundle

Status: implemented

English | [中文](2026-09-27-out-of-tree-capability-hardening.zh.md)

## Problem

Four DeepSeek Harness capabilities constrain an agent only through prose. Plan mode publishes a deployment-owned prompt section while every tool stays available; the repeat-tool reminder never vetoes a call; the agent loop has no turn budget; and the skill loader's denial names no next step. A deployment that needs one of these enforced has no seam to configure.

Hardening each capability inside its owning package is the direct route and, in this fork, the expensive one. Upstream is synchronized by importing a new tree rather than merging, so an edit to an upstream-owned file or a generated artifact must be replayed by hand at every import, while a new file or package is imported, or not, as a unit.

Plan mode makes that cost concrete. Its owning decision ([plan-specific collaboration state](../simplification/2026-07-22-plan-specific-collaboration-state.md)) rejected a per-plan tool-name allowlist because mutability is a property of each tool rather than a list every plan deployment must maintain, and it left plan mode as guidance rather than enforcement. Adding filtering inside `@deepseek-ai/dsh-plan-mode` would reverse that decision for every deployment, including deployments that want guidance alone.

## Decision

`plugins/prism-guardrails` is an out-of-tree bundle carrying four independent rails. Every rail is off until its configuration key names a value, and a key that is present but unusable fails plugin load, so omitting a key is the only way to disable its rail. Each rail registers on a published extension point and owns its decision there.

**Plan mode refuses named tools, in the deployment that asks for it.** `ctx.tools.guard()` refuses the configured tool names while `PlanModeController.get()` reports plan mode active, or selected and still waiting for the next accepted step. A guard rather than a `tools/pre-execute` listener, because guards are evaluated after the whole extensible pre-execute waterfall and have no allow result, so no other plugin's listener ordering can turn the refusal back into permission. The owning package is unchanged: plan mode still publishes guidance and still owns no name list, so a deployment that configures nothing sees exactly the behavior the earlier decision describes.

**A call repeating an identical predecessor goes to approval.** Past a run of `repeatAskAfter` identical consecutive calls, `tools/pre-execute` returns `{ kind: 'ask' }` instead of delegating. Counting lives in `tools/post-execute` because a refused or cancelled call reaches that waterfall too, so a model hammering the gate keeps meeting it and the run length it is told about keeps climbing. `ask` rather than `deny`, because legitimate long runs exist and only a human can separate them from a loop; with no approval channel the fail-closed approval ladder denies the call. An approval does not reset the run, because approvals are `allowed-once`; a claiming user message does, because repetition across a human interjection is not a loop.

**A turn cannot open more steps than the deployment allows.** `agent/pre-step` returns `{ kind: 'reject' }` once the step number exceeds `maxStepsPerTurn`. The judge is the step number the pre-step payload already carries, so retries, refused steps, resume, and fork are correct with no counter to keep, advance, or reset. The loop resets that number when a driver wakes, so the budget is per turn.

**A user-only skill's denial names the way forward.** A model call to the `skill` tool for a catalog entry that is user-invocable but not model-invocable is refused with `ask the user to type /<name> in their next message`. The decision reads the resolved catalog through the public skill registry — the same lookup the tool performs — and a skill that neither interface can invoke keeps the loader's own rejection, because there is no route to offer. The invocation policy itself is unchanged.

The bundle declares no runtime dependency. Every harness import in `src/` is `import type`, erased at build, so the emitted module imports nothing and reads plan-mode state, the skill catalog, and the tool pipeline through their published services and extension points.

## Related

- [Plan-specific collaboration state](../simplification/2026-07-22-plan-specific-collaboration-state.md) owns plan mode's guidance stance and the rejected allowlist; this bundle adds an opt-in refusal without changing that package.
- [Skill invocation policy](../feature/2026-07-28-skill-invocation-policy.md) owns the model and user invocation axes this bundle reads.
- [Tool call three phases](2026-09-22-tool-call-three-phases.md) owns the tool-call pipeline whose pre-execute and post-execute waterfalls these rails register on.
- [Bundle README](../../../../plugins/prism-guardrails/README.md) owns the configuration surface, each rail's exact behavior, and the known limitations.

## Alternatives considered

**Harden each capability inside its owning package.** Rejected because the fork replays upstream-owned edits by hand at every tree import, and because the plan-mode rail would reverse a recorded decision for every deployment rather than for the ones that opt in. The owning packages keep their published contracts either way.

**Add a new package under `packages/guard/`.** Rejected because it needs a hand-written `tsconfig.base.json` `paths` entry and a workspace install to exist at all, while the bundle's own `tsconfig.json` resolves the checkout's built declarations and its `vitest.config.ts` reuses the checkout's paths facade. A package is the right shape once the repository runner must collect the tests.

**Deny the repeated call instead of asking.** Rejected because legitimate long runs exist — polling one `job_output`, re-reading a file an external process changed — and only a human can tell them from a loop. A refusal removes the choice; an approval prices it, and the fail-closed ladder already produces the refusal where no channel exists.

**Reject the over-budget step inside `agent-loop`.** Rejected because the loop documents that it has no turn budget, and adding one would change the loop contract for every profile. The pre-step waterfall already exposes the step number the loop computed, so the decision belongs to a listener.

**Maintain a per-turn counter for the budget.** Rejected because the step number in the pre-step payload already answers the question, and a counter has to be advanced, reset per turn, and reconciled with retries, refusals, resume, and fork.

**Reset the repeat run when an approval is granted.** Rejected because approvals in this harness are `allowed-once` and are not persisted; resetting would let one decision buy unlimited repetitions of the same call.

**Make plan mode own the denied list.** Rejected for the reason the earlier decision records: the list would then apply to every plan deployment, and it would sit in an upstream-owned file that each import has to replay.

## Consequences

Every rail is additive and opt-in, so the four owning packages keep their published contracts and their recorded decisions, and a deployment that wants different limits edits one configuration row instead of carrying a package patch across every upstream import. The plan-mode rail is narrower than the allowlist the earlier decision rejected: it names tools to refuse rather than tools to allow, and it reads no tool metadata. A deployment that refuses `write`, `edit`, and `str_replace_editor` still reaches `bash`, because the checkout has no read-only command classifier and denying the shell would also deny the `git status`-class inspection that planning depends on.

The bundle sits outside the repository test runner. `plugins/` is not collected by the checkout's `vitest.config.ts`, so the rails run under the bundle's own config and do not contribute to `pnpm run test` or the per-file coverage gate. Its evidence is an artifact smoke that loads the emitted module, 42 composed tests against the production tool pipeline, the production agent loop, the real plan-mode controller, and the real skill registry, and four end-to-end runs that boot the shipped `headless` profile through the real Loader with the bundle loaded from its built artifact and assert each rail's enforcement in the resulting session events. Both wiring forms — the shipped package-name row and an overlay naming the built entry — were additionally booted through the `dsh` CLI itself, and each rail's refusal was observed in a real one-shot run: plan mode denies the named tool, the third and fourth identical calls reach the fail-closed approval ladder, a two-step budget ends the turn `blocked` and so exits non-zero in one-shot mode, and the skill loader's denial names the `/name` gesture. The documentation gates do scan the directory, which is why the bundle ships its bilingual README pair.

The repeat rail's `reason` is written for an approver, not for the model. When the approval service reports no channel, the tool registry substitutes its own `requires approval, but no approval channel is available` text, so an unattended deployment refuses the call with the registry's wording; the end-to-end run pins that outcome rather than this bundle's wording.

The turn-budget rail trades recoverability for a bound: a refused step is not model-visible, so the log line is the only record of why a turn stopped. The repeat rail has no `include` or `exclude` tool patterns, so a deployment cannot exempt a polling tool from the run count without a further change.
