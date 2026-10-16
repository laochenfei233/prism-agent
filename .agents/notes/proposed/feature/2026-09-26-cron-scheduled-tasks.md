# Agent Note: Cron scheduled tasks over a process-level scheduler

Status: proposed

English | [中文](2026-09-26-cron-scheduled-tasks.zh.md)

## Problem

The harness can start work only inside a conversation that is already live. [`@deepseek-ai/dsh-schedule`](../../../../packages/schedule/schedule/README.md) owns session-local reminders whose rule union is `after`, `at`, and fixed-rate `every` with a 300-second floor; its protocol has no calendar or Cron expression, and a cold Session performs no work and sends no external notification until it is live again (durable Web schedule). The harness-level loop decision deliberately left time-based execution unbuilt and recorded that it "belongs with a scheduler rather than either goal family".

Nothing shipped therefore answers "every weekday at 09:00, run this task": unattended, calendar-based, with an explicit time zone, and without a human opening a conversation first. An operator who wants that today keeps a Session open and uses an interval reminder, which changes the rule shape, requires the conversation to stay live, and leaves no record of whether a run happened.

The parts exist but are unjoined. Durable non-session state is owned by `ctx.storageDomain`; cross-process exclusion is implemented by the kernel-lock lease inside `session-persistence-jsonl`; cold-session activation is `ctx.agents.create` / `ctx.agents.resume`; model-facing surfaces are `ctx.tools` and the `packages/api/*-controller` Remote shape. Joining them for time-based triggering is a scheduler decision, not an extension of the reminder protocol, because a reminder's durable record is its Session's conversation state while a Cron job's durable record belongs to no Session at all.

## Proposal

Add a `packages/cron/` product-role family plus two shared primitives. Cron owns the **timing, authority, and durability of a scheduled trigger**. It owns no iteration policy: a fired job delivers one authored message that starts ordinary work, and the goal, Ralph, subagent, and workflow policies that follow are untouched.

### Plugin topology and owning verbs

| Package | Role | Owned structures and verbs |
|---|---|---|
| `@deepseek-ai/dsh-cron` | Host capability, `packages/cron/cron/` | The `ctx.cron` Service Definition, the pure expression and calendar domain, the `cron` storage domain, the leader lease, the segmented timer runtime, and cold-session activation. Owns `CronJobId`, `CronJob`, `CronRunRecord`, the closed `CronError` union, and `list`, `create`, `update`, `delete`, `runNow`, and `follow`. |
| `@deepseek-ai/dsh-tool-cron` | Model-facing consumer, `packages/cron/tool-cron/` | Registers `cron_create`, `cron_list`, `cron_update`, `cron_delete`, and `cron_run`. |
| `@deepseek-ai/dsh-api-cron-controller` | Remote controller, `packages/api/cron-controller/` | Owns Host `ctx.cronController` and the generated Client `ctx.remote.cron` namespace: a baseline-plus-increment subscription and the mutation and `runNow` unaries, following the [`workspace-controller`](../../../../packages/api/workspace-controller/README.md) shape. |
| `@deepseek-ai/dsh-client-ui-cron` | Web consumer, `packages/client/ui-cron/` | The scheduled-task panel: rows with expression, zone, next occurrence, and enabled state; create, edit, delete, run-now, and recent results. |
| `@deepseek-ai/dsh-util-path-lock` | Shared primitive, `packages/util/path-lock/` | A cross-process exclusive path lock: a POSIX kernel lock via the native flock entry and a Win32 named kernel semaphore, released by the kernel when the holder's process ends. |
| `@deepseek-ai/dsh-util-time` | Shared primitive, `packages/util/time/` | Gains the exported calendar-time resolution that maps a local calendar time in an IANA zone to an instant, with the repository's gap and overlap policy. |

`ctx.cron` stays one package with its shipped provider rather than splitting a `cron-local` provider now. A provider seam is justified by a second provider; none exists, and [`packages/util/README.md`](../../../../packages/util/README.md) requires each abstraction to have a current consumer. The seam becomes a split when a second store backend needs its own package.

Two existing release packages change, because each behavior gains its second consumer and `packages/util/` exists precisely to give capability packages shared mechanical primitives instead of duplicate implementations:

- `session-persistence-jsonl` currently owns the only kernel-lock implementation. Its lock and Win32 helper move to `dsh-util-path-lock`, and the session write lease consumes that package.
- `dsh-schedule` currently owns the only local-calendar resolution. `resolveLocalInstant` and `localProjection` move to `dsh-util-time` as exports, and the Schedule domain consumes them.

