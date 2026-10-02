# Calendar scheduled tasks

English | [中文](cron.zh.md)

Cron owns the timing, authority, and durability of a scheduled trigger: a task states a five-field cron rule and an IANA zone, and a firing delivers one authored message into a Session that may be cold when the trigger arrives. [`@deepseek-ai/dsh-cron`](../../packages/cron/cron/README.md) owns that capability as the `ctx.cron` Service Definition plus its shipped provider; the [cron scheduled tasks Agent Note](../../.agents/notes/proposed/feature/2026-09-26-cron-scheduled-tasks.md) owns the decision and its rejected alternatives. This page records the durable and model-facing vocabulary; the [package README](../../packages/cron/cron/README.md) owns composition and the [tool package README](../../packages/cron/tool-cron/README.md) owns the exact tool schemas.

Role map:

| Package | Owns | Service |
|---|---|---|
| [`dsh-cron`](../../packages/cron/cron/README.md) | The expression grammar and day matching, occurrence resolution, the durable `cron` domain, the leader lease, the segmented timer, and delivery | `ctx.cron` |
| [`dsh-tool-cron`](../../packages/cron/tool-cron/README.md) | The five model-facing management tools and their unattended-authority check | — |
| [`dsh-api-cron-controller`](../../packages/api/cron-controller/README.md) | The Host Remote controller and the generated Client `ctx.remote.cron` namespace | `ctx.cronController` |
| [`dsh-client-ui-cron`](../../packages/client/ui-cron/README.md) | The opt-in Web Session-header panel | — |

## Expressions

A rule is five space-separated fields — minute, hour, day-of-month, month, day-of-week — supporting `*`, `a-b`, ranges with a step (`*/n`, `a-b/n`), comma lists, and three-letter month and weekday names, plus the `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, and `@yearly` macros. There is no seconds field, so one minute is the finest granularity a rule can express, and no Quartz `?`, `L`, `W`, or `#` token exists. A stepped single value runs to the end of its field, the Vixie reading: `5/15` means `5,20,35,50`.

When both day fields are restricted, a day fires on the **union** of their matches, which is the POSIX crontab rule: `0 0 1 * 1` runs on the first of the month and on every Monday. Restricting one field leaves the other unrestricted, and restricting neither fires every day.

`parseCronExpression` reads one rule into ascending, duplicate-free value lists and never consults a clock, a zone, or the current date, so the same text always yields the same value. `matchesCronDay` answers whether one calendar day satisfies the day fields, applying the union rule. A refusal is a `CronExpressionError` carrying the offending `field` and the stable `invalid_expression` code.

## Occurrence resolution

`nextCronOccurrence(expression, timeZone, afterEpoch)` is pure and reads no ambient clock: production samples the wall clock and passes the sample in, so tests state explicit samples. It answers the first instant strictly after the reference at which the rule fires, in the stated IANA zone. The walk is bounded at `MAX_SEARCH_DAYS` days — wider than the eight-year gap a skipped century leap year creates — and answers `undefined` rather than searching forever.

Zone projection comes from [`dsh-util-time`](../../packages/util/time/README.md), which reports the candidate instants of a local reading and whether its zone skipped or repeated it. The policy over that report is shared with [Schedule](schedule.md) so the harness has one daylight-saving semantics rather than two: a local reading the zone skipped is passed over, and a reading the zone repeated contributes both instants, of which the earliest that follows the reference wins.

Every task declares its own zone, and the capability never reads the browser zone, the process zone, a Session header, or model time context. Replay therefore never depends on ambient time-zone state.

## Durable records

`CronJobId` is a branded identity minted by the store that owns it and never reused: the domain's `nextJobNumber` allocator only advances, so a deleted task's identity cannot come back. A task is one versioned record:

| Field | Meaning |
|---|---|
| `version` | Durable record version; the decoder admits only the value `CRON_RECORD_VERSION` states |
| `id` | Branded `CronJobId` |
| `expression`, `timeZone` | The rule as written and the IANA zone it is read in |
| `enabled` | Whether the scheduler may fire it |
| `target` | `new-session` with its workspace and agent and permission presets, or `session` with the Session it continues |
| `prompt` | The message one firing delivers |
| `overlapPolicy`, `misfirePolicy` | `skip` or `queue-one`, and `skip` or `run-once-late` |
| `maxRunMs` | Positive ceiling on one run, in milliseconds |
| `createdAt`, `updatedAt`, `nextDueAt` | Creation, last change, and the earliest occurrence not yet dispatched |
| `recentRuns` | The most recent finished runs, oldest first, bounded by `maxRunsPerJob` |

