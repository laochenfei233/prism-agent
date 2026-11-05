---
description: "Calendar scheduling capability: the five-field cron expression grammar, its day-matching rules, occurrence resolution over an explicit IANA zone, the durable job store behind a cross-process leader lease, the `ctx.cron` management service, the segmented timer that fires due jobs, and the delivery of one firing into a Session."
kind: "package-reference"
---

# @deepseek-ai/dsh-cron

English | [中文](README.zh.md)

## Summary

`dsh-cron` owns the calendar vocabulary a scheduled task is written in. `parseCronExpression` reads one five-field crontab expression or a `@hourly`-family macro into ascending, duplicate-free value lists; `matchesCronDay` admits the union of the two restricted day fields — the Vixie rule. The package is also the Cordis plugin: it takes a kernel leader lease, opens the `cron` storage domain only while holding it, publishes `ctx.cron` for `list`, `get`, `create`, `update`, `remove`, and `runNow` — each refused with `cron_not_leader` in a process that does not lead — fires due jobs from one segmented timer, and delivers each firing into its target Session.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Parse once, then match the schedule's own calendar against the parsed value:

```ts
import { CronExpressionError, matchesCronDay, parseCronExpression } from '@deepseek-ai/dsh-cron'

declare const dayOfMonth: number
declare const dayOfWeek: number

try {
  const expression = parseCronExpression('0 9 * * 1-5')
  if (matchesCronDay(expression, dayOfMonth, dayOfWeek)) {
    // this day fires
  }
} catch (error: unknown) {
  if (!(error instanceof CronExpressionError)) throw error
  // error.field names the field; error.code is 'invalid_expression'
}
```

The parser never consults a clock, a zone, or the current date, so the same text always yields the same value. Resolving a reading into an instant goes through [the shared time vocabulary](../../util/time/README.md), which reports a zone's skipped and repeated hours rather than choosing between them; `nextCronOccurrence` applies the choice this vocabulary's callers share — a skipped reading is passed over, and a repeated one contributes both instants so the earliest that follows the reference wins.

No runtime invariant companion is published: the scheduler's one cross-process relationship — a process holds the store only while it holds the leader lease — is enforced inside `CronOwnership` rather than asserted from outside, and the runtime's timer, its policies, and its bounded history are pinned by unit tests.

### The two day fields

A restricted day-of-month and a restricted day-of-week fire on the **union** of their matches, so `0 0 1 * 1` runs on the first of the month *and* on every Monday. Restricting one field leaves the other unrestricted; restricting neither fires every day. Callers that intersect the two silently drop runs an operator wrote.

### Composing the plugin

The plugin requires `leaderLockPath` and states where the deployment's scheduler lock lives; it is deliberately not defaulted, because a default could point somewhere other than the deployment's storage root and two deployments would then each believe they lead while sharing one domain:

```yaml
- id: cron
  name: '@deepseek-ai/dsh-cron'
  config:
    leaderLockPath: /var/lib/dsh/storages/cron/leader.lock
    leaderRetryMs: 30000
    maxRunsPerJob: 20
    defaultMaxRunMs: 600000
```

Management reads the store this process leads, so a follower answers `cron_not_leader` rather than serving rows it read when it started:

```ts ignore-check
const job = await ctx.cron.create({
  expression: '0 9 * * 1-5',
  timeZone: 'Asia/Shanghai',
  target: { kind: 'session', sessionId: 'session-1' },
  prompt: 'summarize yesterday',
})
```

Follower processes retry acquisition on `leaderRetryMs`. Because the lease is a kernel lock, a crashed leader releases it as its process ends, and the successor opens the domain fresh — which is how it observes the leader's committed jobs without a reload. The same leadership installs the timer: the runtime is started when a store arrives, so only the leader fires jobs, and it stops when that store goes.

A firing is delivered through the Agents service: `CronDelivery` creates the Session a `new-session` target declares, queues into the live Agent of a `session` target, and resumes that Session only while this process owns no Agent for it. Composing a `new-session` target additionally needs the agent preset and permission preset services, and resuming a cold `session` target needs a session persistence backend; a run whose composition lacks the service its target needs is recorded as `failed` rather than delivered without it.

## API

