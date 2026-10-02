/**
 * Strict decoding of one stored Cron job.
 *
 * A stored record is a durable boundary: it was written by an earlier process
 * and may be read by a later one, so every field is validated here rather than
 * trusted. The shape check rejects unknown keys, unknown versions, and unknown
 * union members, and the checks that follow reject a record whose text no
 * longer means anything — an expression that stopped parsing, a zone the
 * platform no longer resolves, or a run history that runs backwards.
 * @module @deepseek-ai/dsh-cron/records
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { canonicalClientTimeZone, MAX_FOUR_DIGIT_YEAR_MS, MIN_FOUR_DIGIT_YEAR_MS } from '@deepseek-ai/dsh-util-time'
import { parseCronExpression } from './expression.ts'
import type { CronJob, CronJobId } from './types.ts'

/** The only durable record version this decoder admits. */
export const CRON_RECORD_VERSION = 1

/** A stored job that this decoder refuses. */
export class CronRecordError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'corrupt_cron_record' as const

  /**
   * @param reason - what makes the stored value unusable.
   */
  constructor(reason: string) {
    super(reason)
    this.name = 'CronRecordError'
  }
}

const modelSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
})

const targetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('new-session'),
    workspacePath: z.string().min(1),
    agentPreset: z.string().min(1),
    permissionPreset: z.string().min(1),
    model: modelSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('session'),
    sessionId: z.string().min(1),
  }),
])

const runSchema = z.strictObject({
  startedAt: z.int(),
  finishedAt: z.int(),
  outcome: z.enum(['completed', 'failed', 'timeout', 'blocked', 'interrupted']),
})

/**
 * The stored shape of one job, as a strict schema. Exported for the storage
 * domain, which validates every value it opens through the same rules.
 */
export const cronJobSchema = z.strictObject({
  version: z.literal(CRON_RECORD_VERSION),
  // Branding has no runtime representation, so the transform is what lets this
  // schema be the storage table's schema and this decoder's shape check at once.
  id: z.string().min(1).transform(value => brandString<CronJobId>(value)),
  expression: z.string().min(1),
  timeZone: z.string().min(1),
  enabled: z.boolean(),
  target: targetSchema,
  prompt: z.string().min(1),
  overlapPolicy: z.enum(['skip', 'queue-one']),
  misfirePolicy: z.enum(['skip', 'run-once-late']),
  maxRunMs: z.int().positive(),
  createdAt: z.int(),
  updatedAt: z.int(),
  nextDueAt: z.int(),
  recentRuns: z.array(runSchema),
})

/**
 * Decode one stored job, or refuse it.
 * @param value - the decoded JSON value read from storage.
 * @returns the job, usable as durable truth.
 * @throws {CronRecordError} when the shape or the semantics of the record are unusable.
 */
export function decodeStoredCronJob(value: unknown): CronJob {
  const parsed = cronJobSchema.safeParse(value)
  if (!parsed.success) {
    // Every reported issue is listed, because a hand-edited record can be wrong
    // in more than one place and the reader needs all of them at once.
    const detail = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new CronRecordError(`stored job is not a valid record — ${detail}`)
  }
  const job = parsed.data
  // The expression is stored as text so a reader re-derives its meaning; that
  // only works while the text still parses under this build's grammar.
  try {
    parseCronExpression(job.expression)
  } catch (error: unknown) {
    throw new CronRecordError(`stored expression no longer parses: ${(error as Error).message}`)
  }
  if (canonicalClientTimeZone(job.timeZone) === undefined) {
    throw new CronRecordError('stored time zone is not an IANA zone this platform resolves')
  }
  if (job.updatedAt < job.createdAt) throw new CronRecordError('stored job was updated before it was created')
  if (job.nextDueAt < MIN_FOUR_DIGIT_YEAR_MS || job.nextDueAt > MAX_FOUR_DIGIT_YEAR_MS) {
    throw new CronRecordError('stored next occurrence is outside the representable range')
  }
  let previous = Number.NEGATIVE_INFINITY
  for (const run of job.recentRuns) {
    if (run.finishedAt < run.startedAt) throw new CronRecordError('stored run finished before it started')
    if (run.startedAt < previous) throw new CronRecordError('stored run history is not in ascending order')
    previous = run.startedAt
  }
  return job
}
