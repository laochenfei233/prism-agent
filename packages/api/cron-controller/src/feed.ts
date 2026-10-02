/**
 * Reconnect-safe scheduled-task baseline and increment producer.
 *
 * Increments follow the `cron` domain's own commit events rather than polling a
 * clock, so a row appears once the write is durable. Two facts the domain event
 * does not carry decide a frame: a task this process has already published, and
 * a task whose identity was in the opening baseline — without that record, a
 * removal of the last task would publish nothing and a panel would keep the row.
 * @module @deepseek-ai/dsh-api-cron-controller/feed
 */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type { CronJob, CronJobId, CronRunOutcome, CronRunRecord } from '@deepseek-ai/dsh-cron'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { CronFollowBaseline, CronFollowFrame, CronJobView, CronTargetView } from './types.ts'

/** The domain the cron store opens under, and its single job table. */
const CRON_DOMAIN = 'cron'
const CRON_JOBS_TABLE = 'jobs'

/** The reason a follower serves no rows, stated in the same code its unary refusals use. */
const NOT_LEADER: CronFollowBaseline = {
  listError: {
    code: 'cron/not-leader',
    message: 'this process does not hold the cron scheduler lease',
  },
}

const RUN_OUTCOMES: readonly CronRunOutcome[] = ['completed', 'failed', 'timeout', 'blocked', 'interrupted']

/**
 * Project one stored task into its Remote value.
 * @param job - the authoritative stored record.
 * @returns a detached projection for Remote consumers.
 */
export function cronJobView(job: CronJob): CronJobView {
  return {
    jobId: job.id,
    expression: job.expression,
    timeZone: job.timeZone,
    enabled: job.enabled,
    target: cronTargetView(job),
    prompt: job.prompt,
    overlapPolicy: job.overlapPolicy,
    misfirePolicy: job.misfirePolicy,
    maxRunMs: job.maxRunMs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    nextDueAt: job.nextDueAt,
    recentRuns: job.recentRuns.map(run => ({ ...run })),
  }
}

function cronTargetView(job: CronJob): CronTargetView {
  return job.target.kind === 'session'
    ? { kind: 'session', sessionId: job.target.sessionId }
    : {
      kind: 'new-session',
      workspacePath: job.target.workspacePath,
      agentPreset: job.target.agentPreset,
      permissionPreset: job.target.permissionPreset,
      model: job.target.model === undefined ? null : { ...job.target.model },
    }
}

/** Owns scheduled-task domain observation and every active follow generation. */
export class CronFeed {
  private readonly followers = new Set<CronFollower>()
  /**
   * Identities this process has published to a generation.
   *
   * Empty until a baseline reports one, because construction must not require
   * leadership: a process that holds no lease still observes the domain and
   * still serves generations, and its generations say why they carry no rows.
   */
  private knownIds = new Set<string>()

  /** @param ctx - Host context carrying the authoritative `ctx.cron` capability. */
  constructor(private readonly ctx: Context) {
    ctx.on('domain/changed', (change: DomainChanged) => { this.changed(change) })
    ctx.effect(() => () => {
      // release mutates the set, so iterate a copy of it.
      for (const follower of [...this.followers]) this.release(follower)
    }, 'cron-controller.feed')
  }

  /**
   * Release one generation, whichever path ends it first: the reader returning
   * or the plugin's own unload. The follower leaves the set before it closes,
   * so no later publication can reach a closed queue.
   * @param follower - the generation to release.
   */
  private release(follower: CronFollower): void {
    this.followers.delete(follower)
    follower.close()
  }

  /**
   * Read the complete current projection, or the reason there is none.
   * @returns every stored task, or the leader refusal that replaces an empty list.
   */
  baseline(): CronFollowBaseline {
    // `list()` is the leadership report: the provider refuses with
    // `cron_not_leader` while it holds no store, and an empty list from a leader
    // is the only empty list that means "no tasks".
    let jobs: readonly CronJob[]
    try {
      jobs = this.ctx.cron.list()
    } catch (error: unknown) {
      const code = (error as { code?: unknown }).code
      // A refusal outside the leader code is not a state this stream can
      // report, so it reaches the Remote carrier as a failed generation.
      if (code !== 'cron_not_leader') throw error
      // The refusal replaces the rows this generation carries, and the known
      // identities stay as the last complete list left them: no baseline has
      // reported the current rows yet, so no removal is this feed's to report.
      return NOT_LEADER
    }
    this.knownIds = new Set(jobs.map(job => String(job.id)))
    return { items: jobs.map(cronJobView) }
  }

  /**
   * Open one generation beginning with a complete baseline.
   * @param signal - generation cancellation.
   * @returns the baseline followed by ordered stored-task increments.
   */
  async *follow(signal: AbortSignal): AsyncIterable<CronFollowFrame> {
    signal.throwIfAborted()
    const follower = new CronFollower()
    this.followers.add(follower)
    try {
      yield { type: 'baseline', value: this.baseline() }
      yield* follower.read(signal)
    } finally {
      this.release(follower)
    }
  }

  private changed(change: DomainChanged): void {
    if (change.domain !== CRON_DOMAIN || change.table !== CRON_JOBS_TABLE) return
    if (change.operation === 'deleted') {
      if (!this.knownIds.delete(change.key)) return
      this.publish({ type: 'remove', jobId: change.key as CronJobId })
      return
    }
    const job = narrowedJob(change.value)
    if (job === undefined) return
    this.knownIds.add(String(job.id))
    this.publish({ type: 'upsert', job: cronJobView(job) })
  }