| Export | Role |
|---|---|
| `parseCronExpression(source)` | One parsed expression, or `CronExpressionError`. |
| `matchesCronDay(expression, dayOfMonth, dayOfWeek)` | Whether that calendar day fires. |
| `nextCronOccurrence(expression, timeZone, afterEpoch)` | The first instant strictly after the reference at which the rule fires, or `undefined` when it does not fire within the search bound. |
| `MAX_SEARCH_DAYS` | How many days that search walks before answering `undefined`. |
| `CronExpressionError` | A parse refusal carrying `field` and the stable `invalid_expression` code. |
| `decodeStoredCronJob(value)` | One stored task decoded strictly, or `CronRecordError` when its shape, its expression, its zone, or its run history is unusable. |
| `cronJobSchema` | The strict storage schema, for the store that validates every value it opens. |
| `CRON_RECORD_VERSION` | The only durable record version this decoder admits. |
| `CronRecordError` | A stored-record refusal carrying the stable `corrupt_cron_record` code. |
| `cronDomainSpec` | The durable layout the scheduler opens: one `jobs` table keyed by job id plus the never-reused id allocator. |
| `cronDomainState` | That domain's global schema, for the store that advances the allocator. |
| `CronLeadership` | The leadership lease over one lock file: `take` answers a held leadership, `undefined` while another live process holds it, and raises a failure that is not contention. |
| `CronStore` | Reading and writing the jobs one opened domain holds, including the never-reused identity allocator; every write is durable when it resolves. |
| `LEADER_LOCK_FILENAME` | The lock file's base name inside the scheduler's directory. |
| `CronOwnership` | Opening the store only while this process leads, and retrying acquisition on the configured delay. |
| `CronService` | The `ctx.cron` Service Definition: the verbs every consumer may ask for. |
| `Config` | The plugin config schema the Loader validates a deployment against. |
| `resolveCronConfig(config)` | That config with every default stated, for a caller that builds it directly. |
| `CronConfig` | The resolved config the plugin uses. |
| `CronServiceError` | A refused management call carrying one code from the closed `CronErrorCode` union. |
| `CronProvider` | The shipped `ctx.cron` provider: every verb over the store this process leads. |
| `CronProviderOptions` | What the provider needs from the composition: the store source, the runner, the clock, and the run ceiling default. |
| `CronRunner` | One run at a time per job, bounded by the job's ceiling, with its history appended to the store. |
| `CronRunnerOptions` | What a run needs from its owner: the store source, the run body, the history bound, and the clock. |
| `CronRunBody` | The composition's delivery step for one firing: what a run does, and how it settled. |
| `CronRuntime` | The segmented single timer that fires due jobs under the misfire and overlap policies. |
| `CronRuntimeOptions` | What the runtime needs from the composition: the store source, the runner, the clock, and the failure sink. |
| `MAX_TIMER_DELAY_MS` | The largest delay a Node timer represents without clamping. |
| `CronDelivery` | The delivery of one firing: the framing it queues and the target it reaches — a created Session, a live Session's Agent, or a resumed cold one. |
| `CronDeliveryOptions` | What a delivery needs from its composition: the live-Agent lookup, the Session creator, the Session resumer, and the failure sink. |
| `CronDeliveredAgent` | One Agent a delivery reaches without owning it: the follow-up it accepts. |
| `CronLoadedAgent` | One Agent a delivery created or resumed, which a failed delivery rolls back. |
| `CronNewSessionRequest` | What a `new-session` target states for the Session a delivery creates. |
| `renderCronTaskFraming(job)` | The stable `[CRON TASK]` block a delivery queues, with JSON-escaped dynamic fields. |
| `apply(ctx, config)` | The Cordis plugin itself; `name` and `inject` declare it to the Loader. |

<a id="model-experience"></a>
## Model Experience

Indirectly, through the tool consumer that registers the model-facing scheduling tools and the delivery framing a fired job queues into a Session. The management service and the run body are not model-facing by themselves.

#### KV Cache effect

None of its own. The consumers that add tool schemas and Session messages own those requests' cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Five fields, one minute** — there is no seconds field, so no rule can run more often than once a minute, and no Quartz `?`, `L`, `W`, or `#`.
- **A stepped single value runs to the field end** — `5/15` means `5,20,35,50`, the Vixie reading, not the single value `5`.
- **A delivery records admission, not the work** — a `completed` run means the framed message was admitted into its Session; the Agent's turn then runs under the Session's own lifecycle, so the run's record does not report how that turn ended.
- **A resumed target uses the composition's route** — a cold `session` target is resumed, and its Agent is composed by the deployment, so the Session's own logged model route is not re-installed; the resume needs the composition to state a default route.
- **A wake is coalesced, not replayed** — a wake that arrives after several occurrences produces one run and moves the stored occurrence past the wall clock. Only occurrences that passed with no scheduler running at all are what `misfirePolicy` decides.
- **Disposal does not await a run in flight** — it cancels the timer and awaits the drive; a run already started settles through its own record, so unloading never waits out a job's remaining ceiling.
- **`runNow` refuses while a run is in flight** — the caller asked for this instant, so the provider answers `cron_run_in_progress` instead of queueing behind the running one.
- **The search is bounded** — `nextCronOccurrence` walks `MAX_SEARCH_DAYS` days, which exceeds the eight-year gap a skipped century leap year creates, and answers `undefined` rather than searching forever.
- **Occurrences are computed on demand** — there is no index and no cache, so a caller that resolves the same expression repeatedly pays for it each time.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
