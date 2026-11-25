---
feature: prism-team
status: delivered
updated: 2026-11-25
branch: feat/prism-team
commits: 50ff54bd96..c4bd1a25a3
---

# Prism Team

English | [中文](prism-team.zh.md)

## Report

**What was built** — `plugins/prism-team`, a Host-only out-of-tree plugin that adds four capabilities to Agent Teams without touching `packages/**`: the `team_report` tool turns a teammate's progress into one structured message in the Lead's inbox and records it in the plugin's ledger; `/team` orders `blocked/failed/ready/waiting` before `progress` and takes one line when the team is healthy; each continuable teammate gets its own `git worktree` and branch `team/<team>/<name>` at creation, with the path written into its prompt section; a write gate on `tools/pre-execute` judges writes against the `writeScopes` of the task the member claimed — out-of-scope writes default to `ask`, or are only recorded under `observe`. Membership is read from the enabled subagent tree (`isEnabled` + `rootOf`), so a session outside a team gets zero behavior.

**Verification** — plugin `tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.client.json --noEmit` exit 0; `vitest run --config vitest.config.ts` 19/19 pass, including worktree cases that assert two teammates get distinct paths and branches in a temporary git repository, the Lead gets none, and `git worktree list` admits both; `tsdown` builds `lib/index.js` 27 kB and `lib/client.js` 14 kB; repository `pnpm run typecheck` passes 5/5 programs. The 14 pre-existing `ponytail.spec.ts` failures are unchanged from master (the same file and plugin code fail there).

**Journey log** —

