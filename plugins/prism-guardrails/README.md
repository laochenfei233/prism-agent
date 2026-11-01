# prism-guardrails

English | [中文](README.zh.md)

An out-of-tree DeepSeek Harness bundle that turns twelve **advisory** capabilities into **enforced** ones.

It is a bundle in the shape of a published plugin (`dsh.bundle.patch` + a Loader-loadable Host half), not a change to the Harness checkout: every rail registers on a documented extension point, and no upstream package is rewritten.

Four of the twelve are hardenings of DeepSeek Harness's own advice. Six turn the rules of three method packs — **Ponytail** (the laziness ladder: reuse before writing, the standard library before a dependency, a marked shortcut over an unmarked one), **Aegis** (route before you act, verify before you claim), and **Compose Next** (finish the plan you wrote before reporting) — from text the model is asked to follow into decisions the tool pipeline makes. The last two cover destructive commands and credential reads, which neither the tool pipeline nor the sandbox refuses: `SandboxMode` governs file effects, and network and process policy are outside its vocabulary (`packages/sandbox/sandbox-policy/README.md`). The rails read what the model does; the Ponytail mode itself is part of this bundle (see Ponytail mode below), while the Aegis and Compose Next skills stay where their method packs installed them.

## Why this exists

| Rail | What ships on its own | What this bundle adds |
|---|---|---|
| Plan mode | A prompt section. `packages/plan/plan-mode/README.md` calls it "Guidance, not enforcement", and the recorded decision behind it explicitly rejected tool-name filtering | A monotonic `tools.guard()` that refuses deployment-named tools while plan mode is in force |
| Repeated calls | `@deepseek-ai/dsh-repeat-tool-reminder`: advisory reminders, and it never vetoes a call | The call after a configured run of identical calls goes to approval |
| Turn length | `packages/core/agent-loop/README.md` states "No built-in turn budget"; no step or iteration cap exists anywhere | A turn cannot open a step beyond the configured number |
| Skill invocation | The loader throws `skill "X" is not available for model invocation`, which names no next step | The denial names the `/name` gesture that would actually load it |
| Routing (Aegis) | The method pack asks for a routing decision before the first non-readonly call; on its other hosts it appends a marker **after** the call that broke the contract | The call itself is refused until the decision is on the record |
| Write breadth (Ponytail) | The ladder prefers the existing helper over a new one, with no mechanism behind it | A turn writing more distinct files than the deployment allows sends the next new path to approval |
| Marker discipline (Ponytail) | The convention is `shortcut: <ceiling>, <upgrade path>` (older code says `ponytail:`); the pack's own debt report flags a marker with no trigger as the one that rots | A marker with no upgrade path is refused before it is written |
| Dependency changes (Ponytail) | "Never add a new one for what a few lines can do" is prose | A write to a dependency manifest goes to approval |
| Verification (Aegis) | `verification-before-completion` states the required evidence in a skill the model is asked to load | A turn that wrote files and ran no verification is sent back for its evidence before it can stop |
| Turn completion (Compose Next) | The workflow tells the model to finish its tasks and produce delivery evidence; the loop still ends the turn whenever the model stops calling tools | A turn whose own todo list still holds open items is steered to continue before it can stop |
| Destructive commands | Nothing parses a shell command's text, and `bash` and `pwsh` are deliberately absent from the plan-mode rail for that reason; the sandbox covers file effects, not a force-push | A command matching a configured pattern goes to approval |
| Credential reads | `read` and `grep` are read-only tools to every other rail, and a read lands in the session log permanently | A read of a configured credential path is refused |

The bundle is independent of the packages and method packs it hardens. It reads plan-mode state through the controller's public `get()`, the skill catalog through the public registry, and the tool pipeline, the turn boundary, and the session log through documented extension points, so it composes with a stock checkout and degrades to a no-op when a service is absent.

## Ponytail mode