One finished run is a `CronRunRecord`: its `startedAt` and `finishedAt` instants and its outcome, one of `completed`, `failed`, `timeout`, `blocked`, or `interrupted`. `completed` records that the framed message was admitted into its Session, not how the resulting turn ended.

`decodeStoredCronJob` decodes a stored value strictly and rejects unknown versions, extra fields, an unusable expression, an unusable zone, or an unusable run history with a `CronRecordError` carrying the stable `corrupt_cron_record` code.

The store is the `cron` storage domain at `version: 1` — one `jobs` table keyed by task id plus the id allocator — and is deliberately not the Session log: a task outlives every conversation it may touch, so recording it in a Session would recreate the limitation the capability exists to remove. See [storage](storage.md) for the domain contract.

## The store and its leader lease

The `cron` domain is opened only by the process that holds the leader lease, taken at plugin load on the lock file the deployment names in `leaderLockPath`. That field is required and deliberately not defaulted: a default could point somewhere other than the deployment's configured storage root, and two deployments would then each believe they lead while sharing one domain.

A process that does not hold the lease opens nothing and answers `cron_not_leader` for every management verb, because a storage domain keeps memory authoritative after it opens and offers no reload — a follower that opened one would serve the tasks it read at open time forever. A follower retries acquisition every `leaderRetryMs`. The lock is a kernel lock, so a crashed leader releases it as its process ends and the successor takes it and opens the domain fresh, which is what makes handover readable without a reload API. The same leadership installs the runtime: the timer exists only while a store does, so only the leader fires tasks.

A management write is durable when the domain's backend write completes, because the domain persists before it mutates memory. There is no Session flush barrier to await here.

## Run lifecycle

A due task re-reads its record and re-derives its next occurrence from the stored rule, applies `misfirePolicy`, claims a run slot under `overlapPolicy`, resolves its target, delivers, records the run, advances the occurrence, and releases the slot. `queue-one` admits at most one waiting run behind the one in flight and drops further arrivals; `skip`, the default, admits none. `misfirePolicy` decides only occurrences that passed while no scheduler was running at all: a wake that arrives after several occurrences produces one run and moves the stored occurrence past the wall clock rather than replaying each missed one.

One runtime serves every stored task from a single segmented timer that re-samples the wall clock after every wake, so a clock jump or a suspended machine cannot make it fire early. Every run is bounded by `maxRunMs`; expiry cancels the Agent and records `timeout`. A run that reaches an interactive approval with nobody present ends as `blocked` at that same ceiling rather than proceeding or hanging. Disposal stops scheduling, aborts a delivery in flight, and then closes the store, in that order; a run already started settles through its own record, so unloading never waits out a task's remaining ceiling. `runNow` refuses with `cron_run_in_progress` while a run of that task is in flight.

## Delivery

Target resolution converges on one deliverable, an Agent that can accept a follow-up. A `new-session` task calls `ctx.agents.create` with a generated Session id, the declared workspace as the Session directory, and the declared presets, so the runs happen under the authority the task itself states; composing one needs the agent-preset and permission-preset services. A `session` task whose Session already has a live Agent delivers a follow-up directly, and only a cold Session is resumed, because resuming a Session this process already owns is refused; that path needs a session persistence backend. A run whose composition lacks a service its target needs is recorded as `failed` rather than delivered without it. An Agent a run created is owned by the plugin fiber and disposed with it, and teardown never reports a run as complete.

The delivered message carries a Cron-declared message source and the stable `[CRON TASK]` framing, whose dynamic fields are JSON-escaped and which states that the authored prompt is untrusted content rather than new user instructions.

## Management surfaces

`ctx.cron` is the Service Definition every consumer reads: `list`, `get`, `create`, `update`, `remove`, and `runNow`. The shipped provider answers from the store this process leads, so an operation it cannot serve reports `cron_not_leader` through `CronServiceError` rather than a stale answer. The closed `CronErrorCode` union is `cron_invalid_expression`, `cron_invalid_time_zone`, `cron_not_found`, `cron_not_leader`, and `cron_run_in_progress`.

