/**
 * Deployment configuration for the capability-hardening bundle.
 *
 * The rails are independent: each is off until its field names a value, and a
 * field that is present but unusable throws here. Omitting the field is
 * therefore the only way to disable a rail, so a misspelled key cannot pass as
 * an intentional omission.
 *
 * Four rails read written file content, so they share one `writeTools` list of
 * the deployment's writing tools. A deployment that turns any of them on
 * without naming that list throws at load: the tools, their path argument, and
 * their content argument are deployment choices this bundle cannot guess.
 *
 * @module prism-guardrails/config
 */

/**
 * One deployment tool that writes file content.
 *
 * `pathArgument` and `contentArgument` name the tool's own argument keys, so a
 * deployment whose writing tool calls them something else is configured rather
 * than special-cased.
 */
export interface WriteTool {
  /** The tool's registered name. */
  readonly tool: string
  /** The argument naming the written file's path. */
  readonly pathArgument: string
  /** The argument carrying the written text, for the rails that read it; omit when the tool has none. */
  readonly contentArgument?: string
}

/** Routing-contract settings: which calls count as leaving the read path. */
export interface RoutingContractConfig {
  /**
   * The tools that only read. The first call to any other tool is the routing
   * contract's trigger, so this list is the whole definition of "non-readonly".
   */
  readonly readOnlyTools: readonly string[]
}

/** Verification-gate settings: which calls count as producing evidence. */
export interface VerificationGateConfig {
  /** The tools whose successful call is accepted as a verification of the turn's writes. */
  readonly verifyTools: readonly string[]
}

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
  /** The deployment's file-writing tools; required by every rail that reads written content. */
  readonly writeTools?: readonly WriteTool[]
  /**
   * Distinct files one turn may write before the next new path goes to
   * approval. `0` (or an omitted field) leaves the rail off.
   */
  readonly maxWrittenFilesPerTurn?: number
  /** Whether a written `ponytail:` comment must name its ceiling and upgrade path. Defaults to `false`. */
  readonly requirePonytailUpgradePaths?: boolean
  /** File names whose write goes to approval as a dependency change; omit to disable this rail. */
  readonly dependencyManifests?: readonly string[]
  /** Whether the first non-readonly call of a session must follow a recorded routing decision; omit to disable this rail. */
  readonly routingContract?: RoutingContractConfig
  /** Whether a turn that wrote without verifying is sent back for evidence; omit to disable this rail. */
  readonly verificationGate?: VerificationGateConfig
}

/** One writing tool after load-time validation. */
export interface ResolvedWriteTool {
  readonly pathArgument: string
  readonly contentArgument: string | undefined
}

/** Configuration after load-time validation. `undefined` means the rail is off. */
export interface ResolvedConfig {
  readonly planDeniedTools: ReadonlySet<string> | undefined
  readonly repeatAskAfter: number | undefined
  readonly maxStepsPerTurn: number | undefined
  readonly skillInvocationGuidance: boolean
  readonly writeTools: ReadonlyMap<string, ResolvedWriteTool> | undefined
  readonly maxWrittenFilesPerTurn: number | undefined
  readonly requirePonytailUpgradePaths: boolean
  readonly dependencyManifests: ReadonlySet<string> | undefined
  readonly routingContract: ReadonlySet<string> | undefined
  readonly verificationGate: ReadonlySet<string> | undefined
}

/** Configuration keys this bundle reads; anything else is a typo and fails load. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'planDeniedTools',
  'repeatAskAfter',
  'maxStepsPerTurn',
  'skillInvocationGuidance',
  'writeTools',
  'maxWrittenFilesPerTurn',
  'requirePonytailUpgradePaths',
  'dependencyManifests',
  'routingContract',
  'verificationGate',
])

/** Keys one `writeTools` entry reads. */
const WRITE_TOOL_KEYS: ReadonlySet<string> = new Set(['tool', 'pathArgument', 'contentArgument'])