The method pack's own behavior is part of this bundle, not a skill a host has to install separately. The bundle patch mounts a second row (`prism-guardrails-ponytail`, name `prism-guardrails/ponytail`) in the profile, so the mode is present under every agent preset: one system-prompt section states the level's rules, and the slash commands that used to be described by skills are real registrations.

| Level | Effect |
|---|---|
| `lite` | Build what was asked, and name the smaller option you did not take in one line |
| `full` | The whole ladder, a check where the logic needs one, and a reply that names what was skipped and the risk (default) |
| `ultra` | `full`, plus push back on any part of the request the need does not justify |
| `off` | Contributes no section; the rails and commands stay mounted |

| Command | Effect |
|---|---|
| `/ponytail [lite\|full\|ultra\|off\|auto]` | Show or switch the level; `auto` drops an explicit choice, and no argument prints the level with the full gesture list |
| `/ponytail-debt [marker word]` | Scan the session's working directory for `shortcut:`/`ponytail:` markers and report the ledger, flagging every row with no upgrade trigger |
| `/ponytail-review` | Steer the agent into the change-review workflow (bugs, safety, load, tests, speed, leanness) |
| `/ponytail-audit` | The same workflow for the whole repository |
| `/ponytail-gain` | The published benchmark scoreboard, with its honesty boundary |
| `/ponytail-help` | The reference card |

A working session reaches `lite` on its own, without a command:

| Rule | Trigger | Result |
|---|---|---|
| Coding preset | the session runs under a preset listed in `autoCodingPresets` (`standard` and `ptc` by default), at creation or after a switch | `lite` |
| Long task | the session opens `autoLongTaskSteps` cumulative steps (20 by default; `0` disables the rule) | `lite` |

An explicit `/ponytail` choice wins over both rules for that session, and `/ponytail auto` drops the choice so the rules apply again. The level resolves per assembly from the session's own state, so one coding session running at `lite` never changes the level of a session beside it; `level:` in the row's config is the starting value and the fallback. The rails in `index.ts` remain the enforcement half — the mode states the rules and the rails refuse the writes that break them, so a level change never widens what the tool pipeline accepts.

The prompt text and the workflows are maintained here rather than vendored from the method pack's `SKILL.md` files: updating the wording is an edit to `src/ponytail.ts`, and nothing else in the profile needs to change.

## Configuration

Every rail is **off** until its key names a value, and a key that is present but unusable **fails plugin load**. Omitting a key is therefore the only way to disable its rail, so a misspelled key cannot pass as an intentional omission.

| Key | Type | Meaning | Default |
|---|---|---|---|
| `mode` | `enforce` or `observe` | Whether a `deny` or `ask` is applied, or recorded and let through | `enforce` |
| `planDeniedTools` | non-empty array of distinct, non-blank tool names | Global tool names refused while plan mode is active | rail off |
| `repeatAskAfter` | integer `0` or `>= 2` | Consecutive identical calls tolerated before the next one goes to approval; `0` disables | rail off |
| `maxStepsPerTurn` | integer `>= 1` | Steps one turn may open | rail off |
| `unfinishedTodoContinuations` | integer `>= 0` | Times one turn is sent back because the agent's own todo list still has open items; `0` disables | rail off |
| `skillInvocationGuidance` | boolean | Whether a user-only skill's model-invocation denial names the way forward | `true` |
| `writeTools` | non-empty array of `{ tool, pathArgument, contentArgument? }` | The deployment's file-writing tools; required by every rail that reads written content | required by those rails |
| `maxWrittenFilesPerTurn` | integer `>= 0` | Distinct files one turn may write before the next new path goes to approval; `0` disables | rail off |
| `requirePonytailUpgradePaths` | boolean | Whether a written `shortcut:` comment (older `ponytail:`) must name its ceiling and upgrade path | `false` |
| `dependencyManifests` | non-empty array of distinct, non-blank file names | File names whose write goes to approval | rail off |
| `routingContract.readOnlyTools` | non-empty array of distinct, non-blank tool names | The tools that only read; the first call to any other is the contract's trigger | rail off |
| `verificationGate.verifyTools` | non-empty array of distinct, non-blank tool names | The tools whose completed call is accepted as verification | rail off |
| `readTools` | non-empty array of `{ tool, pathArgument }` | The deployment's file-reading tools; required by the sensitive-read rail | required by that rail |
| `sensitivePaths` | non-empty array of distinct, non-blank path segments | Path segments treated as credential material | rail off |
| `commandGuard.tools` | non-empty array of `{ tool, commandArgument }` | The tools whose call carries a command line | required by that rail |
| `commandGuard.deny` | non-empty array of `{ pattern, reason }` | Regular expressions a command is matched against, and why an approver should care | required by that rail |