Creating a task or re-pointing its target is the act that authorizes future unattended spending, so the model-facing tools require a direct human message in the live root-agent turn for `cron_create` and `cron_update`, mirroring the model-facing goal tools; `cron_list`, `cron_delete`, and `cron_run` take authority away rather than spend it, so they need the live root turn but no human message. The generated [tool catalog](../tool-catalog.md#deepseek-aidsh-tool-cron) owns the argument and result schemas.

The Host Remote controller reads `ctx.cron` at call time and maps each refusal to a stable Remote code — `cron/invalid-expression`, `cron/invalid-time-zone`, `cron/not-found`, `cron/not-leader`, or `cron/run-in-progress` — and its `follow()` stream opens each generation with one complete task baseline followed by one frame per committed write to the domain's job table. A reconnect starts a new generation with a replacement baseline, and a process holding no lease opens its generation with `cron/not-leader` rather than an empty list.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcron--cronservice-abstract-seam"></a>

### `ctx.cron` — `CronService` (abstract seam)

Calendar scheduling, as every consumer sees it.

Implementations answer from durable state, so a caller never has to know whether this process is the scheduler: an operation that cannot be served here reports `cron_not_leader` through the provider's own failure surface rather than returning a stale answer.

```ts cordis-catalog
/**
 * Every stored job, in the store's own order.
 * @returns the jobs the provider holds.
 */
abstract list(): readonly CronJob[]

/**
 * Read one job.
 * @param id - the job's identity.
 * @returns the job, or `undefined` when none is stored under that id.
 */
abstract get(id: CronJobId): CronJob | undefined

/**
 * Create a job.
 * @param request - the caller's stated rule, target, and message.
 * @returns the stored job, including its minted identity and next occurrence.
 */
abstract create(request: CronJobRequest): Promise<CronJob>

/**
 * Change a stored job.
 * @param id - the job's identity.
 * @param update - the fields to replace.
 * @returns the stored job after the change.
 */
abstract update(id: CronJobId, update: CronJobUpdate): Promise<CronJob>

/**
 * Remove a job.
 * @param id - the job's identity.
 * @returns whether a job was stored under that id.
 */
abstract remove(id: CronJobId): Promise<boolean>

/**
 * Run a job once, now, without changing its schedule.
 * @param id - the job's identity.
 * @returns the finished run's record.
 */
abstract runNow(id: CronJobId): Promise<CronRunRecord>
```

Source: [`packages/cron/cron/src/service.ts`](../../packages/cron/cron/src/service.ts)

<a id="ctxcroncontroller--croncontroller"></a>

### `ctx.cronController` — `CronController`

Host service backing the generated `ctx.remote.cron` namespace.

```ts cordis-catalog
/**
 * Store one new task.
 * @param request - the stated rule, destination, and message.
 * @returns the stored task, including its minted identity and next occurrence.
 */
@Remote('create') create(request: CronViewCreateRequest): Promise<CronViewValue>

/**
 * Replace the stated fields of one stored task.
 * @param request - the target identity and the fields to replace.
 * @returns the stored task after the change.
 */
@Remote('update') update(request: CronViewUpdateRequest): Promise<CronViewValue>

/**
 * Remove one stored task.
 * @param request - the target identity.
 * @returns the removed task's projection.
 */
@Remote('delete') delete(request: CronViewJobRequest): Promise<CronViewValue>

/**
 * Run one stored task once, now, without changing its schedule.
 * @param request - the target identity.
 * @returns the finished run's bounded record.
 */
@Remote('runNow') runNow(request: CronViewJobRequest): Promise<CronViewRunNowValue>

/**
 * Stream a complete task baseline followed by ordered stored-task increments.
 * @param signal - generation cancellation owned by the Remote stream carrier.
 * @returns the baseline, then one frame per committed task write.
 */
@Remote({ mode: 'stream' }) follow(signal: AbortSignal): AsyncIterable<CronFollowFrame>
```

Source: [`packages/api/cron-controller/src/index.ts`](../../packages/api/cron-controller/src/index.ts)
<!-- END GENERATED cordis-surface -->
