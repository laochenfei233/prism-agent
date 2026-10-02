# prism-guardrails

English | [中文](README.zh.md)

An out-of-tree DeepSeek Harness bundle that turns four **advisory** capabilities into **enforced** ones.

It is a bundle in the shape of a published plugin (`dsh.bundle.patch` + a Loader-loadable Host half), not a change to the Harness checkout: every rail registers on a documented extension point, and no upstream package is rewritten.

## Why this exists

| Rail | What DeepSeek Harness ships on its own | What this bundle adds |
|---|---|---|
| Plan mode | A prompt section. `packages/plan/plan-mode/README.md` calls it "Guidance, not enforcement", and the recorded decision behind it explicitly rejected tool-name filtering | A monotonic `tools.guard()` that refuses deployment-named tools while plan mode is in force |
| Repeated calls | `@deepseek-ai/dsh-repeat-tool-reminder`: advisory reminders, and it never vetoes a call | The call after a configured run of identical calls goes to approval |
| Turn length | `packages/core/agent-loop/README.md` states "No built-in turn budget"; no step or iteration cap exists anywhere | A turn cannot open a step beyond the configured number |
| Skill invocation | The loader throws `skill "X" is not available for model invocation`, which names no next step | The denial names the `/name` gesture that would actually load it |

The bundle is independent of the packages it hardens. It reads plan-mode state through the controller's public `get()`, the skill catalog through the public registry, and the tool pipeline through the documented waterfalls and guard seam, so it composes with a stock checkout and degrades to a no-op when a service is absent.

## Configuration

Every rail is **off** until its key names a value, and a key that is present but unusable **fails plugin load**. Omitting a key is therefore the only way to disable its rail, so a misspelled key cannot pass as an intentional omission.

| Key | Type | Meaning | Default |
|---|---|---|---|
| `planDeniedTools` | non-empty array of distinct, non-blank tool names | Global tool names refused while plan mode is active | rail off |
| `repeatAskAfter` | integer `0` or `>= 2` | Consecutive identical calls tolerated before the next one goes to approval; `0` disables | rail off |
| `maxStepsPerTurn` | integer `>= 1` | Steps one turn may open | rail off |
| `skillInvocationGuidance` | boolean | Whether a user-only skill's model-invocation denial names the way forward | `true` |

Load-time rejections, each with the message asserted by the test suite:

| Input | Result |
|---|---|
| `planDeniedTools` not an array | `planDeniedTools must be an array of tool names` |
| `planDeniedTools: []` | `planDeniedTools must not be empty — omit the key to disable the plan-mode rail` |
| a blank or non-string entry | `planDeniedTools entries must be non-empty tool names` |
| a repeated name | `planDeniedTools names "write" twice` |
| `repeatAskAfter` not an integer, or `< 0` | `repeatAskAfter must be an integer >= 0` |
| `repeatAskAfter: 1` | `repeatAskAfter must be 0 (off) or >= 2 — one call is not a loop` |
| `maxStepsPerTurn` not an integer, or `< 1` | `maxStepsPerTurn must be an integer >= 1` |
| `skillInvocationGuidance` not a boolean | `skillInvocationGuidance must be a boolean` |
| any other key | `unknown config key(s) …` |

## Rails

### Plan-mode tool denial

Registered as `ctx.tools.guard()`, not as a `tools/pre-execute` listener. Guards are evaluated after the whole extensible pre-execute waterfall and have no allow result, so no other plugin's listener ordering can turn the refusal back into permission.

The guard reads `PlanModeController.get()` — the same logged-plus-selected criterion the plan guidance prompt section uses — so a selection that is still waiting for the next accepted step already refuses. A denial reads:

```
Error: plan mode is active: `write` is not executed until the plan is approved; present the plan with exit_plan_mode or leave with /plan off
```

A deployment that mounts no plan-mode service restricts nothing: the rail has no state of its own to invent. `bash` and `pwsh` are deliberately absent from the shipped patch because the checkout has no read-only command classifier, so denying them would also deny the `git status`-class inspection that planning depends on.

### Repeated-call approval

The call after a run of `repeatAskAfter` identical consecutive calls is returned as `tools/pre-execute`'s `{ kind: 'ask' }`, so a human prices the repetition. Counting stays in `tools/post-execute` because a refused or cancelled call reaches that waterfall too — a model hammering the gate keeps meeting it, and the run length it is told about keeps climbing.

`ask` rather than `deny` because legitimate long runs exist: polling one `job_output`, or re-reading a file an external process changed. Only a human can tell those from a loop, and a refusal would remove the choice instead of pricing it. With no approval channel the fail-closed approval ladder denies the call, which is the intended unattended outcome.

Two further decisions are load-bearing. An approval does **not** reset the run: approvals are `allowed-once`, so resetting would sell unlimited repeats for one decision. A claiming user message **does** reset it, because repetition across a human interjection is not a loop.

Call identity is the tool name plus its arguments with object keys deep-sorted, so two calls that differ only in property order are the same call.

The `reason` this rail supplies is what an approver reads. It is not what the model reads when the approval service reports no channel: the tool registry substitutes `tool "<name>" requires approval, but no approval channel is available`, so an unattended deployment refuses the call with the registry's wording rather than this rail's.

### Turn budget

`agent/pre-step` returns `{ kind: 'reject' }` once the step number exceeds `maxStepsPerTurn`, and logs the turn, the budget, and the step it refused.

The judge is the step number the loop already carries in the pre-step payload, so nothing is counted, advanced, or reset here: retries, refused steps, resume, and fork are all correct by construction. The loop resets that number when a driver wakes, so the budget is per turn — a second turn starts with a fresh one.