/** Keys `routingContract` reads. */
const ROUTING_CONTRACT_KEYS: ReadonlySet<string> = new Set(['readOnlyTools'])

/** Keys `verificationGate` reads. */
const VERIFICATION_GATE_KEYS: ReadonlySet<string> = new Set(['verifyTools'])

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
      + `{ ${[...KNOWN_KEYS].join(', ')} }`)
  }
  const writeTools = resolveWriteTools(config.writeTools)
  const maxWrittenFilesPerTurn = resolveMaxWrittenFilesPerTurn(config.maxWrittenFilesPerTurn)
  const requirePonytailUpgradePaths = resolveRequirePonytailUpgradePaths(config.requirePonytailUpgradePaths)
  const dependencyManifests = resolveDependencyManifests(config.dependencyManifests)
  const routingContract = resolveRoutingContract(config.routingContract)
  const verificationGate = resolveVerificationGate(config.verificationGate)

  // A rail that reads written content owns no tool knowledge of its own, so a
  // deployment that turns one on without the list has nothing to enforce
  // against. Fail here rather than loading a rail that can never fire.
  const needsWriteTools = maxWrittenFilesPerTurn !== undefined
    || requirePonytailUpgradePaths
    || dependencyManifests !== undefined
    || verificationGate !== undefined
  if (needsWriteTools && writeTools === undefined) {
    throw new Error('prism-guardrails: maxWrittenFilesPerTurn, requirePonytailUpgradePaths, '
      + 'dependencyManifests, and verificationGate all read written files — name writeTools as well')
  }
  if (requirePonytailUpgradePaths && !hasContentArgument(writeTools)) {
    throw new Error('prism-guardrails: requirePonytailUpgradePaths reads written text — at least one '
      + 'writeTools entry must name its contentArgument')
  }

  return {
    planDeniedTools: resolveDeniedTools(config.planDeniedTools),
    repeatAskAfter: resolveRepeatAskAfter(config.repeatAskAfter),
    maxStepsPerTurn: resolveMaxStepsPerTurn(config.maxStepsPerTurn),
    skillInvocationGuidance: resolveSkillInvocationGuidance(config.skillInvocationGuidance),
    writeTools,
    maxWrittenFilesPerTurn,
    requirePonytailUpgradePaths,
    dependencyManifests,
    routingContract,
    verificationGate,
  }
}

/** Whether any configured writing tool carries the text it writes. */
function hasContentArgument(writeTools: ReadonlyMap<string, ResolvedWriteTool> | undefined): boolean {
  if (writeTools === undefined) return false
  for (const tool of writeTools.values()) if (tool.contentArgument !== undefined) return true
  return false
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

/**
 * Check the writing-tool list into a lookup by tool name.
 *
 * The name is the key because every rail asks the same question — "is this
 * call a write, and if so which file and which text?" — and a duplicated name
 * would make the answer depend on position.
 */
function resolveWriteTools(value: readonly WriteTool[] | undefined): ReadonlyMap<string, ResolvedWriteTool> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error('prism-guardrails: writeTools must be an array of { tool, pathArgument, contentArgument? } entries')
  }
  const tools = new Map<string, ResolvedWriteTool>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`prism-guardrails: writeTools entries must be objects, received ${JSON.stringify(entry)}`)
    }
    const unknown = Object.keys(entry).filter(key => !WRITE_TOOL_KEYS.has(key))
    if (unknown.length > 0) {
      throw new Error(`prism-guardrails: unknown writeTools key(s) ${unknown.join(', ')} — an entry is `
        + `{ ${[...WRITE_TOOL_KEYS].join(', ')} }`)
    }
    const tool = entry.tool
    const pathArgument = entry.pathArgument
    if (typeof tool !== 'string' || tool.trim() === '') {
      throw new Error(`prism-guardrails: writeTools entries must name a tool, received ${JSON.stringify(tool)}`)
    }
    if (typeof pathArgument !== 'string' || pathArgument.trim() === '') {
      throw new Error(`prism-guardrails: writeTools entry "${tool}" must name its pathArgument`)
    }
    const contentArgument = entry.contentArgument
    if (contentArgument !== undefined && (typeof contentArgument !== 'string' || contentArgument.trim() === '')) {
      throw new Error(`prism-guardrails: writeTools entry "${tool}" must name a non-empty contentArgument or omit it`)
    }
    if (tools.has(tool)) {
      throw new Error(`prism-guardrails: writeTools names "${tool}" twice`)
    }
    tools.set(tool, { pathArgument, contentArgument })
  }
  if (tools.size === 0) {
    throw new Error('prism-guardrails: writeTools must not be empty — omit the key to disable the rails that read it')
  }
  return tools
}

