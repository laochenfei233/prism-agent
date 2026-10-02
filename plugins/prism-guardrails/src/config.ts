/**
 * Deployment configuration for the capability-hardening bundle.
 *
 * The four rails are independent: each is off until its field names a value,
 * and a field that is present but unusable throws here. Omitting the field is
 * therefore the only way to disable a rail, so a misspelled key cannot pass as
 * an intentional omission.
 *
 * @module prism-guardrails/config
 */

/** Raw configuration as written in a profile patch row. */
export interface Config {
  /** Global tool names refused while plan mode is in force; omit to disable this rail. */
  readonly planDeniedTools?: readonly string[]
  /**
   * Consecutive identical calls tolerated before the next one goes to
   * approval. `0` (or an omitted field) leaves the rail off.
   */
  readonly repeatAskAfter?: number
  /** Steps one turn may open; omit to disable this rail. */
  readonly maxStepsPerTurn?: number
  /** Whether a user-only skill's model-invocation denial names the way forward. Defaults to `true`. */
  readonly skillInvocationGuidance?: boolean
}

/** Configuration after load-time validation. `undefined` means the rail is off. */
export interface ResolvedConfig {
  readonly planDeniedTools: ReadonlySet<string> | undefined
  readonly repeatAskAfter: number | undefined
  readonly maxStepsPerTurn: number | undefined
  readonly skillInvocationGuidance: boolean
}

/** Configuration keys this bundle reads; anything else is a typo and fails load. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'planDeniedTools',
  'repeatAskAfter',
  'maxStepsPerTurn',
  'skillInvocationGuidance',
])

/**
 * Validate deployment configuration.
 *
 * @param config - raw configuration from the profile patch row.
 * @returns the checked configuration with every rail's decision resolved.
 * @throws when a field is unusable or names an unknown key, so a
 * misconfiguration fails at plugin load instead of silently disabling a rail.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const unknown = Object.keys(config).filter(key => !KNOWN_KEYS.has(key))
  if (unknown.length > 0) {
    throw new Error(`prism-guardrails: unknown config key(s) ${unknown.join(', ')} — config is `
      + '{ planDeniedTools, repeatAskAfter, maxStepsPerTurn, skillInvocationGuidance }')
  }
  return {
    planDeniedTools: resolveDeniedTools(config.planDeniedTools),
    repeatAskAfter: resolveRepeatAskAfter(config.repeatAskAfter),
    maxStepsPerTurn: resolveMaxStepsPerTurn(config.maxStepsPerTurn),
    skillInvocationGuidance: resolveSkillInvocationGuidance(config.skillInvocationGuidance),
  }
}

/** Check the plan-mode denial list; an empty list has no meaning, so it is an error rather than "off". */
function resolveDeniedTools(value: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined
  // Profile YAML is outside the type system: these checks are the boundary.
  if (!Array.isArray(value)) {
    throw new Error('prism-guardrails: planDeniedTools must be an array of tool names')
  }
  if (value.length === 0) {
    throw new Error('prism-guardrails: planDeniedTools must not be empty — omit the key to disable the plan-mode rail')
  }
  const names = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`prism-guardrails: planDeniedTools entries must be non-empty tool names, received ${JSON.stringify(entry)}`)
    }
    if (names.has(entry)) {
      throw new Error(`prism-guardrails: planDeniedTools names "${entry}" twice`)
    }
    names.add(entry)
  }
  return names
}

/** Check the repeat threshold, mapping the explicit `0` off-switch to no rail. */
function resolveRepeatAskAfter(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`prism-guardrails: repeatAskAfter must be an integer >= 0, received ${String(value)}`)
  }
  if (value === 1) {
    throw new Error('prism-guardrails: repeatAskAfter must be 0 (off) or >= 2 — one call is not a loop')
  }
  return value === 0 ? undefined : value
}

/** Check the turn budget. The upper bound is a deployment policy, so the bundle supplies no default. */
function resolveMaxStepsPerTurn(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`prism-guardrails: maxStepsPerTurn must be an integer >= 1, received ${String(value)}`)
  }
  return value
}

/** Check the skill-guidance switch; a pure text improvement, so its default is on. */
function resolveSkillInvocationGuidance(value: boolean | undefined): boolean {
  if (value === undefined) return true
  if (typeof value !== 'boolean') {
    throw new Error(`prism-guardrails: skillInvocationGuidance must be a boolean, received ${JSON.stringify(value)}`)
  }
  return value
}