The composition ships as an example overlay, `apps/cli/config/examples/cron/cordis.yml`, mirroring the [Schedule overlay](../../../../apps/cli/config/examples/cron/cordis.yml): `insert` rows for the three Host packages, and `disabled: false` on a `ui-cron` row that the Web bundle ships disabled.

### Cron expressions and calendar semantics

A job carries a five-field expression (`minute`, `hour`, `day-of-month`, `month`, `day-of-week`) supporting `*`, `a-b`, `*/n`, `a-b/n`, comma lists, and three-letter names, plus the `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, and `@yearly` macros. There is no seconds field, no Quartz `?`, `L`, `W`, or `#`, and therefore a one-minute floor.

When both day-of-month and day-of-week are restricted, the union of the two matches fires, which is the POSIX crontab rule; an implementation that intersects them silently drops the runs an operator expects.

Every job declares an IANA zone and the plugin never reads the browser zone, the process zone, a Session header, or model time-context. This keeps the [explicit Schedule time-zone boundary](../../implemented/simplification/2026-08-09-explicit-schedule-time-zone.md) consistent across both time features and keeps replay independent of ambient state. A local time that does not exist (the spring gap) is skipped, and a repeated local time (the autumn overlap) runs once at the earlier instant, matching the policy `dsh-schedule` already ships for its `at` rule so the harness has one DST semantics rather than two.

`nextOccurrence(parsed, timeZone, afterEpoch)` is pure and reads no ambient clock. Production samples the wall clock; tests supply explicit samples.

### Durable store and single-instance ownership

One `cron` storage domain holds jobs and their bounded run history:

```
CronJob = { id, expression, timeZone, enabled,
            target: { kind: 'new-session', workspacePath, agentPreset, permissionPreset, model? }
                  | { kind: 'session', sessionId },
            prompt, overlapPolicy: 'skip' | 'queue-one', misfirePolicy: 'skip' | 'run-once-late',
            maxRunMs, createdAt, updatedAt, nextDueAt, recentRuns }
```

The store is **not** the Session log. A Cron job outlives every conversation it may touch, so recording it in a Session would recreate the limitation this feature exists to remove.

The `cron` domain is opened **only by the process that holds the leader lease**, taken at plugin load on the lock file the deployment names in `leaderLockPath`. That path is a required configuration field rather than a defaulted one: a default could point somewhere other than the configured storage root, and two deployments would then each believe they lead while sharing one domain. `ctx.storageDomain` keeps memory authoritative after an open, emits `domain/changed` in-process only, and offers no reload, so a second process that opened the same domain would read stale jobs forever. A process that does not hold the lease therefore opens nothing: its tools and Remote answer a stable `cron_not_leader` error and its panel reports that another process holds the scheduler, rather than presenting expired rows. A non-leader retries acquisition on the configurable `leaderRetryMs`; kernel release on process death lets the successor take the lock and open the domain fresh, which is what makes handover readable without a reload API.

A successful management write is durable when the domain's backend write completes, because the domain persists before it mutates memory. Cron has no Session flush barrier, and a maintainer copying the Schedule barrier discipline here would be adding a wait that cannot succeed.

### Trigger, delivery, and unattended authority

A due job re-reads its record and re-derives `nextDueAt` from the rule rather than trusting a cached target, applies `misfirePolicy`, claims a run slot under `overlapPolicy` (default `skip`: one run per job at a time), resolves its target, delivers, records the run, advances the next occurrence, and releases the slot.

Target resolution converges on one deliverable: an Agent that can accept a follow-up. A `new-session` job calls `ctx.agents.create` with a generated id, the declared workspace as `meta.cwd`, and the declared presets, mirroring [`createWebhookSession`](../../../../packages/experimental/webhook/src/session.ts). A `session` job whose Session already has a live Agent delivers with `followup` directly; only a cold Session is resumed with `ctx.agents.resume`, because resuming a Session this process already owns is refused. Neither path scans Sessions at startup: a bound job names its Session id, so the "startup scan" cost recorded against a global scheduler does not apply here.

A fired job wakes nothing that the harness treats as human input. Delivery carries a Cron-declared message source, which `MessageSourceMap` requires because it has no generic `plugin` kind, and the framing follows the Schedule convention of JSON-escaped dynamic fields plus an explicit instruction that the authored prompt is untrusted content rather than new user instructions.

Unattended execution is the part that can spend real resources with nobody present, so authority is explicit:

- Creating a job is the act that authorizes future unattended spending. The Web panel and the Remote are direct human authority. The model tool requires a direct human message in a live root-agent turn, mirroring the model goal-tool authority rule, so a model cannot schedule unattended work from inside its own autonomous round.
- A job declares a `permissionPreset`, and the deployment default is a conservative one. Under the shipped `ask` approval policy an unattended tool call that needs a human decision would otherwise hang, so a run that reaches that state ends as `blocked` when `maxRunMs` elapses; it is neither silently auto-approved nor silently skipped.
- Every run is bounded by `maxRunMs`; expiry cancels the Agent and records `timeout`.
- There is no "unattended full access" convenience switch. Reaching full access requires naming a full-access preset that is visible in configuration.
- An Agent created for a run is owned by the plugin fiber and is disposed with it; teardown never reports a run as complete.

### Human and model management surfaces

The model receives five CRUD-shaped tools with a closed error union: `cron_invalid_expression`, `cron_invalid_time_zone`, `cron_not_found`, `cron_not_leader`, `cron_run_in_progress`, and `cron_persistence_uncertain`. Tool schemas and results are written from the model's perspective and never mention panels, transports, or storage.

The Web panel is a separate opt-in plugin over `ctx.remote.cron`. Disabling it leaves the tools and the runtime intact, which keeps the optional surface from carrying any part of the capability.

Run history is bounded and durable, because a scheduler whose runs leave no trace is unusable the morning after. Each job keeps its most recent `maxRunsPerJob` records with outcome, start, and end.

### Boundary with existing owners

| Existing owner | Boundary |
|---|---|
| `dsh-schedule` | Unchanged. Cron never reads or writes `schedule/change`, never adopts its records, and never redefines its rule union. Schedule remains the in-conversation reminder; Cron is the calendar scheduler. The one shared action, delivering a message into a Session, differs in creation surface, durable owner, and trigger condition. |
| Goals and Ralph | Cron owns only *when* work starts. A fired job seeds one message; goal rounds, Ralph rounds, and their budgets and activation rules continue to govern everything after that, including the rule that session restore is observation rather than authority to spend. |
| `ctx.jobs` | Cron does not use the job registry as its store or its run identity. Jobs are process-local and in-memory, while a Cron run must be recorded durably and survive restart. |
| Webhook ingress | `WebhookRuntime.dispatch` is HTTP-agnostic and Cron reuses its *shape*, but `WebhookSessionRequest` can only create a new Session; a job with a `session` target therefore performs its own resume, which the webhook path cannot express. |

### Implementation plan

`TDD Route`: mode `auto`, decision `strict`. Authority is this repository's mandatory testing contract ([testing.md](../../../../docs/testing.md)) together with the auto rule's contract, persistence, permission, and producer/consumer signals; no explicit user TDD request exists. Posture: a behavior task starts from a failing focused test under `packages/*/*/tests/`. The composition and presentation tasks are the exception only in mechanism — their strictest available signal is the mandated real-Loader composition, recorded-session snapshot, and Web end-to-end evidence rather than a unit RED step.

`Requirement Ready Check`: the approved source is this note's Proposal and Acceptance criteria; scope, scenarios, and acceptance evidence are complete, and no decision-changing item is open.

`Change Necessity`: no existing owner implements calendar scheduling, and documentation or configuration alone cannot deliver it, because the behavior needs a durable store, a cross-process lease, and a runtime. The minimum code boundary is the six packages and one overlay above.

`Ripple Signal Triage`: signals fire on public API (`ctx.cron`, `ctx.remote.cron`), persistence (a versioned storage domain), permission (unattended execution authority), shared primitives (two `util` packages), producer/consumer pairs, and retirement (two private implementations are replaced). Canonical owners: `dsh-cron` owns Cron state and timing, `dsh-util-path-lock` owns cross-process path locking, and `dsh-util-time` owns IANA zone projection. The consumers whose behavior must be re-verified are `dsh-schedule`, `session-persistence-jsonl`, the Web composition roster, and the generated catalogs.

**File map**