- Compose was first written inside the team plugin; verification showed that "skill becomes a plugin capability" is general, not team-specific, so it moved to `prism-guardrails/src/compose.ts`. Otherwise the same thing would have two homes, and solo sessions would not get it.
- The first test draft pointed the fake Agents' `ctx` at the root context; two members registering same-name sections/tools collided immediately. Scopes minted by `createScope` plus real `Session`s fixed it and made `/team`'s log writes possible.
- The worktree can only be advice: a session's cwd is fixed at creation and the team packages offer no per-member directory, so members must use absolute paths. That is stated in the README rather than hidden.
- A pre-delivery self-review caught S2.4 fighting S2.5: a member writing `src/a.ts` inside its own worktree is `.worktrees/team-x/src/a.ts` relative to the root, which never matches a task declaring `src` — every write would need approval. `withinScopes` now strips the `.worktrees/<checkout>/` prefix before comparing, with a test.
- An independent review caught two authorization holes, both fixed: the gate did not check task ownership (another member's claimed scope would authorize this write), and `str_replace_editor`'s path argument is `path`, not `file_path` — that tool was never checked. `writeTools` is now a `{ tool, pathArgument }` list, and only tasks the caller itself claimed authorize a write.
- The panel moved from a `conversation.view` tab to the session-header action row (S2.9): the wanted entry is beside the "N subagents / N background jobs" chips, not another tab.
- 2026-11-25 resync port: upstream rebuilt teams as "the subagent tree is the team" — `agent-team`/`tool-agent-team` moved to `packages/team/`, and `tryMembership`/`sendMessage`/`listMembers` are gone. The plugin now reads membership from `isEnabled` + `rootOf`, reports through `subagents.sendMessage`, rosters through `listDescendants`, compares task ownership by `ownerId`, and registers tools globally with `when` conditions instead of per-member installs; worktrees go only to continuable members.

## [S1] Problem

Agent Teams gave the Lead named teammates, point-to-point messages, and a persistent task board, but the four limitations it states itself are exactly what the dsh-superagent-prototype already solved elsewhere:

| The team package's own limitation | The prototype's corresponding practice |
|---|---|
| One process, one shared checkout, no worktrees, no file locks | One execution directory per Ticket; `prepare` is usually `git worktree` (`docs/003-execution.md:25,53`) |
| `writeScopes` are advisory hints that Bash and external writers bypass | Authorization strength `explicit \| inferred` decides whether work may start (`docs/002-authorization.md`) |
| Teammate progress is only pollable via `wait_agent` and free text | Structured Reports (`progress/waiting/ready/blocked/failed/dropped`), panels list only what needs a person (`docs/003-execution.md:9-21`) |
| No convergent view of what waits on a person | Attention economics: healthy states take no space (`docs/000-philosophy.md:21`) |

Meanwhile the long-task behavior band (ponytail already applies per agent; compose-next was only a skill with no plugin trigger) did not extend to teams: teammates lacked the Lead's convergence constraints.

The goal is to put these four capabilities into **one out-of-tree plugin** without touching `packages/**` — per A5 of `docs/compose/spec/fork-upstream-divergence.md`, capabilities outside the repository live in `plugins/**`, so every upstream resync skips replaying them.

## [S2] Design

### S2.1 Home and loading

`plugins/prism-team`: a single-entry Host plugin (`name = 'prism-team'`, with a `cordis.patch.yml` row and `dsh.bundle.patch`), structurally like `prism-guardrails`. It reads membership as **a subagent tree with Team mode enabled**: `ctx.agentTeams.isEnabled(agent)` plus `ctx.subagents.rootOf(agent)` — the root Agent is the Lead and every continuable descendant is a teammate. Tools and the section register once globally, made conditionally visible by `when` and per-agent section text, instead of per-member installs; member names and worktrees are prepared on `agent/created`. The task board and the other team tools come from upstream `packages/team/agent-team` and `tool-agent-team`; this plugin does not change them.

Sessions outside a team (ordinary sessions, independently resumed subagents, trees without Team enabled) get no behavior: `isEnabled` false or `rootOf` throwing `SubagentError` (no live root) skips them.

### S2.2 Structured reporting

A new tool `team_report`, available to every member:

```ts
type TeamReport = {
  status: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
  summary: string
  taskId?: string
}
```

Execution is two steps: first `ctx.subagents.sendMessage(caller, root.session.id, content, { signal })` — an ordinary tree message whose receiver is the Lead's inbox — with the body `Report from <name> [<status>]: <summary>` plus the optional taskId; then the same row is recorded in the plugin's ledger. The return value is a receipt (status, delivered, ledger count) and never fabricates model-side handling.

When the Lead calls it, **no message is sent** — the team service refuses self-messages and the Lead's report has no receiver; it only enters the ledger, and the receipt says so. The tool schema is identical for Lead and teammate; execution branches on the member's role, matching the team packages' own convention (all nine `tool-agent-team` schemas are shared; authority lives in the service).

The ledger is a `Map<TeamId, Report[]>` owned by the plugin instance, ring-bounded by `maxReports` (default 200). It is **not an audit log** and dies on restart; the durable copy is the message in the Lead's inbox (model-visible, already in the session log). An out-of-tree plugin cannot write Session events — `scripts/verify-plugin-record-callers.ts` only admits `packages/experimental/`, the owner, tests, and the gate itself — so state can only live in "the tool call" and "memory", which the README's limitations state.

### S2.3 The needs-a-person list

The `/team` command, callable by any member:

```
Team: 3 members, 2 open tasks (1 needs a person).

needs a person:
  blocked   reviewer   cannot reproduce on windows, missing repro steps   task-4
  waiting   tester     which branch should I target?                     task-5

working:
  progress  writer     rewrote the parser, running the suite

tasks: task-4 in_progress (reviewer) · task-5 pending · task-6 completed
```

The ordering comes from the superagent panel: `blocked`/`failed` → `ready` → `waiting` are "needs a person"; `progress` and members without an in-flight report are "working"; **a healthy team takes one line** (`Team: 2 members, no open reports.`) and nothing more.

Roster data comes from `ctx.subagents.listDescendants(root)` (continuable child rows only, Lead always first) + `listTasks` + the ledger; no new durable surface.

### S2.4 A worktree per member

When a continuable teammate is created and `worktree: true` and the Lead's cwd is inside a git repository, the plugin runs this once for that member; one-shot subagents are ordinary delegation, not teammates, and get none:

```
git worktree add <root>/.worktrees/team-<teamShort>-<name> -b team/<teamShort>/<name>
```

`<root>` is the team root's session cwd and `<teamShort>` the first 8 characters of the `TeamId`. The absolute path goes into the member's system-prompt section and appears at the end of the member's roster line in `/team`, visible to Lead and member alike. `.worktrees/` is already ignored (`.worktrees/.gitignore` contains `*`), so the working tree stays clean.

Three failure paths never break the member:

- Not a git repository → no worktree; the member's section says the team has no directory isolation.
- `git worktree add` fails (branch name taken, path occupied) → a warning line with the stderr summary in the same section.
- The member is the Lead → never created (the Lead keeps the shared checkout).

**No automatic removal**: an unreviewed worktree may be the member's only result; deleting it loses data. `/team` prints the paths and cleanup is a manual `git worktree remove`, stated in the README.

**Known limitation, stated plainly**: the plugin's `map`/`write` tools resolve relative paths against the session cwd, and the bundle cannot switch a member's cwd to its worktree. Members must work with **absolute paths** inside the worktree; the shared checkout stays writable, so isolation remains advisory. The difference from before is one thing, but a real one: each member owns a dedicated, committable, `git diff`-able directory for the first time. The README lists it beside the team's "Advisory write scopes".

### S2.5 The write-authorization gate

One rail on `tools/pre-execute`, effective only for teammates (the Lead and ordinary sessions pass straight through with `next()`). For write tools (`write`, `edit`, `str_replace_editor`) it takes the target path:

- It resolves the `writeScopes` of the tasks the member **has claimed** (`listTasks` with `status === 'in_progress'` and `ownerId` equal to the caller), normalizes the path to a workspace-relative prefix, and compares.
- A hit passes — that is `explicit` strength: someone drew this boundary for the member.
- A miss, or no claimed task at all → `inferred`. Under `mode: enforce` the rail returns `{ kind: 'ask', reason }`; under `mode: observe` it records the write and lets it through.

`ask` is the superagent Attention: one decision a person makes with a click, landing straight in S2.3's list.

Strength and mode are **asymmetric** here, as recorded in `GUARDRAILS-SUPERAGENT-PLAN.md:35`: the prototype's `observe` only downgrades "work nobody named", while this rail treats every out-of-scope write the same, so ported over, `observe` means "record every out-of-scope write". The README states that observe is a way to switch the guard off.

This is the plugin's real increment: the team package defines `writeScopes` as advisory; this plugin makes them enforceable — but only on a teammate's write tools, and the default out-of-scope action is **ask**, not refuse. A refused write tool deadlocks a member; asking hands the decision back to a person.

### S2.6 Mode routing is not this plugin's job

**Ponytail needs no new code.** `prism-guardrails`' section resolves the level by `context.agent`, and the automatic rule is "coding preset or cumulative steps ≥ `autoLongTaskSteps`"; a teammate is an Agent and naturally gets the same section and the same `agent/pre-step` counting. Acceptance verifies it once.

**Compose-next belongs to `prism-guardrails`.** "Turning a skill into a plugin capability" is general, not team-specific: `ponytail` already lives in `prism-guardrails`, and the bundle mounts into every profile. Another "mode plugin" would give the same thing two homes, so the compose mode is `prism-guardrails/src/compose.ts`, structured like `ponytail.ts` — see [compose-next-mode.md](compose-next-mode.md). This plugin does not touch mode routing; members get it from the profile row.

### S2.7 Configuration

```yaml
- id: prism-team
  name: prism-team
  config:
    mode: enforce                       # enforce | observe
    worktree: true                      # one worktree per continuable teammate
    writeTools: [write, edit, str_replace_editor]
    maxReports: 200                     # ledger ring bound
```

All four keys are validated at load; an illegal value throws immediately and names the key (in the error style of `prism-guardrails/src/config.ts`). Member roles, team identity, and cwd are not configuration — they are read at runtime.

### S2.8 Failure behavior

| Situation | Behavior |
|---|---|
| Not a team member | The Agent gets no registration at all; zero behavior |
| Team service missing | The plugin does not load (`inject` declares `agentTeams`) |
| `sendMessage` refused | The tool returns an error; the ledger is not written — delivery is never faked |
| Not a git repository | No worktree; the member's section explains, and the member works on |
| `git worktree add` fails | One warning line with stderr in the section; the member works on |
| Ledger full | The oldest entry is dropped; `/team` shows the true count |
| `mode: observe` | Out-of-scope writes pass and are recorded; `/team` lists an `observed` group |

### S2.9 Browser panel: the session-header entry

The panel is not a `conversation.view` tab but an entry in the **session-header action row** (`conversation.session.header.actions`, order 15, between the subagent catalog at 10 and background jobs at 20) — the user wanted the entry beside those two chips when team mode is on.

- The client half (`src/client/`) registers one header action with the chip label "团队 / Team", localized through `ctx.locale` (the `prism-team` namespace, declared in `LocaleNamespaceMap`).
- The chip is always present; the panel requests data **on first open**, so an ordinary session costs nothing.
- Panel content: members, open tasks, and every report, with `blocked/failed` → `ready` → `waiting` first; `observed` rows form their own group.
- Data flows through one Host read-only route `POST /api/prism-team/panel`, registered on Connection's shared `/api` channel. The route resolves the team of the requested session (a teammate's session resolves to its Lead), so the browser never needs the roster.
- The route is optional: the service is read with `ctx.get('connection')`, so a profile without a web server keeps every other behavior.
- Read-only: claiming, completing, or reassigning needs a live Agent and Lead authority, so it stays in the model's tools.