A refused step is not model-visible, so the log line is the only record of why the turn stopped. A one-shot `dsh --profile headless` run whose turn is cut off this way exits non-zero: the runner exits `0` only for a turn that ended `completed`, and a budget rejection ends it `blocked`.

### Skill-invocation guidance

A model that calls the `skill` tool for a skill whose catalog entry is user-invocable but **not** model-invocable is refused with the gesture that would work:

```
Error: skill "user-only" is user-invoked only: ask the user to type /user-only in their next message
```

The decision reads the resolved catalog through the public registry — the same lookup the skill tool performs. A skill that neither interface can invoke keeps the loader's own rejection, because there is no route to offer and inventing one would be wrong. An unknown name, a call naming another tool, a call whose `name` argument is absent, non-string or empty, a deployment with no skill service, and a deployment with `skillInvocationGuidance: false` all delegate unchanged.

## Wiring

The bundle patches one row over the profile root, and `cordis.patch.yml` ships that row under the package name — the form a profile resolves once the bundle is installed or published. Both forms below were booted for real against the shipped `headless` profile.

**Installed by package name.** Link or install the built bundle so the profile can resolve it, then boot:

```sh
cd plugins/prism-guardrails && npm run build
node --import tsx/esm apps/cli/src/bin.ts --profile headless --patch plugins/prism-guardrails/cordis.patch.yml "<task>"
```

**Not installed.** `loadOverlayPatches` rewrites a relative or absolute `name` to a `file://` URL anchored beside the patch file, so an overlay shipped next to the bundle names the built entry — no install, no workspace membership:

```yaml
- insert:
    - id: prism-guardrails
      name: '../../lib/index.js'
      config:
        planDeniedTools: [write, edit, str_replace_editor]
        repeatAskAfter: 5
        maxStepsPerTurn: 20
        skillInvocationGuidance: true
```

`tests/fixtures/cli-boot.patch.yml` is exactly that overlay, and it drives the plan-mode rail through the product's own one-shot path:

```sh
node --import tsx/esm apps/cli/src/bin.ts --profile headless \
  --patch plugins/prism-guardrails/tests/fixtures/cli-boot.patch.yml --json "probe the rails"
```

```json
{"type":"tool_result","callId":"cap-1","status":"error","result":"Error: plan mode is active: `write` is not executed until the plan is approved; present the plan with exit_plan_mode or leave with /plan off"}
{"type":"final","text":"planning complete"}
```

## Build and verify

The bundle borrows the checkout's packages instead of declaring workspace dependencies: every `@deepseek-ai/*` import in `src/` is `import type`, so the emitted module imports nothing and a deployment installs nothing. `tsconfig.json` resolves those types through the checkout's **built** declarations, which is how the repository's own packages consume each other — run `pnpm run build` in the checkout first.

```sh
npm run typecheck   # tsc against the checkout's built declarations: exit 0
npm run build       # lib/index.js, no runtime imports
npm run smoke       # artifact: exports, registered surfaces, fail-loud config
npm test            # 42 composed unit tests
npm run test:e2e    # 4 end-to-end capability runs against the shipped headless profile
```

`vitest.config.ts` reuses the checkout's `tsconfig.base.json` paths facade and decorator pre-transform, so `tests/prism-guardrails.spec.ts` composes the **real** services — the production tool pipeline, the production agent loop against a scripted mock adapter, the real plan-mode controller, and the real skill registry — rather than a hand-built stand-in for the extension points. Assertions are on model-visible tool results, executed effects, and request counts.

`tests/capability.e2e.spec.ts` goes further: it boots the shipped **headless** profile through the real Loader with the bundle loaded from its built artifact by relative path, scripts the model through a mock adapter, and asserts each rail's enforcement in the resulting session events — the plan-mode denial text, two refused repeated calls after two permitted ones, a turn ending `blocked` at the step budget, and the user-only skill's guidance. That run is why the overlay fixtures disable the session-title provider: it issues its own model call through the same route.

Vitest needs vite's Windows real-path probe to spawn a child process, which a confined file sandbox denies; run it outside that confinement.

## Known Limitations and Deferred Work

- **The bundle is outside the repository test runner.** It lives in `plugins/`, which the checkout's `vitest.config.ts` does not collect, so it carries its own config and does not run under `pnpm run test` or the per-file coverage gate. Its evidence is the suites above, not CI.
- **`skillNameArgument`'s non-object guard is unreachable through the shipped tool set.** The registry validates a call against the tool's compiled object schema before the pre-execute waterfall, so a non-object argument list is rejected first — the test suite pins that rejection. The two lines are kept so the function stays total at a model tool-JSON boundary rather than throwing inside a listener, which would fail every call to the tool.
- **The repeat rail has no `include`/`exclude` patterns.** `@deepseek-ai/dsh-repeat-tool-reminder` offers wildcard tool selection and this rail does not; a deployment that needs it must say so with a concrete consumer.
- **Reasoning-streak loop governance is not implemented.** This bundle detects repetition by tool name plus arguments only. Detecting a repeated *thinking* prefix and pruning the polluted span from the request view while the log keeps the full trajectory is a separate, larger capability.
- **The shipped defaults are a deployment policy, not a recommendation.** `planDeniedTools`, `repeatAskAfter: 5`, and `maxStepsPerTurn: 20` come from the fork's `CAPABILITY-PLAN.md`; a deployment that disagrees edits the row.
- **No Chinese README pair is required for `plugins/`.** The repository's translation-pairing gate already reports the sibling `plugins/dsh-agent-progress/` for a missing pair; this bundle ships the pair so it adds no failure of its own.
