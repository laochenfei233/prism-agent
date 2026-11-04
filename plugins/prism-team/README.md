# prism-team

Prism Team adds four capabilities the experimental Agent Teams packages leave open, without changing them:

| Capability | What changes |
|---|---|
| Structured reports | `team_report` turns a teammate's progress into one status the Lead receives as a single message |
| A needs-a-person list | `/team` lists blocked, failed, ready, and waiting members before working ones; a healthy team takes one line |
| A worktree per teammate | each teammate gets its own `git worktree` and branch, so two members stop editing one checkout |
| An enforced write scope | a teammate's write outside the scope of the task it claimed goes to approval instead of proceeding |

It is an out-of-tree bundle: it registers on documented extension points and never edits `packages/**`, so an upstream resync does not have to replay it.

## Requirements

The bundle needs the experimental Agent Teams packages mounted beside it — `dsh-experimental-agent-team` with `dsh-experimental-tool-agent-team`, or the `dsh-experimental-agent-team-profile` bundle that carries both. Without them the row fails to load, which is the intended loud failure: there is no team to add to.

A session that is not on a team receives no tool, no section, and no write check.

## Install

Add the bundle to a profile, then enable Agent Teams. For a checkout that has not installed the package, point the row at the built entry instead of the package name:

```yaml
- insert:
    - id: prism-team
      name: 'file:///absolute/path/to/plugins/prism-team/lib/index.js'
      config:
        mode: enforce
        worktree: true
```

## Configuration

Every key is optional and validated at load; an unusable value fails plugin load rather than silently disabling a part.

| Field | Default | Meaning |
|---|---|---|
| `mode` | `enforce` | `enforce` asks before an out-of-scope write; `observe` records it and lets it through |
| `worktree` | `true` | Create one `git worktree` and branch per teammate |
| `writeTools` | `write`, `edit`, `str_replace_editor` | Tool names whose `file_path` argument the scope check judges |
| `maxReports` | `200` | Reports kept per team in the in-memory ledger |

## What a member gets

`team_report` takes `status` (`progress`, `waiting`, `ready`, `blocked`, `failed`, `dropped`), `summary`, and an optional `task_id`. A teammate's report is sent to the Lead as `Report from <name> [<status>]: <summary>`; the Lead receives it in its normal inbox and the ledger records the same row. The Lead calling the tool records the row without messaging itself.

The member prompt section states the report protocol, the claim-before-write rule, and — for a teammate with a worktree — the absolute path and branch to work in.

## The write scope

A teammate that writes through a configured write tool is checked against the `writeScopes` of the shared task it claimed:

- The path is inside a claimed task's scope: the write proceeds. That is the explicit case.
- The path is outside every claimed task, or no task is claimed: under `enforce` the call goes to approval with a reason that names the scope; under `observe` it proceeds and the ledger records an `observed` row.

`/team` prints those rows below the reports, which is what makes `observe` a usable trial before arming the check.

The task board calls write scopes advisory, and they stay advisory for everything the bundle does not intercept: bash, formatters, code generators, and any direct external writer bypass this check. The check closes the write-tool path only.

## The worktree

On a teammate's creation the bundle prepares `<Lead cwd>/.worktrees/team-<team>-<name>` on branch `team/<team>/<name>` and writes `*` into `.worktrees/.gitignore` when the checkout does not ignore that directory yet. Failure to prepare is reported in the member's section and never blocks the member — the Team service has already created it.

Nothing removes a worktree automatically: an unreviewed checkout may be the member's only result. `/team` and the member section carry the path; removal is `git worktree remove <path>` by hand.

## Known limitations

- **The worktree is advice, not confinement.** A session's working directory is fixed at creation, and the Team packages offer no per-member directory. A teammate must address files with absolute paths inside its worktree; the shared checkout stays writable. What the worktree changes is real but narrow: each member finally has its own checkout it can commit and `git diff` in.
- **The ledger is in memory.** It answers "what does the team look like right now" and disappears on restart. An out-of-tree plugin cannot write Session events, so the durable copy of a report is the message in the Lead's inbox.
- **`observe` is a way to close the guard.** A deployment that thinks it is protected while it runs `observe` is worse off than one that never mounted the check. `/team` prints the observed rows, and the first line of the member section states the mode.
- **`/team` reads what the team service exposes.** It lists roster, tasks, and this bundle's ledger; it does not summarize a teammate's own conversation.
- **No Web panel.** Reports and tasks are read through `/team`; the Agent Teams roster and task board keep their own Web projection.

## Tests

```sh
npm test    # vitest run --config vitest.config.ts
```

The suite drives the real tools, system-prompt, session, and command registries against a stubbed Team service, so it exercises this bundle's own decisions rather than the team domain.