`writeTools` entries name the tool's **own** argument keys, so a profile whose writing tool calls them something else is configured rather than special-cased. For DeepSeek Harness's own tool set that is `{ tool: write, pathArgument: file_path, contentArgument: content }` and `{ tool: edit, pathArgument: file_path, contentArgument: new_string }`; `contentArgument` is omitted for a tool that carries no text.

`readTools` works the same way: `{ tool: read, pathArgument: file_path }`, `{ tool: read_image, pathArgument: file_path }`, and `{ tool: grep, pathArgument: path }` cover DeepSeek Harness's three tools that read by path.

`mode` is the only key that applies to every rail at once, and it is the only way to see a rail before arming it: under `observe` each rail decides exactly as it would under `enforce`, records the decision, and lets the call through. `/guardrails` lists what it would have stopped. A `deny` and an `ask` are both observations; a `steer` is not, because sending a turn back for evidence is a request to finish work rather than a refusal, and observing must not switch it off.

Load-time rejections, each with the message asserted by the test suite:

| Input | Result |
|---|---|
| `mode` neither `enforce` nor `observe` | `mode must be "enforce" or "observe", received …` |
| `planDeniedTools` not an array | `planDeniedTools must be an array of tool names` |
| `planDeniedTools: []` | `planDeniedTools must not be empty — omit the key to disable the plan-mode rail` |
| a blank or non-string entry | `planDeniedTools entries must be non-empty tool names` |
| a repeated name | `planDeniedTools names "write" twice` |
| `repeatAskAfter` not an integer, or `< 0` | `repeatAskAfter must be an integer >= 0` |
| `repeatAskAfter: 1` | `repeatAskAfter must be 0 (off) or >= 2 — one call is not a loop` |
| `maxStepsPerTurn` not an integer, or `< 1` | `maxStepsPerTurn must be an integer >= 1` |
| `unfinishedTodoContinuations` not an integer, or `< 0` | `unfinishedTodoContinuations must be an integer >= 0` |
| `skillInvocationGuidance` not a boolean | `skillInvocationGuidance must be a boolean` |
| `writeTools` not an array, or empty | `writeTools must be an array of { tool, pathArgument, contentArgument? } entries` |
| an entry naming no tool or no path argument | `writeTools entries must name a tool` / `writeTools entry "write" must name its pathArgument` |
| a blank `contentArgument` | `writeTools entry "write" must name a non-empty contentArgument or omit it` |
| a repeated tool name | `writeTools names "write" twice` |
| an unknown entry key | `unknown writeTools key(s) …` |
| `maxWrittenFilesPerTurn` not an integer, or `< 0` | `maxWrittenFilesPerTurn must be an integer >= 0` |
| `requirePonytailUpgradePaths` not a boolean | `requirePonytailUpgradePaths must be a boolean` |
| `dependencyManifests` empty, blank, or repeated | `dependencyManifests must not be empty — omit the key to disable the dependency rail`, `… entries must be non-empty file names`, `… names "package.json" twice` |
| `routingContract` not an object, or an unknown key | `routingContract must be an object { readOnlyTools }`, `unknown routingContract key(s) …` |
| `verificationGate` not an object, or an unknown key | `verificationGate must be an object { verifyTools }`, `unknown verificationGate key(s) …` |
| an empty `readOnlyTools` / `verifyTools` list | `… must be a non-empty array of tool names` |
| a written-content rail without `writeTools` | `… all read written files — name writeTools as well` |
| `requirePonytailUpgradePaths` with no `contentArgument` anywhere | `… at least one writeTools entry must name its contentArgument` |
| `readTools` not an array, or empty | `readTools must be an array of { tool, pathArgument } entries` / `readTools must not be empty — omit the key to disable the sensitive-read rail` |
| a read entry naming no path argument | `readTools entry "read" must name its pathArgument` |
| a repeated read tool, or an unknown entry key | `readTools names "read" twice` / `unknown readTools key(s) …` |
| `sensitivePaths` empty, blank, or repeated | `sensitivePaths must not be empty — omit the key to disable the sensitive-read rail`, `… entries must be non-empty path segments`, `… names ".env" twice` |
| `sensitivePaths` without `readTools` | `sensitivePaths reads file paths — name readTools as well` |
| `commandGuard` not an object, or an unknown key | `commandGuard must be an object { tools, deny }`, `unknown commandGuard key(s) …` |
| an empty `tools` or `deny` list | `commandGuard.tools must be a non-empty array of { tool, commandArgument } entries`, `commandGuard.deny must be a non-empty array of { pattern, reason } entries` |
| a command tool naming no argument | `commandGuard.tools entry "bash" must name its commandArgument` |
| a pattern naming no reason | `commandGuard.deny entry "…" must name a reason` |
| a pattern that does not compile | `commandGuard.deny pattern "(" is not a regular expression: …` |
| any other top-level key | `unknown config key(s) …` |

