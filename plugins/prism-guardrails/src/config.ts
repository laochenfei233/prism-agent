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

import { createHash } from 'node:crypto'

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

/**
 * One deployment tool that reads a file's content.
 *
 * `pathArgument` names the tool's own argument key, so a deployment whose
 * reading tool calls it something else is configured rather than special-cased.
 */
export interface ReadTool {
  /** The tool's registered name. */
  readonly tool: string
  /** The argument naming the read file's path. */
  readonly pathArgument: string
}

/** One deployment tool whose call carries a command line. */
export interface CommandTool {
  /** The tool's registered name. */
  readonly tool: string
  /** The argument carrying the command text. */
  readonly commandArgument: string
}

/**
 * One guarded command.
 *
 * `pattern` is a regular expression source matched case-insensitively against
 * the raw command text; `reason` is what an approver reads.
 */
export interface CommandRule {
  /** Regular expression source the command text is matched against. */
  readonly pattern: string
  /** Why this command is guarded, in terms of what it would do. */
  readonly reason: string
}

/** Command-guard settings: which calls carry a command, and which commands are guarded. */
export interface CommandGuardConfig {
  /** The tools whose command text is matched. */
  readonly tools: readonly CommandTool[]
  /** The patterns a command is matched against. */
  readonly deny: readonly CommandRule[]
}

/** One guarded command after load-time validation. */
export interface ResolvedCommandRule {
  /** The compiled pattern, matched case-insensitively. */
  readonly pattern: RegExp
  /** The source the deployment wrote, reported in the approval reason. */
  readonly source: string
  /** Why this command is guarded. */
  readonly reason: string
}