  private publish(frame: CronFollowIncrement): void {
    for (const follower of this.followers) follower.push(frame)
  }
}

type CronFollowIncrement = Exclude<CronFollowFrame, { readonly type: 'baseline' }>

/**
 * Narrow one primary-keyed domain write into a stored task.
 *
 * A `domain/changed` payload reaches a subscriber as an untyped value, so the
 * write is read field by field rather than declared to be a record: a value that
 * states no identity or no rule is skipped instead of projected as a task the
 * panel would then edit under a fabricated identity.
 * @param value - the value the domain committed.
 * @returns the fields a projection needs, or `undefined` when the value is not one.
 */
function narrowedJob(value: unknown): CronJob | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const id = record['id']
  const expression = record['expression']
  const timeZone = record['timeZone']
  const target = narrowedTarget(record['target'])
  const bounds = narrowedBounds(record)
  if (typeof id !== 'string' || typeof expression !== 'string' || typeof timeZone !== 'string') return undefined
  if (target === undefined || bounds === undefined) return undefined
  return {
    version: 1,
    id: id as CronJobId,
    expression,
    timeZone,
    enabled: record['enabled'] === true,
    target,
    prompt: typeof record['prompt'] === 'string' ? record['prompt'] : '',
    overlapPolicy: record['overlapPolicy'] === 'queue-one' ? 'queue-one' : 'skip',
    misfirePolicy: record['misfirePolicy'] === 'run-once-late' ? 'run-once-late' : 'skip',
    ...bounds,
    recentRuns: narrowedRuns(record['recentRuns']),
  }
}

/**
 * The stored instants and run ceiling a projection needs.
 *
 * A value whose numbers are not the numbers a record states is refused rather
 * than defaulted: a substituted occurrence or ceiling would show the operator a
 * schedule the store never held, so the generation keeps its last good
 * projection and the refusal reaches the log instead.
 * @param record - the committed value read field by field.
 * @returns the four numbers, or `undefined` when any is not one this store can hold.
 */
function narrowedBounds(record: Record<string, unknown>): Pick<CronJob, 'createdAt' | 'updatedAt' | 'nextDueAt' | 'maxRunMs'> | undefined {
  const createdAt = record['createdAt']
  const updatedAt = record['updatedAt']
  const nextDueAt = record['nextDueAt']
  const maxRunMs = record['maxRunMs']
  if (!isSafeInteger(createdAt)) return undefined
  if (!isSafeInteger(updatedAt)) return undefined
  if (!isSafeInteger(nextDueAt)) return undefined
  if (!isSafeInteger(maxRunMs) || maxRunMs <= 0) return undefined
  return { createdAt, updatedAt, nextDueAt, maxRunMs }
}

function narrowedTarget(value: unknown): CronJob['target'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record['kind'] === 'session') {
    const sessionId = record['sessionId']
    return typeof sessionId === 'string' && sessionId !== '' ? { kind: 'session', sessionId } : undefined
  }
  if (record['kind'] !== 'new-session') return undefined
  const workspacePath = record['workspacePath']
  const agentPreset = record['agentPreset']
  const permissionPreset = record['permissionPreset']
  if (typeof workspacePath !== 'string' || typeof agentPreset !== 'string' || typeof permissionPreset !== 'string') {
    return undefined
  }
  const model = narrowedModel(record['model'])
  return {
    kind: 'new-session',
    workspacePath,
    agentPreset,
    permissionPreset,
    ...(model === undefined ? {} : { model }),
  }
}

function narrowedModel(value: unknown): { provider: string; model: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const provider = record['provider']
  const model = record['model']
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  return { provider, model }
}

/**
 * The bounded run history one projection carries.
 *
 * An entry that is not a run is dropped rather than defaulted, because a
 * fabricated duration would report work the store never recorded; an absent or
 * unusable history is simply empty.
 * @param value - the committed history value.
 * @returns the runs this store can state, oldest first as stored.
 */
function narrowedRuns(value: unknown): CronRunRecord[] {
  if (!Array.isArray(value)) return []
  const runs: CronRunRecord[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const startedAt = record['startedAt']
    const finishedAt = record['finishedAt']
    const outcome = record['outcome']
    if (!isSafeInteger(startedAt) || !isSafeInteger(finishedAt)) continue
    if (typeof outcome !== 'string' || !RUN_OUTCOMES.includes(outcome as CronRunOutcome)) continue
    runs.push({ startedAt, finishedAt, outcome: outcome as CronRunOutcome })
  }
  return runs
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/**
 * One generation's queued frames and its single waiting reader.
 *
 * The feed removes a follower from its set before closing it, so a push never
 * reaches a closed follower and this class carries no guard for that case.
 */
class CronFollower {
  private readonly frames = new Deque<CronFollowFrame>()
  private wake: (() => void) | undefined
  private closed = false

  push(frame: CronFollowFrame): void {
    this.frames.pushBack(frame)
    this.wake?.()
  }

  /** End this generation; repeated calls are inert. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.wake?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<CronFollowFrame> {
    while (!this.closed && !signal.aborted) {
      const frame = this.frames.popFront()
      if (frame !== undefined) {
        yield frame
        continue
      }
      // The queue was drained and both stop conditions tested immediately
      // above, and nothing runs in between, so this wakeup is the only thing
      // that can resume the reader.
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          this.wake = undefined
          signal.removeEventListener('abort', wake)
          resolve()
        }
        this.wake = wake
        signal.addEventListener('abort', wake, { once: true })
      })
    }
  }
}