The `writeTools` and `readTools` rows are the bundle's cross-field rule: a rail that reads a file owns no tool knowledge of its own, so a deployment that turns one on without naming the tools has nothing to enforce against. It fails at load rather than loading a rail that can never fire.

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

### Routing contract

The first call to a tool that is not in `routingContract.readOnlyTools` is refused until a routing decision is on the record:

```
Error: the routing contract is not satisfied: `write` is the first non-readonly call of this session. Load the task's skill with the `skill` tool, or declare `Route: fast-path` with a one-line reason, then repeat this call.
```

Two decisions satisfy the contract, and both are recorded for the session rather than the call: a call to the `skill` tool, or an assistant message whose text contains `Route: fast-path`. The declaration is read from the committed `assistant/message` session event rather than from the streaming attempt, so a retried or discarded attempt cannot satisfy the contract.

`Route: fast-path` is a protocol constant rather than configuration. It is the phrase both sides of the Aegis method pack agree on, and a deployment that reworded it would be asking the model for a phrase the pack's own skills do not name.

A refusal costs one round trip, not a loop: the model answers with a decision, and answering is itself an allowed call. When the declaration arrives in the same response as the call it precedes, the gate is satisfied on the first attempt; when it arrives after the call, the model sees one refusal and repeats the call. A model that neither loads a skill nor declares a route meets the repeat rail instead.

The record is dropped at `compaction/end`, because the model's next request no longer carries the decision it once made. The record is keyed by session, so one session's decision does not license another's, and it is dropped when the agent is disposed.

### Write budget

The call that would make a new path the `maxWrittenFilesPerTurn + 1`th distinct file of the turn goes to approval:

```
this turn has already written 8 distinct files and `write` would make `src/late.ts` the 9th, beyond the 8 the deployment allows; approve only if the wider change is intended
```

The count is distinct **paths**, not writes, so a turn that edits one file repeatedly is not priced for the editing — breadth is what an unreviewed turn's diff cannot recover from. A path already in the set is free.

Only a call that completed without an error spends the budget. A refused or failed call reaches `tools/post-execute` too, and counting it would spend the budget on writes that never landed — a model that kept proposing new paths would exhaust the budget without writing anything.