/** The command-guard rail after load-time validation. */
export interface ResolvedCommandGuard {
  /** The tool name to its command argument. */
  readonly tools: ReadonlyMap<string, string>
  /** The patterns a command is matched against, in configuration order. */
  readonly rules: readonly ResolvedCommandRule[]
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

/**
 * How the rails' decisions are applied.
 *
 * `observe` records what a rail would have refused, or sent to approval, and
 * lets the call through: it is how a deployment reads a rail's reach before
 * arming it. It downgrades `deny` and `ask` only — a steer is a request to
 * finish work, not a refusal, so observing never weakens it.
 */
export type Mode = 'enforce' | 'observe'

/** Raw configuration as written in a profile patch row. */
export interface Config {
  /** How `deny` and `ask` decisions are applied; defaults to `enforce`. */
  readonly mode?: Mode
  /** Global tool names refused while plan mode is in force; omit to disable this rail. */
  readonly planDeniedTools?: readonly string[]
  /**
   * Consecutive identical calls tolerated before the next one goes to
   * approval. `0` (or an omitted field) leaves the rail off.
   */
  readonly repeatAskAfter?: number
  /** Steps one turn may open; omit to disable this rail. */
  readonly maxStepsPerTurn?: number
  /**
   * Times one turn may be sent back because the agent's own todo list still
   * holds unfinished items. `0` (or an omitted field) leaves the rail off.
   */
  readonly unfinishedTodoContinuations?: number
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
  /** The deployment's file-reading tools, whose paths the sensitive-read rail matches. */
  readonly readTools?: readonly ReadTool[]
  /** Path segments treated as credential material; omit to disable the sensitive-read rail. */
  readonly sensitivePaths?: readonly string[]
  /** Whether a shell command matching a guarded pattern goes to approval; omit to disable this rail. */
  readonly commandGuard?: CommandGuardConfig
}

/** One writing tool after load-time validation. */
export interface ResolvedWriteTool {
  readonly pathArgument: string
  readonly contentArgument: string | undefined
}

/** Configuration after load-time validation. `undefined` means the rail is off. */
export interface ResolvedConfig {
  readonly mode: Mode
  readonly planDeniedTools: ReadonlySet<string> | undefined
  readonly repeatAskAfter: number | undefined
  readonly maxStepsPerTurn: number | undefined
  readonly unfinishedTodoContinuations: number | undefined
  readonly skillInvocationGuidance: boolean
  readonly writeTools: ReadonlyMap<string, ResolvedWriteTool> | undefined
  readonly maxWrittenFilesPerTurn: number | undefined
  readonly requirePonytailUpgradePaths: boolean
  readonly dependencyManifests: ReadonlySet<string> | undefined
  readonly routingContract: ReadonlySet<string> | undefined
  readonly verificationGate: ReadonlySet<string> | undefined
  readonly readTools: ReadonlyMap<string, string> | undefined
  readonly sensitivePaths: readonly string[] | undefined
  readonly commandGuard: ResolvedCommandGuard | undefined
}

/** Configuration keys this bundle reads; anything else is a typo and fails load. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'mode',
  'planDeniedTools',
  'repeatAskAfter',
  'maxStepsPerTurn',
  'unfinishedTodoContinuations',
  'skillInvocationGuidance',
  'writeTools',
  'maxWrittenFilesPerTurn',
  'requirePonytailUpgradePaths',
  'dependencyManifests',
  'routingContract',
  'verificationGate',
  'readTools',
  'sensitivePaths',
  'commandGuard',
])

/** Keys one `writeTools` entry reads. */
const WRITE_TOOL_KEYS: ReadonlySet<string> = new Set(['tool', 'pathArgument', 'contentArgument'])

/** Keys `routingContract` reads. */
const ROUTING_CONTRACT_KEYS: ReadonlySet<string> = new Set(['readOnlyTools'])

/** Keys `verificationGate` reads. */
const VERIFICATION_GATE_KEYS: ReadonlySet<string> = new Set(['verifyTools'])

/** Keys one `readTools` entry reads. */
const READ_TOOL_KEYS: ReadonlySet<string> = new Set(['tool', 'pathArgument'])

/** Keys `commandGuard` reads. */
const COMMAND_GUARD_KEYS: ReadonlySet<string> = new Set(['tools', 'deny'])

/** Keys one `commandGuard.tools` entry reads. */
const COMMAND_TOOL_KEYS: ReadonlySet<string> = new Set(['tool', 'commandArgument'])

/** Keys one `commandGuard.deny` entry reads. */
const COMMAND_RULE_KEYS: ReadonlySet<string> = new Set(['pattern', 'reason'])

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
  const readTools = resolveReadTools(config.readTools)
  const sensitivePaths = resolveSensitivePaths(config.sensitivePaths)
  const commandGuard = resolveCommandGuard(config.commandGuard)

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
  // Same rule for the reading side: a sensitive-path list with no tool to check
  // it against would load a rail that can never fire.
  if (sensitivePaths !== undefined && readTools === undefined) {
    throw new Error('prism-guardrails: sensitivePaths reads file paths — name readTools as well')
  }

  return {
    mode: resolveMode(config.mode),
    planDeniedTools: resolveDeniedTools(config.planDeniedTools),
    repeatAskAfter: resolveRepeatAskAfter(config.repeatAskAfter),
    maxStepsPerTurn: resolveMaxStepsPerTurn(config.maxStepsPerTurn),
    unfinishedTodoContinuations: resolveUnfinishedTodoContinuations(config.unfinishedTodoContinuations),
    skillInvocationGuidance: resolveSkillInvocationGuidance(config.skillInvocationGuidance),
    writeTools,
    maxWrittenFilesPerTurn,
    requirePonytailUpgradePaths,
    dependencyManifests,
    routingContract,
    verificationGate,
    readTools,
    sensitivePaths,
    commandGuard,
  }
}

/** Whether any configured writing tool carries the text it writes. */
function hasContentArgument(writeTools: ReadonlyMap<string, ResolvedWriteTool> | undefined): boolean {
  if (writeTools === undefined) return false
  for (const tool of writeTools.values()) if (tool.contentArgument !== undefined) return true
  return false
}

/**
 * Check the decision mode.
 *
 * Both values are valid deployments, so the bundle supplies its own default
 * rather than requiring the key: an absent `mode` keeps the pre-observe
 * behavior that every existing profile already has.
 */
