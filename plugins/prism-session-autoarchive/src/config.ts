/**
 * Deployment config for the idle-conversation archive sweep.
 *
 * Every field carries a schema default and is still resolved explicitly by
 * {@link resolveConfig}: a schemastery default applies only when config passes
 * through the Loader, and an in-process caller that builds the object directly
 * would otherwise carry `undefined` into the sweep.
 * @module prism-session-autoarchive/config
 */

import z from '@deepseek-ai/schemastery'

/** Days of inactivity after which a conversation is archived when the deployment states none. */
const DEFAULT_IDLE_DAYS = 30

/** Minutes between sweeps when the deployment states none. */
const DEFAULT_SWEEP_INTERVAL_MINUTES = 1_440

/** The config as a deployment states it in `cordis.yml`. */
export interface Config {
  /** Whether a sweep archives anything; `false` keeps the plugin mounted and idle. */
  enabled?: boolean
  /** Days without dialogue after which a top-level conversation joins the archive set. */
  idleDays?: number
  /** Minutes between sweeps. The first sweep runs shortly after the plugin loads. */
  sweepIntervalMinutes?: number
}

/**
 * The declared config schema: the Loader validates a deployment against it, and
 * the Settings page generated from it edits every field without a restart.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('Archive idle conversations automatically').volatile(),
  idleDays: z.natural().min(1).max(3_650).default(DEFAULT_IDLE_DAYS)
    .description('Days without dialogue before a conversation is archived').volatile(),
  sweepIntervalMinutes: z.natural().min(5).max(10_080).default(DEFAULT_SWEEP_INTERVAL_MINUTES)
    .description('Minutes between archive sweeps').volatile(),
})

/** The config after every default is stated, which is what the sweep uses. */
export interface ResolvedConfig {
  /** Whether a sweep archives anything. */
  readonly enabled: boolean
  /** Days without dialogue after which a conversation joins the archive set. */
  readonly idleDays: number
  /** Minutes between sweeps. */
  readonly sweepIntervalMinutes: number
}

/**
 * Resolve the validated config into the values the sweep uses.
 * @param config - the config the Loader validated, or the caller built directly.
 * @returns every field, with each default stated rather than applied later.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    enabled: config.enabled ?? true,
    idleDays: config.idleDays ?? DEFAULT_IDLE_DAYS,
    sweepIntervalMinutes: config.sweepIntervalMinutes ?? DEFAULT_SWEEP_INTERVAL_MINUTES,
  }
}