The turn number and the written-path set live in one per-turn record, advanced from the loop's own `agent/pre-step` payload. Nothing counts turns here: the record is reset exactly when the loop opens a turn it has not seen, so retries, refused steps, resume, and fork stay correct by construction.

### Ponytail marker discipline

A write whose text contains a comment-prefixed `shortcut:` marker naming no upgrade path is refused:

```
Error: `src/lock.ts` writes a `shortcut:` marker with no upgrade path: "global lock". The convention is `shortcut: <ceiling>, <upgrade path>` (older code says `ponytail:`); name the limit and the trigger that would revisit it, or delete the marker.
```

The convention is a separator with something after it — `shortcut: global lock, per-account locks if throughput matters` is accepted, `shortcut: global lock` is not. Both the current `shortcut:` prefix and the older `ponytail:` prefix are read, and every marker line in the written text is read, not only the first.

Refusing the write is the only point where the fix is free: after the file lands, an untriggered marker is a debt entry nobody reads. Only comment-prefixed markers count, so prose that merely mentions the convention — this file's own JSDoc included — is not a marker.

### Dependency approval

A write whose file name is in `dependencyManifests` goes to approval, matched on the last path segment under either separator:

```
`write` changes the dependency manifest `package.json`; approve only if the new dependency is genuinely needed rather than already covered by the standard library, the platform, or a library this project already depends on
```

The ladder puts the standard library, the platform, and an already-installed dependency above a new one, and a manifest write is where that ordering is actually spent. Pricing the write puts the choice in front of a human at the only moment the alternative is still cheap.

### Verification gate

A turn that wrote files and ran no verification is interrupted at its stopping boundary:

```
This turn wrote src/lock.ts and ran no verification (`bash`, `pwsh`). Run the check that would fail if the change is wrong, then report what you ran, its result, what it covers, and what remains unverified — or say plainly why no check is available. Do not claim the work is complete until then.
```

The stop boundary has no veto — nothing in DeepSeek Harness can refuse the assistant's final text — so the rail uses the machine's own continuation path: steering at `agent/turn-stopping` makes the loop observe pending input and run another step. This is the mechanism `packages/hooks/hooks-claude-code` uses for a blocking `Stop` hook.

A completed call to any `verifyTools` tool is the evidence, and a **failing** check counts: the rail asks whether a check was run, not whether it passed, and a report of a failing check is exactly the outcome this gate exists to make possible.

The turn is interrupted at most once. A model that ignores the request stops at the next boundary rather than looping, so the worst case is one extra step.

### Unfinished-todo gate

A turn whose own todo list still holds `pending` or `in_progress` items is interrupted at its stopping boundary:

```
Your todo list still has 3 unfinished item(s): "T2 make Shortcuts.invoke return ShortcutResolution | undefined", "T3 command palette (store, component, locale, command)", "T4 region landmarks in workspace, conversation, sidebar-right". Continue with the next one, and rewrite the list when an item is no longer needed. Report the work as complete only when every item is completed or removed with its reason; if an item is blocked on a human decision, say which decision and why.
```

The list is the plan the model wrote for itself through `todo_write`, so a stop that leaves items open is the turn ending mid-plan — the shape a long implementation run produces when it reports progress instead of finishing. Nothing in DeepSeek Harness resists that stop: a turn ends when the model returns no tool call, and the only trace is the `turn/end` reason `completed`, which reads the same as an honest finish. This rail is the missing check, and the mechanism is the verification gate's: steering at `agent/turn-stopping` makes the loop observe pending input and run another step.

The snapshot is read from the session log, so a resumed, forked, or compacted session is judged by the list it actually has; a session that never wrote one is left alone. `unfinishedTodoContinuations` bounds the steers per turn — a model that keeps stopping with work left reaches the budget and the next boundary is left alone, so the worst case is that many extra steps rather than a loop.

### Sensitive-read denial

A read of a path carrying a configured segment is refused:

```
Error: `read` targets "/home/u/.ssh/id_rsa", which this deployment treats as credential material (matched ".ssh"); reading it would write the secret into the session log permanently. Ask the user for the specific value if it is needed.
```

A segment matches by equality or by a dotted extension of the configured name, ignoring case, under either separator: `.env` guards `.env` and `.env.local`, and leaves `environment.ts` alone.

The decision is `deny` rather than `ask`. A read lands in the session log, and no later approval removes it from there; the useful alternative — the user pastes the value — never needs the file's contents, so there is nothing for an approval to price.

The rail matches the path the call names, not the file it resolves to, so a symlink or a relative detour around a guarded directory is not covered.

### Command guard

A shell call whose text matches a configured pattern goes to approval:

```
`bash` would run a command this deployment guards (matched `git\s+push\b[^\n]*(--force\b|\s-f\b)`): rewrites a remote branch history others may already have; approve only if the command is intended
```

Each `pattern` compiles at load and is matched case-insensitively against the raw command text, so `bash -c "git push --force"` is still caught. The decision is `ask` rather than `deny`: deleting a build directory or force-pushing a personal branch is sometimes exactly the intended action, and only a human can tell that from the accident. With no approval channel the fail-closed approval ladder refuses the call, which is the intended unattended outcome.

## `/guardrails`

The bundle registers one command that reports which rails the deployment actually has armed, the mode it is running in, and what its `observe` runs have seen:

```
Guardrails: OBSERVE MODE — 12 of 12 rails armed, nothing is refused (config 3f2a9c1b).
plan-mode denial: write, edit, str_replace_editor
repeat approval: after 5 identical calls
...
command guard: 2 tool(s), 3 pattern(s)
decisions this session: 2 (2 observed)
  observed  command guard  git push --force origin main
  observed  sensitive reads  .env.local
```

It reads the resolved configuration, so the report cannot disagree with the rails. `config` is a hash of the configuration the rails are deciding under, so a refusal in a log can be tied to the settings that produced it. Only `observed` rows are listed, at most the newest ten: an enforced `deny` is text the model read, and an enforced `ask` is a decision the approver made, so the rows worth a human's attention are the calls a rail would have stopped and did not. A deployment with no `commands` service keeps every rail and loses only the report.

The ledger behind those rows is per session and in memory, capped at 200 decisions: it answers "what did the rails do in this session", not "what happened last week".

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
        maxStepsPerTurn: 200
        unfinishedTodoContinuations: 3
        skillInvocationGuidance: true
        writeTools:
          - { tool: write, pathArgument: file_path, contentArgument: content }
          - { tool: edit, pathArgument: file_path, contentArgument: new_string }
        maxWrittenFilesPerTurn: 8
        requirePonytailUpgradePaths: true
        dependencyManifests: [package.json]
        routingContract:
          readOnlyTools: [read, read_image, glob, grep]
        verificationGate:
          verifyTools: [bash, pwsh]
        readTools:
          - { tool: read, pathArgument: file_path }
          - { tool: read_image, pathArgument: file_path }
          - { tool: grep, pathArgument: path }
        sensitivePaths: [.env, .ssh, .aws, .gnupg, .npmrc, id_rsa, id_ed25519]
        commandGuard:
          tools:
            - { tool: bash, commandArgument: command }
            - { tool: pwsh, commandArgument: command }
          deny:
            - pattern: 'git\s+push\b[^\n]*(--force\b|\s-f\b)'
              reason: rewrites a remote branch history others may already have
```

`tests/fixtures/cli-boot.patch.yml` is an overlay of that shape, and it drives the plan-mode rail through the product's own one-shot path:

```sh
node --import tsx/esm apps/cli/src/bin.ts --profile headless \
  --patch plugins/prism-guardrails/tests/fixtures/cli-boot.patch.yml --json "probe the rails"
