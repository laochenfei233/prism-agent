/**
 * The cron domain declaration: the durable layout one process's scheduler opens.
 *
 * The store is a workspace-independent domain rather than Session state, so a
 * job outlives every conversation it may touch. `version: 1` is a durable
 * commitment: the domain layer refuses a version it does not know instead of
 * migrating, so a later layout change needs its own migration decision.
 * @module @deepseek-ai/dsh-cron/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { cronJobSchema } from './records.ts'
import type { CronJob, CronJobId } from './types.ts'

/**
 * Domain-global state. `nextJobNumber` is the never-reused id allocator: a
 * deleted job's identity must not come back, so the counter only advances.
 */
export const cronDomainState = z.object({
  nextJobNumber: z.int().positive(),
})

/** Domain-global state inferred from {@link cronDomainState}. */
export type CronDomainState = z.infer<typeof cronDomainState>

/**
 * The cron domain spec: one `jobs` table keyed by {@link CronJobId} plus the id
 * allocator. Its record schema is the same strict schema the decoder applies, so
 * a value this domain opens and a value a reader decodes are held to one rule.
 */
export const cronDomainSpec = defineDomain({
  name: 'cron',
  version: 1,
  global: {
    schema: cronDomainState,
    initial: { nextJobNumber: 1 },
  },
  tables: { jobs: domainTable<CronJobId, CronJob>(cronJobSchema) },
})
