/**
 * Cron record vocabulary: the durable shape of one scheduled task and the codes
 * its consumers report.
 *
 * Types only. The strict decoding that admits a stored value lives in
 * {@link ./records.ts}.
 * @module @deepseek-ai/dsh-cron/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque identity of one scheduled task, minted by the store that owns it. */
export type CronJobId = Branded<'CronJobId'>

/** The provider and model a `new-session` task's run uses. */
export interface CronModelSelection {
  readonly provider: string
  readonly model: string
}

/** A task whose every run creates its own Session. */
export interface CronNewSessionTarget {
  readonly kind: 'new-session'
  /** Absolute directory the created Session runs in. */
  readonly workspacePath: string
  /** Agent preset the created Session is composed from. */
  readonly agentPreset: string
  /** Permission preset the unattended run acts under. */
  readonly permissionPreset: string
  /** Provider and model for the run, when it must differ from the deployment default. */
  readonly model?: CronModelSelection | undefined
}

/** A task whose runs continue one existing Session. */
export interface CronExistingSessionTarget {
  readonly kind: 'session'
  /** The Session every run continues; resumed only while it is cold. */
  readonly sessionId: string
}

/** Where a task's run happens. */
export type CronTarget = CronNewSessionTarget | CronExistingSessionTarget

/** What happens when a run is still in flight as its next occurrence arrives. */
export type CronOverlapPolicy = 'skip' | 'queue-one'

/** What happens to occurrences that passed while no scheduler was running. */
export type CronMisfirePolicy = 'skip' | 'run-once-late'

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

/** One durable scheduled task. */
export interface CronJob {
  /** Durable record version; the decoder rejects any other. */
  readonly version: 1
  /** Opaque task identity. */
  readonly id: CronJobId
  /** The cron expression, kept as written so a reader re-derives its meaning. */
  readonly expression: string
  /** The IANA zone the expression is stated in. */
  readonly timeZone: string
  /** Whether the scheduler may fire it. */
  readonly enabled: boolean
  /** Where a run happens. */
  readonly target: CronTarget
  /** The message a fired run delivers. */
  readonly prompt: string
  /** Behavior when a run is still in flight at the next occurrence. */
  readonly overlapPolicy: CronOverlapPolicy
  /** Behavior for occurrences missed while no scheduler ran. */
  readonly misfirePolicy: CronMisfirePolicy
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
 * The closed set of codes a consumer reports for an expected failure. A refusal
 * outside this set is a defect, not a state a caller should branch on.
 *
 * Every code names a state this package can reach: a domain write is durable
 * when it resolves, so there is no "written but not durable" answer to report.
 */
export type CronErrorCode =
  | 'cron_invalid_expression'
  | 'cron_invalid_time_zone'
  | 'cron_not_found'
  | 'cron_not_leader'
  | 'cron_run_in_progress'