```

```json
{"type":"tool_result","callId":"cap-1","status":"error","result":"Error: plan mode is active: `write` is not executed until the plan is approved; present the plan with exit_plan_mode or leave with /plan off"}
{"type":"final","text":"planning complete"}
```

## Build and verify

The bundle borrows the checkout's packages instead of declaring workspace dependencies. Every `@deepseek-ai/*` import in `src/` is `import type` except the two the rails need as values — `createUserMessage`, which the verification and todo gates use to steer the agent, and `CommandDefinitionId`, which every command registration needs — so the emitted module carries only those two external imports, resolved from the profile that loads the bundle, and a deployment installs nothing of its own. Its other import is `node:crypto`, a builtin, for the configuration version's digest. `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-commands` are the peer dependencies that resolve them; `@deepseek-ai/dsh-system-prompt`, declared beside them, is the service the Ponytail row injects rather than imports.

`tsconfig.json` resolves those types through the checkout's **built** declarations, which is how the repository's own packages consume each other — run `pnpm run build` in the checkout first. `tsdown.config.ts` keeps `@deepseek-ai/*` external, as the sibling `plugins/prism-memory` does: a bundled copy would shadow the profile's own service instances across the cross-instance identity the harness relies on.

```sh
npm run typecheck   # tsc against the checkout's built declarations: exit 0
npm run build       # lib/index.js with two external harness imports
npm run smoke       # artifact: imports, exports, fail-loud config
npm test            # 144 composed unit tests
npm run test:e2e    # 4 end-to-end capability runs against the shipped headless profile
```

`vitest.config.ts` reuses the checkout's `tsconfig.base.json` paths facade and decorator pre-transform, so `tests/prism-guardrails.spec.ts` composes the **real** services — the production tool pipeline, the production agent loop against a scripted mock adapter, the real plan-mode controller, the real skill registry, and the loop's own stopping boundary — rather than a hand-built stand-in for the extension points. Assertions are on model-visible tool results, executed effects, and request counts.

`tests/capability.e2e.spec.ts` goes further: it boots the shipped **headless** profile through the real Loader with the bundle loaded from its built artifact by relative path, scripts the model through a mock adapter, and asserts four rails' enforcement in the resulting session events — the plan-mode denial text, two refused repeated calls after two permitted ones, a turn ending `blocked` at the step budget, and the user-only skill's guidance. That run is why the overlay fixtures disable the session-title provider: it issues its own model call through the same route. It is also what proves the built artifact's external imports resolve in a real profile.

`scripts/smoke.mjs` asserts on the built file's text rather than executing it, because the artifact imports the profile's harness package, which a checkout without a profile install cannot resolve. Rail registration is the Vitest suite's job.

Vitest needs vite's Windows real-path probe to spawn a child process, which a confined file sandbox denies; run it outside that confinement.

## Known Limitations and Deferred Work

- **`observe` turns the refusals off, not the rails.** A `deny`, an `ask`, and the turn-budget reject become records; the two `steer` rails still send a turn back for its evidence or its unfinished items. A deployment that is observed is not protected against the calls those refusals would have stopped, and one that mistakes this state for protection is worse off than with no rails at all. `/guardrails` therefore leads with the mode, and the key ships in no profile: a deployment that wants it writes it deliberately.
- **The decision ledger is memory-only.** It is per session, capped at 200 rows, and lost when the process exits, so it answers what the rails did in this session and nothing about last week. It is a tuning aid, not an audit log.
- **The configuration version covers the rail configuration only.** It names the settings in the patch row, not the rest of a profile's plugins, so it identifies the configuration behind a refusal rather than the deployment as a whole.
- **The bundle is outside the repository test runner.** It lives in `plugins/`, which the checkout's `vitest.config.ts` does not collect, so it carries its own config and does not run under `pnpm run test` or the per-file coverage gate. Its evidence is the suites above, not CI.
- **Written paths compare as the call wrote them.** `a.ts` and `./a.ts` are two paths and spend two files of the write budget. Canonicalizing them needs the filesystem resolved against the call's working directory, which would give this rail a provider dependency it does not otherwise have. The verification gate's message reports the same strings.
- **`writeTools` names one content argument per tool.** A tool whose written text lives in a different argument per command — `str_replace_editor`'s `file_text` for `create` against `new_str` for `str_replace` — is not covered by the marker rail, and the shipped patch leaves it out of `writeTools` for that reason. Covering it needs a per-command argument map, which no current consumer has asked for.
- **The routing record latches for the session.** A session that declares `Route: fast-path` once is never asked again until `compaction/end`. Detecting a per-task lapse in the declaration's meaning is a larger capability than a gate can infer from one message.
- **The verification gate asks, it cannot require.** The stop boundary has no veto, so a model that ignores the steering and stops anyway ends the turn. The rail's enforcement is one extra step and a stated request, not a refusal; only the tool pipeline can refuse, and it has no say over the final text.
- **The verification gate does not read the evidence it asks for.** It checks that a `verifyTools` call completed, not that the claim the model then makes matches that result.
- **The unfinished-todo gate reads a list the model writes.** A model that marks every item `completed` before it stops ends the turn, so the gate buys attention to the plan, not proof the plan was executed. The list also persists across turns, so a stale entry left by an earlier turn steers a later one until the model closes or rewrites it. And the gate cannot tell a model that stopped to ask a question from one that stopped early: the bounded steer is the only pressure, and the reply it asks for — name the blocked item and the decision — is the model's own text.
- **`skillNameArgument`'s non-object guard is unreachable through the shipped tool set.** The registry validates a call against the tool's compiled object schema before the pre-execute waterfall, so a non-object argument list is rejected first — the test suite pins that rejection. The two lines are kept so the function stays total at a model tool-JSON boundary rather than throwing inside a listener, which would fail every call to the tool.
- **The repeat rail has no `include`/`exclude` patterns.** `@deepseek-ai/dsh-repeat-tool-reminder` offers wildcard tool selection and this rail does not; a deployment that needs it must say so with a concrete consumer.
- **Reasoning-streak loop governance is not implemented.** This bundle detects repetition by tool name plus arguments only. Detecting a repeated *thinking* prefix and pruning the polluted span from the request view while the log keeps the full trajectory is a separate, larger capability.
- **The shipped defaults are a deployment policy, not a recommendation.** `planDeniedTools` and `repeatAskAfter: 5` come from the fork's `CAPABILITY-PLAN.md`. `maxStepsPerTurn: 200` is a runaway backstop rather than a working limit: the plan's `20` truncated 11 of the 20 turns recorded in the fork's own deployment, each after about a minute of work, and no recorded turn ever finished naturally at that ceiling. `maxWrittenFilesPerTurn: 8` and the routing contract's read-only list are this bundle's own first pass over DeepSeek Harness's tool set; a deployment that disagrees edits the row. `unfinishedTodoContinuations: 3` is sized the same way: enough to carry a turn through the progress-report stop that produced it, small enough that a model which never finishes still ends the turn. `sensitivePaths` and the three `commandGuard` patterns are that same first pass: a short credential list and the three commands whose damage cannot be undone afterwards.
- **The command guard reads raw text.** A pattern sees the command string, so `bash -c "git push --force"` is still caught, but quoting and variable tricks evade it, and a denial is only as good as the patterns a deployment writes. Wrapper-proof matching needs a shell parser, which no current consumer has asked for.
- **A guarded command is priced, not judged.** `ask` means a legitimate `rm -rf` of a build directory costs one approval each time; a deployment that finds that too expensive narrows its own patterns.
- **Segment matching over-reaches at the edges.** `id_rsa` guards `id_rsa.pub` too, and a path is matched as the call wrote it, so a symlink or a relative detour around a guarded directory is not covered.
- **No Chinese README pair is required for `plugins/`.** The repository's translation-pairing gate already reports the sibling `plugins/prism-progress/` for a missing pair; this bundle ships the pair so it adds no failure of its own.
