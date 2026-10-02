/**
 * Pure derivations the scheduled-task panel renders: a row's time, duration,
 * and the draft a form edits.
 *
 * Nothing here reads the browser zone, the process zone, or a stored record's
 * meaning beyond the fields it states, so a rendered row is a function of the
 * published projection and the viewer's locale alone.
 * @module @deepseek-ai/dsh-client-ui-cron/logic
 */

import type { CronJobId, CronJobView, CronRunOutcome, CronRunRecord, CronTargetView } from '@deepseek-ai/dsh-api-cron-controller/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'

/** One run's display facts, derived from its bounded record. */
export interface CronRunSummary {
  /** How the run settled. */
  readonly outcome: CronRunOutcome
  /** Instant the run settled. */
  readonly finishedAt: number
  /** How long the run took, in milliseconds. */
  readonly durationMs: number
}

/**
 * Summarize one stored run.
 * @param record - the bounded durable record.
 * @returns its outcome, settle instant, and duration.
 */
export function runSummary(record: CronRunRecord): CronRunSummary {
  return {
    outcome: record.outcome,
    finishedAt: record.finishedAt,
    // A record whose finish precedes its start is not a duration a row can
    // show, so the panel clamps instead of rendering a negative span.
    durationMs: Math.max(0, record.finishedAt - record.startedAt),
  }
}

/**
 * Render one run's duration in at most two adjacent units.
 * @param durationMs - the run's length in milliseconds.
 * @param t - the panel's namespace translator.
 * @returns the localized duration.
 */
export function formatDuration(durationMs: number, t: TranslateNS<typeof NS>): string {
  const total = Math.max(0, Math.floor(durationMs / 1_000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3_600)
  if (hours > 0) return t('duration.hours', { hours, minutes })
  if (minutes > 0) return t('duration.minutes', { minutes, seconds })
  return t('duration.seconds', { seconds })
}

/**
 * Render an instant in the zone its task states.
 * @param epochMs - the instant.
 * @param timeZone - the IANA zone the task is stated in.
 * @param locale - the viewer's locale, absent for the browser default.
 * @returns the localized date and time.
 */
export function formatInZone(epochMs: number, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(epochMs)
}

/** The editable fields of one task, as the panel's form holds them. */
export interface CronDraft {
  /** The task being edited, or `undefined` while the form creates one. */
  readonly jobId: CronJobId | undefined
  readonly expression: string
  readonly timeZone: string
  readonly prompt: string
  readonly targetKind: CronTargetView['kind']
  readonly workspacePath: string
  readonly agentPreset: string
  readonly permissionPreset: string
  readonly sessionId: string
  readonly maxRunMs: string
  readonly overlapPolicy: CronJobView['overlapPolicy']
  readonly misfirePolicy: CronJobView['misfirePolicy']
}

/**
 * The browser's own zone, which every new draft is stated in.
 * @returns the IANA zone the platform resolves for this viewer.
 */
export function viewerTimeZone(): string {
  // The platform type states a zone, so there is no fallback to take here: a
  // host that broke that contract would state a blank zone, and the capability
  // refuses that loudly as `cron_invalid_time_zone` rather than running the
  // task in a zone the operator never chose.
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * The draft that creates a task, stated in the viewer's own zone.
 * @param workspacePath - the directory a new Session should run in, when the opener knows one.
 * @returns the empty draft.
 */
export function newDraft(workspacePath = ''): CronDraft {
  return {
    jobId: undefined,
    expression: '',
    timeZone: viewerTimeZone(),
    prompt: '',
    targetKind: 'new-session',
    workspacePath,
    agentPreset: '',
    permissionPreset: '',
    sessionId: '',
    maxRunMs: '',
    overlapPolicy: 'skip',
    misfirePolicy: 'skip',
  }
}

/**
 * The draft that edits one stored task.
 * @param job - the task being edited.
 * @returns its editable fields, with numbers stated as the form's text.
 */
export function draftFor(job: CronJobView): CronDraft {
  const target = job.target
  return {
    jobId: job.jobId,
    expression: job.expression,
    timeZone: job.timeZone,
    prompt: job.prompt,
    targetKind: target.kind,
    workspacePath: target.kind === 'new-session' ? target.workspacePath : '',
    agentPreset: target.kind === 'new-session' ? target.agentPreset : '',
    permissionPreset: target.kind === 'new-session' ? target.permissionPreset : '',
    sessionId: target.kind === 'session' ? target.sessionId : '',
    maxRunMs: String(job.maxRunMs),
    overlapPolicy: job.overlapPolicy,
    misfirePolicy: job.misfirePolicy,
  }
}

/** One create or edit request, as the Remote namespace states it. */
export interface CronDraftRequest {
  readonly jobId?: CronJobId
  readonly expression: string
  readonly timeZone: string
  readonly prompt: string
  readonly target: CronTargetView
  readonly maxRunMs?: number
  readonly overlapPolicy: CronJobView['overlapPolicy']
  readonly misfirePolicy: CronJobView['misfirePolicy']
}

/**
 * Turn one draft into the request its surface sends.
 *
 * A blank run ceiling states nothing, so the capability's own default stays in
 * force instead of a fabricated number becoming the stored bound.
 * @param draft - the form's fields.
 * @returns the create or update request.
 */
export function draftRequest(draft: CronDraft): CronDraftRequest {
  const target: CronTargetView = draft.targetKind === 'session'
    ? { kind: 'session', sessionId: draft.sessionId.trim() }
    : {
      kind: 'new-session',
      workspacePath: draft.workspacePath.trim(),
      agentPreset: draft.agentPreset.trim(),
      permissionPreset: draft.permissionPreset.trim(),
      model: null,
    }
  const maxRunMs = draft.maxRunMs.trim()
  return {
    ...draft.jobId === undefined ? {} : { jobId: draft.jobId },
    expression: draft.expression.trim(),
    timeZone: draft.timeZone.trim(),
    prompt: draft.prompt,
    target,
    ...maxRunMs === '' ? {} : { maxRunMs: Number(maxRunMs) },
    overlapPolicy: draft.overlapPolicy,
    misfirePolicy: draft.misfirePolicy,
  }
}
