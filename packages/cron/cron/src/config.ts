/**
 * Plugin config for the cron capability, and the explicit resolution step that
 * turns it into the values the plugin uses.
 *
 * Resolution is a step of its own because a schemastery default applies only
 * when config passes through the Loader: an in-process caller that builds the
 * config object directly would otherwise carry `undefined` into the plugin,
 * which is a hidden fallback rather than a stated one.
 * @module @deepseek-ai/dsh-cron/config
 */

import z from '@deepseek-ai/schemastery'

/** Delay a follower waits before retrying leadership when the deployment states none. */
const DEFAULT_LEADER_RETRY_MS = 30_000

/** Finished runs each job keeps when the deployment states none. */
const DEFAULT_MAX_RUNS_PER_JOB = 20

/** Ceiling on one run when the creating caller states none. */
const DEFAULT_MAX_RUN_MS = 600_000

/**
 * Plugin config as a deployment states it in `cordis.yml`.
 *
 * Every field is a deployment choice, so none of them is decided inside the
 * plugin; the two optional ones carry a schema default and are still resolved
 * explicitly by {@link resolveCronConfig}.
 */
export interface Config {
  /**
   * Path of the leadership lock file.
   *
   * Required, and deliberately not defaulted: a default could point somewhere
   * other than the deployment's configured storage root, and two deployments
   * would then each believe they lead while sharing one domain.
   */
  leaderLockPath: string
  /** Delay before a follower retries leadership, in milliseconds. */
  leaderRetryMs?: number
  /** Finished runs each job keeps; older runs are dropped as new ones land. */
  maxRunsPerJob?: number
  /** Ceiling on one run, in milliseconds, when the creating caller states none. */
  defaultMaxRunMs?: number
}

/**
 * The declared config schema: the Loader validates a deployment against it.
 *
 * The input type is partial because that is what a deployment actually states:
 * the required fields are required of the *output*, and the schema is what
 * refuses a config that omits them. Declaring the required fields as required
 * input would describe a caller that cannot exist and would make the refusal
 * unreachable from a typed call.
 */
export const Config: z<Partial<Config>, Config> = z.object({
  leaderLockPath: z.string().min(1).required(),
  leaderRetryMs: z.natural().min(1).default(DEFAULT_LEADER_RETRY_MS),
  maxRunsPerJob: z.natural().min(1).default(DEFAULT_MAX_RUNS_PER_JOB),
  defaultMaxRunMs: z.natural().min(1).default(DEFAULT_MAX_RUN_MS),
})

/** The config after every default is stated, which is what the plugin uses. */
export interface CronConfig {
  /** Path of the leadership lock file. */
  readonly leaderLockPath: string
  /** Delay before a follower retries leadership, in milliseconds. */
  readonly leaderRetryMs: number
  /** Finished runs each job keeps. */
  readonly maxRunsPerJob: number
  /** Ceiling on one run when the creating caller states none, in milliseconds. */
  readonly defaultMaxRunMs: number
}

/**
 * Resolve the validated plugin config into the values the plugin uses.
 * @param config - the config the Loader validated, or the caller built directly.
 * @returns every field, with each default stated rather than applied later.
 */
export function resolveCronConfig(config: Config): CronConfig {
  return {
    leaderLockPath: config.leaderLockPath,
    leaderRetryMs: config.leaderRetryMs ?? DEFAULT_LEADER_RETRY_MS,
    maxRunsPerJob: config.maxRunsPerJob ?? DEFAULT_MAX_RUNS_PER_JOB,
    defaultMaxRunMs: config.defaultMaxRunMs ?? DEFAULT_MAX_RUN_MS,
  }
}