/** Check the per-turn writing budget, mapping the explicit `0` off-switch to no rail. */
function resolveMaxWrittenFilesPerTurn(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`prism-guardrails: maxWrittenFilesPerTurn must be an integer >= 0, received ${String(value)}`)
  }
  return value === 0 ? undefined : value
}

/** Check the marker-discipline switch; it refuses a write, so it is off until named. */
function resolveRequirePonytailUpgradePaths(value: boolean | undefined): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') {
    throw new Error(`prism-guardrails: requirePonytailUpgradePaths must be a boolean, received ${JSON.stringify(value)}`)
  }
  return value
}

/** Check the dependency-manifest names; an empty list has no meaning, so it is an error rather than "off". */
function resolveDependencyManifests(value: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error('prism-guardrails: dependencyManifests must be an array of file names')
  }
  if (value.length === 0) {
    throw new Error('prism-guardrails: dependencyManifests must not be empty — omit the key to disable the dependency rail')
  }
  const names = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`prism-guardrails: dependencyManifests entries must be non-empty file names, received ${JSON.stringify(entry)}`)
    }
    if (names.has(entry)) {
      throw new Error(`prism-guardrails: dependencyManifests names "${entry}" twice`)
    }
    names.add(entry)
  }
  return names
}

/** Check the routing contract's read-only list; an empty list would refuse every call, so it is an error. */
function resolveRoutingContract(value: RoutingContractConfig | undefined): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('prism-guardrails: routingContract must be an object { readOnlyTools }')
  }
  const unknown = Object.keys(value).filter(key => !ROUTING_CONTRACT_KEYS.has(key))
  if (unknown.length > 0) {
    throw new Error(`prism-guardrails: unknown routingContract key(s) ${unknown.join(', ')} — it is `
      + `{ ${[...ROUTING_CONTRACT_KEYS].join(', ')} }`)
  }
  return resolveToolNameList(value.readOnlyTools, 'routingContract.readOnlyTools')
}

/** Check the verification gate's evidence list; an empty list accepts no evidence, so it is an error. */
function resolveVerificationGate(value: VerificationGateConfig | undefined): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('prism-guardrails: verificationGate must be an object { verifyTools }')
  }
  const unknown = Object.keys(value).filter(key => !VERIFICATION_GATE_KEYS.has(key))
  if (unknown.length > 0) {
    throw new Error(`prism-guardrails: unknown verificationGate key(s) ${unknown.join(', ')} — it is `
      + `{ ${[...VERIFICATION_GATE_KEYS].join(', ')} }`)
  }
  return resolveToolNameList(value.verifyTools, 'verificationGate.verifyTools')
}

/** Check a non-empty list of distinct, non-blank tool names. */
function resolveToolNameList(value: readonly string[] | undefined, label: string): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`prism-guardrails: ${label} must be a non-empty array of tool names`)
  }
  const names = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`prism-guardrails: ${label} entries must be non-empty tool names, received ${JSON.stringify(entry)}`)
    }
    if (names.has(entry)) {
      throw new Error(`prism-guardrails: ${label} names "${entry}" twice`)
    }
    names.add(entry)
  }
  return names
}