Cost and limitation: the client half ships as `lib/client.js` (CJS + the `window.__ModuleLoader__.load` wrapper, mirroring `prism-memory`'s tsdown dual build) and externalizes only `react`, `react/jsx-runtime`, and `@deepseek-ai/cordis`; the panel's actual rendering in the browser was not verified on this machine (the GUI runs in another checkout).

## [S3] Scope

- In scope: the `plugins/prism-team` package (entry, tools, two commands, the rail, worktree preparation, the ledger, config validation), unit tests (including the real Cordis composition), the README and its limitations, and `cordis.patch.yml`.
- Out of scope: the web panel UI; GitHub / Feishu source ingestion; Mandate and policy-version revalidation; automatic merging; `cwd` switching; changes to `packages/**`; mounting the plugin into a running profile (offered as a separate final step).

## Tasks

- [x] T1: Scaffolding (manifest, tsconfig, tsdown, vitest, cordis.patch.yml, README skeleton) (depends: none)
- [x] T2: Config validation and the ledger (`Config`, `resolveConfig`, the ring `Map<TeamId, Report[]>`) (depends: T1) covers: S2.7
- [x] T3: `agent/created` loading and scoped unloading (depends: T2) covers: S2.1
- [x] T4: The `team_report` tool and the `/team` list (depends: T3) covers: S2.2, S2.3
- [x] T5: Worktree preparation and section injection (depends: T3) covers: S2.4
- [x] T6: The write gate (enforce/observe) (depends: T3) covers: S2.5
- [x] T7: README (limitations, the safety consequence of observe, the worktree is advice) and test wrap-up (depends: T4, T5, T6)

## [S4] Acceptance

- [x] A1 On a non-member Agent, the plugin registers no tool, command, or section (asserts zero registrations).
- [x] A2 After a teammate calls `team_report`, the Lead receives one message shaped like `Report from <name> [blocked]: …`, the ledger grows by one, and the receipt's status matches the input.
- [x] A3 The Lead calling `team_report` produces no self-message and only enters the ledger.
- [x] A4 With one `blocked` report, `/team` places the `needs a person` group before `working`; a fully healthy team takes one line.
- [x] A5 Two teammates of one team get distinct worktree paths and branches under `.worktrees/`, both admitted by `git worktree list`.
- [x] A6 Creating a teammate in a non-git repository still succeeds, and `/team` or the section says there is no isolation.
- [x] A7 Under `mode: enforce`, a teammate writing outside every claimed task gets `ask`; writing inside the `writeScopes` of its own claimed task passes directly.
- [x] A8 Under `mode: observe`, the same out-of-scope write passes and `/team` shows an `observed` row.
- [x] A9 Illegal configuration (`mode: 'on'`, `maxReports: -1`) throws at load with the key named in the message.
- [x] A10 `tsc -p tsconfig.json --noEmit` and `vitest run` pass.
- [x] A11 Mode routing (ponytail / compose-next) works in a teammate session — covered by [compose-next-mode.md](compose-next-mode.md)'s acceptance; this spec only confirms members are Agents holding the same section.