function resolveMode(value: Mode | undefined): Mode {
  if (value === undefined) return 'enforce'
  if (value !== 'enforce' && value !== 'observe') {
    throw new Error(`prism-guardrails: mode must be "enforce" or "observe", received ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * The identity of one deployment's rail configuration.
 *
 * It covers the settings a rail decision reads and nothing else, so a
 * conversation about a refusal can name the configuration that produced it.
 *
 * `mode` is normalized through the resolved value, so writing the default
 * explicitly hashes the same as omitting it. An edit that changes no behavior —
 * `repeatAskAfter: 0` against an omitted key — still moves the version, which
 * costs a report line rather than a wrong decision.
 *
 * @param config - the deployment's raw rail configuration.
 * @param mode - the resolved mode, which defaults an omitted key.
 * @returns the first eight hex characters of the configuration's digest.
 */
export function configVersion(config: Config, mode: Mode): string {
  return createHash('sha256').update(JSON.stringify(sortKeys({ ...config, mode }))).digest('hex').slice(0, 8)
}

/**
 * Deep key-sort of a configuration value, so two writings that differ only in
 * property order hash alike.
 *
 * @param value - any value from the deployment's configuration.
 * @returns the same value with every object's keys in sorted order.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key])
  return sorted
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

/**
 * Check the unfinished-todo continuation count, mapping the explicit `0`
 * off-switch to no rail.
 *
 * The upper bound is a deployment policy — how long a turn may be kept alive
 * past the model's own stopping point — so the bundle supplies no default.
 */
function resolveUnfinishedTodoContinuations(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`prism-guardrails: unfinishedTodoContinuations must be an integer >= 0, received ${String(value)}`)
  }
  return value === 0 ? undefined : value
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

/**
 * Check the reading-tool list into a lookup by tool name.
 *
 * Keyed the same way as `writeTools` and for the same reason: every rail asks
 * "is this call a read through this tool, and which path does it name?", and a
 * duplicated name would make the answer depend on position.
 */
function resolveReadTools(value: readonly ReadTool[] | undefined): ReadonlyMap<string, string> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error('prism-guardrails: readTools must be an array of { tool, pathArgument } entries')
  }
  const tools = new Map<string, string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`prism-guardrails: readTools entries must be objects, received ${JSON.stringify(entry)}`)
    }
    const unknown = Object.keys(entry).filter(key => !READ_TOOL_KEYS.has(key))
    if (unknown.length > 0) {
      throw new Error(`prism-guardrails: unknown readTools key(s) ${unknown.join(', ')} — an entry is `
        + `{ ${[...READ_TOOL_KEYS].join(', ')} }`)
    }
    const tool = entry.tool
    const pathArgument = entry.pathArgument
    if (typeof tool !== 'string' || tool.trim() === '') {
      throw new Error(`prism-guardrails: readTools entries must name a tool, received ${JSON.stringify(tool)}`)
    }
    if (typeof pathArgument !== 'string' || pathArgument.trim() === '') {
      throw new Error(`prism-guardrails: readTools entry "${tool}" must name its pathArgument`)
    }
    if (tools.has(tool)) {
      throw new Error(`prism-guardrails: readTools names "${tool}" twice`)
    }
    tools.set(tool, pathArgument)
  }
  if (tools.size === 0) {
    throw new Error('prism-guardrails: readTools must not be empty — omit the key to disable the sensitive-read rail')
  }
  return tools
}

/** Check the sensitive path segments; an empty list has no meaning, so it is an error rather than "off". */
function resolveSensitivePaths(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined
  // Profile YAML is outside the type system: these checks are the boundary.
  if (!Array.isArray(value)) {
    throw new Error('prism-guardrails: sensitivePaths must be an array of path segments')
  }
  if (value.length === 0) {
    throw new Error('prism-guardrails: sensitivePaths must not be empty — omit the key to disable the sensitive-read rail')
  }
  const segments = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`prism-guardrails: sensitivePaths entries must be non-empty path segments, received ${JSON.stringify(entry)}`)
    }
    if (segments.has(entry)) {
      throw new Error(`prism-guardrails: sensitivePaths names "${entry}" twice`)
    }
    segments.add(entry)
  }
  return [...segments]
}

/**
 * Check the command guard into its tool lookup and compiled patterns.
 *
 * A pattern compiles here because the refusal needs a matcher, and a pattern
 * that cannot compile would otherwise load as a rail that never fires.
 */
function resolveCommandGuard(value: CommandGuardConfig | undefined): ResolvedCommandGuard | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('prism-guardrails: commandGuard must be an object { tools, deny }')
  }
  const unknown = Object.keys(value).filter(key => !COMMAND_GUARD_KEYS.has(key))
  if (unknown.length > 0) {
    throw new Error(`prism-guardrails: unknown commandGuard key(s) ${unknown.join(', ')} — it is `
      + `{ ${[...COMMAND_GUARD_KEYS].join(', ')} }`)
  }
  return {
    tools: resolveCommandTools(value.tools),
    rules: resolveCommandRules(value.deny),
  }
}

/** Check the command tools into a lookup by tool name. */
function resolveCommandTools(value: readonly CommandTool[] | undefined): ReadonlyMap<string, string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('prism-guardrails: commandGuard.tools must be a non-empty array of '
      + '{ tool, commandArgument } entries')
  }
  const tools = new Map<string, string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`prism-guardrails: commandGuard.tools entries must be objects, received ${JSON.stringify(entry)}`)
    }
    const unknown = Object.keys(entry).filter(key => !COMMAND_TOOL_KEYS.has(key))
    if (unknown.length > 0) {
      throw new Error(`prism-guardrails: unknown commandGuard.tools key(s) ${unknown.join(', ')} — an entry is `
        + `{ ${[...COMMAND_TOOL_KEYS].join(', ')} }`)
    }
    const tool = entry.tool
    const commandArgument = entry.commandArgument
    if (typeof tool !== 'string' || tool.trim() === '') {
      throw new Error(`prism-guardrails: commandGuard.tools entries must name a tool, received ${JSON.stringify(tool)}`)
    }
    if (typeof commandArgument !== 'string' || commandArgument.trim() === '') {
      throw new Error(`prism-guardrails: commandGuard.tools entry "${tool}" must name its commandArgument`)
    }
    if (tools.has(tool)) {
      throw new Error(`prism-guardrails: commandGuard.tools names "${tool}" twice`)
    }
    tools.set(tool, commandArgument)
  }
  return tools
}

/** Check the guarded commands, compiling each pattern. */
function resolveCommandRules(value: readonly CommandRule[] | undefined): readonly ResolvedCommandRule[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('prism-guardrails: commandGuard.deny must be a non-empty array of { pattern, reason } entries')
  }
  const rules: ResolvedCommandRule[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`prism-guardrails: commandGuard.deny entries must be objects, received ${JSON.stringify(entry)}`)
    }
    const unknown = Object.keys(entry).filter(key => !COMMAND_RULE_KEYS.has(key))
    if (unknown.length > 0) {
      throw new Error(`prism-guardrails: unknown commandGuard.deny key(s) ${unknown.join(', ')} — an entry is `
        + `{ ${[...COMMAND_RULE_KEYS].join(', ')} }`)
    }
    const source = entry.pattern
    const reason = entry.reason
    if (typeof source !== 'string' || source.trim() === '') {
      throw new Error(`prism-guardrails: commandGuard.deny entries must name a pattern, received ${JSON.stringify(source)}`)
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`prism-guardrails: commandGuard.deny entry ${JSON.stringify(source)} must name a reason`)
    }
    let pattern: RegExp
    try {
      pattern = new RegExp(source, 'i')
    } catch (error) {
      throw new Error(`prism-guardrails: commandGuard.deny pattern ${JSON.stringify(source)} is not a regular `
        + `expression: ${error instanceof Error ? error.message : String(error)}`)
    }
    rules.push({ pattern, source, reason })
  }
  return rules
}