| Area | Files |
|---|---|
| Shared lock | `packages/util/path-lock/` — `package.json`, `tsconfig.json`, `src/index.ts`, `tests/`, `README.md`, `README.zh.md`, `README.i18n.yaml` |
| Session lease consumer | `packages/session/session-persistence-jsonl/src/lease.ts` keeps the session-owned policy (lock-file name, directory mode, contention mapping) and `src/win32.ts` keeps only durable namespace publication; both consume the new package |
| Shared time | `packages/util/time/src/index.ts`, `packages/util/time/tests/`, its README triplet |
| Schedule consumer | `packages/schedule/schedule/src/domain.ts` |
| Cron host | `packages/cron/cron/src/` — `index.ts`, `types.ts`, `domain.ts`, `store.ts`, `lease.ts`, `runtime.ts`, `delivery.ts`, `authority.ts`, plus `tests/` and the README triplet |
| Cron tool | `packages/cron/tool-cron/src/index.ts`, `tests/`, README triplet |
| Remote | `packages/api/cron-controller/src/`, `tests/`, README triplet |
| Web panel | `packages/client/ui-cron/src/client/`, `tests/`, README triplet |
| Composition | `apps/cli/config/examples/cron/cordis.yml`; the disabled `ui-cron` row and its dependency in `packages/bundle/web-app/cordis.patch.yml` and `packages/bundle/web-app/package.json`; `apps/cli/package.json` for the overlay's resolver manifest |
| Registries | `tsconfig.host.json`, `tsconfig.client.json`, the regenerated `tsconfig.base.json` paths, `packages/cron/README` triplet, `packages/client/README` member row, `docs/subsystems/cron.md` with its website route |
| Generators | the `sources` entry in `scripts/gen-tool-catalog.ts` and every regenerated catalog or graph named below |

**Tasks**

| # | Task | Minimum change | Verification |
|---|---|---|---|
| T1 | Extract the cross-process path lock | New `dsh-util-path-lock` owns the POSIX kernel lock and the Win32 named kernel semaphore, exposing held-lock acquisition and a contention error. Its own focused spec covers exclusion, admission after release, lock-file residue, inode verification, and the Win32 semaphore branch through a mocked kernel32 binding. | focused test run for the package; `test:coverage` |
| T2 | Consume it in the session write lease | `session-persistence-jsonl` moves its kernel locking into the new package, leaving `src/lease.ts` as the session-owned policy around it and `src/win32.ts` with only durable namespace publication, and maps contention to the existing `SessionAlreadyOwnedError`. No storage-format change and no re-export. Its backend-level lease spec stays with the backend; the Win32 lock tests move to the new package. | focused session-persistence tests; `test:snapshot` |
| T3 | Export zone projection from `dsh-util-time` | Add the mechanical primitive that enumerates the instant candidates for a local calendar time in an IANA zone and reports whether the zone skips or repeats it. The gap and overlap *policy* stays with each consumer, so the package remains a library that registers nothing. The projection compares against the reading's UTC-shaped value, so `localCalendarEpoch` is exported beside it rather than duplicated in the Schedule domain, and the package's documented identity widens from canonicalization-only to canonicalization plus projection: its description, README summary, and limitations change in the same task, while it still raises no domain code. | focused tests for the package |
| T4 | Consume it in the Schedule domain | `dsh-schedule` deletes its private `localProjection` and `resolveLocalInstant`, consumes the export, and keeps its shipped policy: a gap rejects, an overlap takes the earlier instant. Its own `CalendarParts` declaration becomes an alias of the shared reading type, and its `calendarEpoch` maps the shared `RangeError` back to the existing `invalid_rule` message. | focused schedule tests, whose existing "resolves explicit local time, rejects a DST gap, and chooses the first overlap instant" case exercises this path directly; `test:coverage` for the package. The recorded-session corpus holds no Schedule scenario, so no `test:snapshot` filter names one; Schedule's end-to-end lane is `apps/web/tests/schedule-after.e2e.ts`. |
| T5 | Cron expression engine | The pure parse, validate, and occurrence resolution over five fields, the macros, and the names, including the day-of-month union with day-of-week. The exported resolver is `nextCronOccurrence`, which bounds its walk at `MAX_SEARCH_DAYS` days — wider than the eight-year gap a skipped century leap year creates — and answers `undefined` beyond it; it applies the shared policy of passing over a reading the zone skipped and taking the earlier instant of one it repeated. | focused tests covering the union, `*/n` bounds, names, the gap, the overlap, a skipped century leap year, and a rule that never fires |
| T6 | Cron records and the closed error union | `CronJob`, `CronRunRecord`, and strict decoding of a stored record that rejects unknown versions and extra fields. | focused tests, including invalid-input rejection |
| T7 | Cron store and leader lease | The `ctx.cron` Service Definition, the `cron` domain at `version: 1`, a store over that domain's two handles, leadership taken through `dsh-util-path-lock`, the domain opened only while it is held, `cron_not_leader` otherwise, and retry on `leaderRetryMs`. The retry timer is supplied by the plugin's own fiber rather than created by the ownership, so disposal cancels it; the ownership does not assume the canceller ran, so an attempt that fires anyway opens nothing; a store that cannot open releases leadership, because holding it without a store would stop every other process from ever becoming the scheduler. | unit tests for acquire, refuse, and handover; a two-process test asserting exactly one trigger |
| T8 | Timer runtime and run state machine | Segmented single-timer scheduling with a wall-clock re-sample after every wake, misfire policy, overlap policy, `maxRunMs` cancellation, and bounded run records. | focused tests with explicit clock samples |
| T9 | Target resolution and delivery | `create` for a new Session, direct `followup` for a live bound Session, `resume` only for a cold one, Cron's declared message source, and the escaped framing. | focused tests plus a real-Loader composition test |
| T10 | Unattended authority | Require a direct human message in the live root-agent turn for the model path, apply a conservative default `permissionPreset`, and end a run that reaches an interactive approval as `blocked` at `maxRunMs`. | denial test through the tool executor; blocked-run test |
| T11 | Model tools | `tool-cron` registers the five tools inside `ctx.effect` and returns the closed error codes. | focused tool tests; the generated tool catalog includes the new schemas |
| T12 | Remote controller | Host `ctx.cronController` and the generated Client namespace with one baseline-plus-increment subscription and the mutation and run-now unaries. | focused controller tests; a disposal test that unregisters the namespace |
| T13 | Web panel and composition | The `ui-cron` panel with typed locale dictionaries, the `disabled` row in the Web bundle, and the example overlay. | `test:web`; `verify-cordis-config`; the client UI copy gate |
| T14 | Plugin lifecycle | Every registration through `ctx.effect`, with disposal removing the tools, the Remote, the domain handle, the lease, and the timers. | the mandated HMR-safety disposal test per contribution |
| T15 | Recorded evidence | One keyless recorded-session scenario for a Cron-fired run and one Web expectation for the panel. | `test:snapshot`; `test:web` |
| T16 | Documentation and generators | The group README, the package README triplets with Model Experience and Known Limitations, the subsystem page, and every regenerated catalog and graph. | `doc-sync` |
| T17 | Change-wide gates | Run the repository gates over the complete change. | `typecheck`, `lint`, `test:coverage`, `build`, `hygiene`, `duplication`, `doc-sync`, and `test:snapshot` |

