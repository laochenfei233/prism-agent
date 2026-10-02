/**
 * Browser-safe request, result, and state vocabulary for the scheduled-task
 * Remote namespace this package owns.
 *
 * A stored job reaches a browser as this decoded projection: the durable record's
 * `id` is a branded opaque identity, so the view states the identity as text and
 * the surface treats it as one. Every field a panel renders is carried here, and
 * nothing a panel must not decide — storage, leadership, or run state — is.
 * @module @deepseek-ai/dsh-api-cron-controller/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque identity of one scheduled task, as the durable store mints it.
 *
 * The brand is nominal typing only, so stating it here keeps the browser half
 * free of the cron package while a surface still cannot confuse a task identity
 * with any other text.
 */
export type CronJobId = Branded<'CronJobId'>

/** How one run ended. */
export type CronRunOutcome = 'completed' | 'failed' | 'timeout' | 'blocked' | 'interrupted'

/** One bounded record of a finished run. */
export interface CronRunRecord {
  /** Instant the run started. */
  readonly startedAt: number
  /** Instant the run settled. */
  readonly finishedAt: number
  /** How it settled. */
  readonly outcome: CronRunOutcome
}

/**
 * One task's destination, projected for a browser.
 *
 * The stored union declares an optional model selection, so the projected
 * `new-session` member carries it as a required nullable field: a surface tells
 * "the deployment default" from "this task named a model" without reading an
 * absent key.
 */
export type CronTargetView =
  | {
    readonly kind: 'new-session'
    /** Absolute directory each run's Session runs in. */
    readonly workspacePath: string
    /** Agent preset each run's Session is composed from. */
    readonly agentPreset: string
    /** Permission preset each run acts under. */
    readonly permissionPreset: string
    /** Provider and model named by the task, or `null` for the deployment default. */
    readonly model: { readonly provider: string; readonly model: string } | null
  }
  | {
    readonly kind: 'session'
    /** The Session every run continues. */
    readonly sessionId: string
  }

/** Where a task's run happens, as a management write states it. */
export type CronTarget = CronTargetView

/** One stored task projected for browser consumers. */
export interface CronJobView {
  /** Opaque task identity, never reused once removed. */
  readonly jobId: CronJobId
  /** The cron expression, as its author wrote it. */
  readonly expression: string
  /** The IANA zone the expression is stated in. */
  readonly timeZone: string
  /** Whether the scheduler may fire it. */
  readonly enabled: boolean
  /** Where a run happens. */
  readonly target: CronTargetView
  /** The message a fired run delivers. */
  readonly prompt: string
  /** Behavior when a run is still in flight at the next occurrence. */
  readonly overlapPolicy: 'skip' | 'queue-one'
  /** Behavior for occurrences missed while no scheduler ran. */
  readonly misfirePolicy: 'skip' | 'run-once-late'
  /** Positive ceiling on one run's duration, in milliseconds. */
  readonly maxRunMs: number
  /** Instant the task was created. */
  readonly createdAt: number
  /** Instant the task was last changed. */
  readonly updatedAt: number
  /** Earliest occurrence not yet dispatched. */
  readonly nextDueAt: number
  /** Most recent finished runs, oldest first. */
  readonly recentRuns: readonly CronRunRecord[]
}

/**
 * The scheduled-task state one follow generation opens with.
 *
 * A process that holds no scheduler lease reports `cron/not-leader` here rather
 * than an empty `items` list, because an empty list on a panel reads as "this
 * deployment has no tasks" — the one conclusion a follower cannot support.
 */
export type CronFollowBaseline =
  | { readonly items: readonly CronJobView[]; readonly listError?: undefined }
  | {
    readonly items?: undefined
    readonly listError: { readonly code: 'cron/not-leader'; readonly message: string }
  }

/** One decoded frame of a scheduled-task follow generation. */
export type CronFollowFrame =
  | { readonly type: 'baseline'; readonly value: CronFollowBaseline }
  | { readonly type: 'upsert'; readonly job: CronJobView }
  | { readonly type: 'remove'; readonly jobId: CronJobId }

/** Every increment frame: one generation's baseline is the only opening frame. */
export type CronFollowIncrement = Exclude<CronFollowFrame, { readonly type: 'baseline' }>

/**
 * The writes a surface may send, and the reads it receives back.
 *
 * `update` states only the changed fields, so an edit that leaves the rule alone
 * cannot postpone an occurrence already owed through a re-derived next time.
 */
export type CronViewCreateRequest = {
  readonly expression: string
  readonly timeZone: string
  readonly target: CronTarget
  readonly prompt: string
  readonly overlapPolicy?: 'skip' | 'queue-one'
  readonly misfirePolicy?: 'skip' | 'run-once-late'
  readonly maxRunMs?: number
}

/** The fields one edit may replace; each replaces what is stored. */
export interface CronViewUpdateRequest {
  /** Target task identity. */
  readonly jobId: CronJobId
  /** Replacement expression. */
  readonly expression?: string
  /** Replacement IANA zone. */
  readonly timeZone?: string
  /** Replacement destination. */
  readonly target?: CronTarget
  /** Replacement delivered message. */
  readonly prompt?: string
  /** Replacement overlap behavior. */
  readonly overlapPolicy?: 'skip' | 'queue-one'
  /** Replacement misfire behavior. */
  readonly misfirePolicy?: 'skip' | 'run-once-late'
  /** Replacement run-duration ceiling, in milliseconds. */
  readonly maxRunMs?: number
  /** Replacement enabled state. */
  readonly enabled?: boolean
}

/** Target one task for a management write. */
export interface CronViewJobRequest {
  /**
   * The task identity to address. The wire cannot carry the durable brand, so
   * the method that reaches the store brands it at that boundary.
   */
  readonly jobId: string
}

/** The successful result of a management write. */
export interface CronViewValue {
  /** The stored task after the write. */
  readonly job: CronJobView
}

/** The result of a `runNow`, which changes no stored schedule. */
export interface CronViewRunNowValue {
  /** The finished run's bounded record. */
  readonly run: CronRunRecord
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The expression is not one this build's grammar admits. */
    'cron/invalid-expression': {}
    /** The named zone is not an IANA zone this platform resolves. */
    'cron/invalid-time-zone': {}
    /** No task is stored under the named identity. */
    'cron/not-found': {}
    /** Another process holds the scheduler lease, so this one answers for no tasks. */
    'cron/not-leader': {}
    /** The task already has a run in flight. */
    'cron/run-in-progress': {}
  }
}
