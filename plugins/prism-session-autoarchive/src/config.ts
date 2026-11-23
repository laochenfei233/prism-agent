/**
 * Deployment config for the idle-conversation archive sweep.
 *
 * Every field is `.volatile()`, so the Loader keeps handing the plugin the same
 * references and commits an edited value into them without remounting the
 * fiber. A field therefore reaches the sweep as a {@link Volatile} reference,
 * and {@link resolveConfig} reads through it: caching a value at load would
 * freeze the window the Settings page is meant to change.
 * @module prism-session-autoarchive/config
 */

import { isVolatile } from '@deepseek-ai/cosmokit'
import type { Volatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'

/** Whether a sweep archives anything when the deployment states none. */
const DEFAULT_ENABLED = false

/** Days of inactivity after which a conversation is archived when the deployment states none. */
const DEFAULT_IDLE_DAYS = 30

/** Days of total inactivity after which an idle project is archived when the deployment states none. */
const DEFAULT_PROJECT_IDLE_DAYS = 14

/** Whether the default Workspace may be archived when the deployment states none. */
const DEFAULT_INCLUDE_DEFAULT_WORKSPACE = false

/** Minutes between sweeps when the deployment states none. */
const DEFAULT_SWEEP_INTERVAL_MINUTES = 1_440

/**
 * The config as the Loader delivers it.
 *
 * The schema output wraps every field in a {@link Volatile} reference; a caller
 * that builds the object directly (a test, another in-process composition) may
 * state plain values instead, which the same readers accept.
 */
export interface Config {
  /**
   * Whether a sweep archives anything; `false` (the default) keeps the plugin
   * mounted and idle. Automatic hygiene is opt-in: the Settings page generated
   * from the schema carries the switch.
   */
  enabled?: Volatile<boolean> | boolean
  /** Days without dialogue after which a top-level conversation joins the archive set. */
  idleDays?: Volatile<number> | number
  /**
   * Days without any conversation write after which a project holding no
   * visible conversation joins the Workspace archive set. With the
   * conversation window at 7 this reads as 7+7: the conversation archives on
   * day 7, the project on day 14.
   */
  projectIdleDays?: Volatile<number> | number
  /**
   * Whether the default Workspace may join the archive set when it idles.
   * `false` (the default) keeps the first-use Workspace permanently visible;
   * the sweep never hides or restores it.
   */
  includeDefaultWorkspace?: Volatile<boolean> | boolean
  /** Minutes between sweeps. The first sweep runs shortly after the plugin loads. */
  sweepIntervalMinutes?: Volatile<number> | number
}

/**
 * The declared config schema: the Loader validates a deployment against it, and
 * the Settings page generated from it edits every field live.
 */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_ENABLED)
    .description('Archive idle conversations and projects automatically (off by default)').volatile(),
  idleDays: z.natural().min(1).max(3_650).default(DEFAULT_IDLE_DAYS)
    .description('Days without dialogue before a conversation is archived').volatile(),
  projectIdleDays: z.natural().min(1).max(3_650).default(DEFAULT_PROJECT_IDLE_DAYS)
    .description('Days without any conversation write before an idle project is archived').volatile(),
  includeDefaultWorkspace: z.boolean().default(DEFAULT_INCLUDE_DEFAULT_WORKSPACE)
    .description('Allow archiving the default Workspace when it idles').volatile(),
  sweepIntervalMinutes: z.natural().min(5).max(10_080).default(DEFAULT_SWEEP_INTERVAL_MINUTES)
    .description('Minutes between archive sweeps').volatile(),
})

/** The config after every default is stated, which is what the sweep uses. */
export interface ResolvedConfig {
  /** Whether a sweep archives anything. */
  readonly enabled: boolean
  /** Whether the default Workspace may join the archive set. */
  readonly includeDefaultWorkspace: boolean
  /** Days without dialogue after which a conversation joins the archive set. */
  readonly idleDays: number
  /** Days without any conversation write after which an idle project joins the Workspace archive set. */
  readonly projectIdleDays: number
  /** Minutes between sweeps. */
  readonly sweepIntervalMinutes: number
}

/**
 * Read one config field at its current value.
 * @param field - a volatile reference the Loader commits into, or a plain value.
 * @param fallback - the value to use when the deployment stated none.
 * @returns the value the field holds now.
 */
function read<T>(field: Volatile<T> | T | undefined, fallback: T): T {
  if (field === undefined) return fallback
  return isVolatile(field) ? field.get() as T : field
}

/**
 * Resolve the validated config into the values the sweep uses.
 *
 * Called once per sweep rather than once at load: a volatile edit commits into
 * the same references, so a cached resolution would ignore the Settings page.
 * @param config - the config the Loader validated, or the caller built directly.
 * @returns every field, with each default stated rather than applied later.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    enabled: read(config.enabled, DEFAULT_ENABLED),
    idleDays: read(config.idleDays, DEFAULT_IDLE_DAYS),
    projectIdleDays: read(config.projectIdleDays, DEFAULT_PROJECT_IDLE_DAYS),
    includeDefaultWorkspace: read(config.includeDefaultWorkspace, DEFAULT_INCLUDE_DEFAULT_WORKSPACE),
    sweepIntervalMinutes: read(config.sweepIntervalMinutes, DEFAULT_SWEEP_INTERVAL_MINUTES),
  }
}