**Retirement.** The kernel-lock implementation inside `session-persistence-jsonl` (the POSIX descriptor handling and the Win32 semaphore binding) and the private calendar helpers in `packages/schedule/schedule/src/domain.ts` are deleted by the task that introduces their shared replacement. What stays in each consumer is only its own policy around the shared primitive: the session keeps its lock-file name, its directory provisioning mode, and its error identity; the Schedule domain keeps its gap-rejects/overlap-earlier rule. Neither consumer retains a re-export or a second implementation.

**Package wiring the source tree requires.** A new package with a name that does not match its directory cannot be reached by the generated alias block, so `dsh-util-path-lock` needs a hand-written `paths` entry beside `dsh-util-time` in `tsconfig.base.json`; both consumers also need a TypeScript project reference to it, and the new package needs one to the native system entry it imports.

**Execution constraint.** Every gate and test command above runs TypeScript through tsx or esbuild, which spawns a piped child process. Under the default session sandbox that spawn is denied with `EPERM`, so the implementing session needs file-sandbox access wide enough for those child processes; otherwise no task in this plan can be verified by execution.

## Alternatives considered

- **Extend `dsh-schedule` with a Cron rule instead of adding a family.** Rejected because a Schedule record is Session-owned conversation state with session-local delivery and a flush barrier, while a Cron job belongs to no Session, must run while every conversation is cold, and needs cross-process ownership. Adding a rule kind would force the Session log to become a global job database and would break the fork and replay semantics Schedule already depends on.
- **Reuse `ctx.jobs` as the store and the run identity.** Rejected because the job registry is process-local and in-memory by its own documented contract, and because it refuses work while no controller serves the owner. A Cron job needs durable identity, a restart-safe next occurrence, and an addressable run record that outlives the process.
- **Store Cron jobs in the Session log as a new event stream.** Rejected for the same ownership reason, and additionally because it would put a model-visible scheduler into the replay and fork paths of a conversation that the operator never opened.
- **A dedicated always-on scheduler profile instead of a lease.** Rejected as the *mechanism*: it still permits a second process to trigger the same job when a user also runs `dsh web`, so it defers the exclusion problem rather than solving it. The lease lets any profile host the scheduler while keeping exactly one trigger.
- **Depend on an existing Cron library** such as `croner`, which is dependency-free and supports time zones ([croner](https://croner.56k.guru/index.html), [time zone and DST notes](https://www.nodecron.com/timezones-and-dst.md)). Rejected because the calendar resolution must be shared with `dsh-schedule` anyway to keep one DST semantics in the harness, which leaves only field parsing and occurrence arithmetic to delete, and because a second time-zone engine would introduce a new external dependency and a second DST policy for a small reduction in owned code.
- **Duplicate the kernel lock and the calendar resolution inside the Cron package.** Rejected because `packages/util/` exists to prevent exactly this duplication, and because two owners of "lock a path exclusively across processes" would drift on the platform-specific paths that are hardest to test.
- **A shell-only task kind that never involves the model.** Rejected as the first scope: the operator intent that motivated this work is unattended agent work, and adding a second execution path would double the failure, cancellation, and concurrency semantics before the first path exists. It remains available later as a separate task kind with its own authority model.
- **A generic model-facing `loop` tool over a universal loop service.** Already rejected by the harness-level loop decision as speculative surface that duplicates session, workflow, subagent, and job machinery. Cron is the concrete scheduler consumer that decision was waiting for, and it adds no iteration abstraction.
- **Auto-continue a Session when it is restored.** Rejected by the same decision and preserved here: opening a Session is observation, not authority to spend. Cron's authority comes from the job's creation, not from a Session becoming live.

## Acceptance criteria

- A job created with `0 9 * * 1-5` and an explicit zone runs at 09:00 local on weekdays, and its recorded next occurrence is correct across a spring gap and an autumn overlap.
- With two harness processes running and both loading the plugin, exactly one triggers a due job; the other answers `cron_not_leader` for management and shows no stale rows. Killing the leader lets the survivor take over and observe the leader's committed jobs.
- A `new-session` job creates one Session with the declared workspace and presets and delivers its prompt; a `session` job delivers into the live Session without resuming it and resumes a cold one.
- Creating jobs through the model tool without a direct human message in the current root-agent turn is refused; creating through the panel succeeds.
- A run whose tool calls need human approval ends as `blocked` at `maxRunMs` rather than hanging or proceeding.
- Jobs and their bounded run history survive a process restart, and the restart does not double-fire a run that already completed.
- Disposing the plugin fiber removes every tool, Remote, panel, domain handle, and timer it registered.
- Model-visible tool schemas, results, and delivery framing are pinned by keyless recorded-Session snapshots, and the generated tool and config catalogs include the new surfaces.

## Risks

- **Two schedulers in one harness.** Cron and `dsh-schedule` both deliver into Sessions, and a user may not know which feature produced a message. The mitigation is that only Cron can run while a Session is cold; the residual risk is presentation confusion, which the panel's separate entry and Cron's declared message source reduce but do not remove.
- **A wedged leader blocks all triggering.** The kernel lock deliberately has no expiry, so a live but stalled leader keeps the scheduler until its process exits, while a crashed holder releases it immediately. This trades availability for the guarantee that two processes never write the same store.
- **Unattended resource spend.** A mis-authored job with a permissive preset spends tokens and calls tools with nobody present. Bounds are `maxRunMs`, `overlapPolicy`, and the conservative default preset; the feature cannot detect a job that is simply unwise.
- **A narrow duplicate window.** A crash after delivery but before the run record is durable can repeat one run on the next start. Cron is at-least-once and does not claim exactly-once effects.
- **Storage-format commitment.** The `cron` domain's `version: 1` layout becomes durable state the moment a job is created, and the domain layer rejects a version mismatch instead of migrating it, so any later layout change needs its own migration decision.
- **Two release packages are refactored for the shared primitives.** `session-persistence-jsonl` and `dsh-schedule` change their internals, so their existing lock and calendar tests must move with the code. The risk is behavioral drift in already-shipped paths, and the mitigation is that both refactors are mechanical moves covered by the tests that already pin them.
- **DST and crontab semantics are owned, not borrowed.** Rejecting a library means the edge cases (`*/n` ranges, month and weekday names, day-of-month with day-of-week union, gap and overlap) are this repository's to test, and a wrong union rule would silently drop expected runs.
