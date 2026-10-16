/**
 * Capability-hardening bundle: places where DeepSeek Harness or a method pack
 * offers an advisory capability become enforced ones.
 *
 * Every rail registers on a documented extension point and owns its decision
 * there, so the bundle adds behavior without rewriting an upstream package:
 *
 * - **Plan mode** — deployment-named tools are refused by a monotonic
 *   `tools.guard()` while plan-mode state says active or selected-but-pending,
 *   instead of being discouraged by a prompt section.
 * - **Repeated calls** — after a configured run of identical calls, the next
 *   one goes to approval, so a human prices the repetition instead of the loop
 *   continuing unattended.
 * - **Turn budget** — a turn cannot open more steps than the deployment allows.
 * - **Skill invocation** — a model asking for a user-only skill is told which
 *   message would load it, instead of reading a dead end.
 * - **Routing contract** — the Aegis method pack asks the model to choose a
 *   route before its first non-readonly call and records the miss afterwards;
 *   here the call itself is refused until a route is on the record.
 * - **Write budget** — a turn writing more distinct files than the deployment
 *   allows sends the next new path to approval, so one turn's blast radius is
 *   priced rather than discovered in the diff.
 * - **Marker discipline** — Ponytail marks every deliberate shortcut with a
 *   `ponytail:` comment naming its ceiling and upgrade path; a marker without
 *   an upgrade path is refused before it is written.
 * - **Dependency changes** — a write to a dependency manifest goes to
 *   approval, so adding a library is a priced decision rather than a line in
 *   a diff.
 * - **Verification gate** — a turn that wrote files and ran no verification is
 *   sent back for its evidence before it can stop.
 *
 * The configuration surface, each rail's exact behavior, and the DeepSeek
 * Harness capability each one replaces are in the package README.
 *
 * @module prism-guardrails
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import type { PlanModeController } from '@deepseek-ai/dsh-plan-mode'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { PostToolDecision, PreToolDecision } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from './config.ts'
import type { Config, ResolvedConfig, ResolvedWriteTool } from './config.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'prism-guardrails': { kind: 'prism-guardrails' } & ContextFormed
  }
}

/** Cordis plugin name; also the `cordis.patch.yml` row id this bundle inserts. */
export const name = 'prism-guardrails'

/** The tool registry owns every registration this bundle makes. */
export const inject = ['tools']

/**
 * The model-facing loader registered by `@deepseek-ai/dsh-tool-skill`. A
 * protocol constant: the skill capability's one model-facing entry point.
 */
export const SKILL_TOOL = 'skill'

/**
 * The declaration the Aegis routing contract accepts instead of a skill load.
 *
 * A protocol constant rather than configuration: the string is the contract
 * text both sides of the method pack agree on, and a deployment that reworded
 * it would be asking the model for a phrase the pack's own skills do not name.
 */
export const FAST_PATH_DECLARATION = 'Route: fast-path'

/** The comment prefix Ponytail markers carry, so prose mentioning the convention is not a marker. */
const PONYTAIL_MARKER = /(?:#|\/\/|\/\*|\*)\s*ponytail:/u

/** The session event that ends a compaction, after which the model no longer holds its routing decision. */
const COMPACTION_END = 'compaction/end'

/** One agent's consecutive-repeat chain: the last tracked call's identity and its run length. */
interface RepeatChain {
  readonly key: string
  readonly count: number
}

/** What one turn has written and whether it has been verified or already sent back for evidence. */
interface TurnRecord {
  turn: number
  readonly writtenPaths: Set<string>
  verified: boolean
  steered: boolean
}

/** The routing contract's record for one session. */
interface RoutingRecord {
  routed: boolean
}

/** The session's turn records, read by the rails that price or gate a turn's writes. */
interface TurnRecords {
  /**
   * The current turn's record for an agent, created on first read.
   * @param agent - the agent whose turn is read.
   * @returns the record, reset whenever the loop opens a turn the record has not seen.
   */
  of(agent: Agent): TurnRecord
}

/**
 * Install every configured rail.
 *
 * @param ctx - plugin context; each registration is scoped to it and disposed with it.
 * @param config - deployment configuration, validated here so a misconfiguration fails at load.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  installPlanModeDenial(ctx, resolved)
  installRepeatApproval(ctx, resolved)
  installTurnBudget(ctx, resolved)
  installSkillInvocationGuidance(ctx, resolved)
  installRoutingContract(ctx, resolved)
  const turns = resolved.maxWrittenFilesPerTurn === undefined && resolved.verificationGate === undefined
    ? undefined
    : installTurnRecords(ctx, resolved)
  installWriteBudget(ctx, resolved, turns)
  installPonytailMarkerDiscipline(ctx, resolved)
  installDependencyApproval(ctx, resolved)
  installVerificationGate(ctx, resolved, turns)
}

/**
 * Refuse deployment-named tools while plan mode is in force.
 *
 * A monotonic guard rather than a `tools/pre-execute` listener: guards are
 * evaluated after the whole extensible pre-execute waterfall and have no allow
 * result, so no other plugin's listener ordering can turn the refusal back into
 * permission.
 *
 * The reading is `PlanModeController.get()` — the same logged-plus-selected
 * criterion the plan guidance prompt section uses — so a selection still waiting
 * for the next accepted step already refuses. A deployment without the
 * plan-mode service keeps its tools unrestricted; the rail has no state of its
 * own to invent.
 */
function installPlanModeDenial(ctx: Context, resolved: ResolvedConfig): void {
  const denied = resolved.planDeniedTools
  if (denied === undefined) return
  ctx.tools.guard((exec) => {
    const agent = exec.agent
    if (agent === undefined || !denied.has(exec.name)) return undefined
    const planMode = ctx.get('planMode') as PlanModeController | undefined
    if (planMode === undefined) return undefined
    const state = planMode.get(agent)
    if (!(state.pending ?? state.active)) return undefined
    return `plan mode is active: \`${exec.name}\` is not executed until the plan is approved; `
      + 'present the plan with exit_plan_mode or leave with /plan off'
  })
}

/**
 * Send a call that repeats an identical predecessor beyond the configured run
 * to approval.
 *
 * Counting stays in `tools/post-execute` because a denied or cancelled call
 * reaches that waterfall too — a model hammering this gate keeps meeting it.
 * An approval does not reset the chain (approvals are `allowed-once`, so a
 * reset would sell unlimited repeats for one decision), while a claiming user
 * message does, because repetition across a human interjection is not a loop.
 *
 * `ask` rather than `deny` because legitimate long runs exist — polling one
 * `job_output`, re-reading a file an external process changed — and only a
 * human can tell them apart. With no approval channel the fail-closed approval
 * ladder denies the call, which is the intended unattended outcome.
 */
function installRepeatApproval(ctx: Context, resolved: ResolvedConfig): void {
  const limit = resolved.repeatAskAfter
  if (limit === undefined) return
  const chains = new WeakMap<Agent, RepeatChain>()

  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (agent === undefined) return next()
    const chain = chains.get(agent)
    const key = callKey(exec.name, exec.arguments)
    const reached = chain !== undefined && chain.key === key ? chain.count + 1 : 1
    if (reached <= limit) return next()
    return Promise.resolve({
      kind: 'ask',
      reason: `\`${exec.name}\` has now been called ${String(reached - 1)} times in a row with identical `
        + 'arguments and made no progress; approve only if repeating it is still the right action',
    })
  })

  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const agent = exec.agent
    if (agent !== undefined) {
      const key = callKey(exec.name, exec.arguments)
      const chain = chains.get(agent)
      chains.set(agent, { key, count: chain !== undefined && chain.key === key ? chain.count + 1 : 1 })
    }
    return next()
  })

  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) chains.delete(agent)
    return next()
  })
}

/**
 * Refuse to open a step beyond the configured per-turn budget.
 *
 * The judge is the step number the loop already carries in the pre-step
 * payload, so retries, rejected steps, resume, and fork are all correct with no
 * counter to keep, advance, or reset. The model never sees a rejected step, so
 * the log line is the only record of why the turn stopped.
 */
function installTurnBudget(ctx: Context, resolved: ResolvedConfig): void {
  const limit = resolved.maxStepsPerTurn
  if (limit === undefined) return
  ctx.on('agent/pre-step', ({ turn, step }, next): Promise<PreStepDecision> => {
    if (step <= limit) return next()
    ctx.logger.warn(`prism-guardrails: turn ${String(turn)} reached the ${String(limit)}-step budget; `
      + `step ${String(step)} was not opened`)
    return Promise.resolve({ kind: 'reject' })
  })
}

/**
 * Answer a model's attempt to load a user-only skill with the message that
 * would load it.
 *
 * The decision reads the resolved catalog through the public registry — the
 * same lookup the skill tool performs. A skill that neither interface can
 * invoke keeps the tool's own rejection: there is no route to offer, and
 * inventing one would be wrong. A deployment without the skill service, or a
 * call that names no skill, delegates unchanged.
 */
function installSkillInvocationGuidance(ctx: Context, resolved: ResolvedConfig): void {
  if (!resolved.skillInvocationGuidance) return
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (agent === undefined || exec.name !== SKILL_TOOL) return next()
    const requested = stringArgument(exec.arguments, 'name')
    if (requested === undefined) return next()
    const skills = ctx.get('skills') as SkillRegistry | undefined
    if (skills === undefined) return next()
    const summaries = await skills.list({ cwd: agent.session.header.cwd, signal: exec.signal, scope: agent })
    const summary = summaries.find(candidate => candidate.name === requested)
    if (summary === undefined) return next()
    const { modelInvocable, userInvocable } = summary.invocation
    if (modelInvocable || !userInvocable) return next()
    return {
      kind: 'deny',
      reason: `skill "${requested}" is user-invoked only: ask the user to type /${requested} in their next message`,
    }
  })
}

/**
 * Refuse the first non-readonly call of a session until a routing decision is
 * on the record.
 *
 * Aegis ships this contract as text and, on its other hosts, as a marker
 * appended after the fact; here the call that breaks the contract is the thing
 * refused, so the model must choose a route before it acts. Either decision is
 * accepted and stores the same record: a load through the `skill` tool, or the
 * `Route: fast-path` declaration in an assistant message. The declaration is
 * read from the committed session event rather than from the streaming
 * attempt, so a retried or discarded attempt cannot satisfy the contract.
 *
 * A refusal costs one round trip, not a loop: the model answers with a
 * decision, which is itself an allowed call, and the gate is then satisfied for
 * the session. The record is dropped when compaction ends, because the model's
 * next request no longer carries the decision it once made.
 */
function installRoutingContract(ctx: Context, resolved: ResolvedConfig): void {
  const readOnlyTools = resolved.routingContract
  if (readOnlyTools === undefined) return
  const records = new Map<string, RoutingRecord>()

  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (agent === undefined || readOnlyTools.has(exec.name)) return next()
    const sessionId = agent.session.id
    const record = records.get(sessionId)
    if (record !== undefined && record.routed) return next()
    if (exec.name === SKILL_TOOL) {
      records.set(sessionId, { routed: true })
      return next()
    }
    return Promise.resolve({
      kind: 'deny',
      reason: `the routing contract is not satisfied: \`${exec.name}\` is the first non-readonly call of this `
        + `session. Load the task's skill with the \`${SKILL_TOOL}\` tool, or declare \`${FAST_PATH_DECLARATION}\` `
        + 'with a one-line reason, then repeat this call.',
    })
  })

  ctx.on('session/event', (session, event) => {
    // The compaction boundary is matched as text because its event type belongs
    // to the compaction package, which this bundle does not import: narrowing
    // on the literal would depend on that package being in its type graph.
    if (String(event.type) === COMPACTION_END) {
      records.delete(session.id)
      return
    }
    if (event.type !== 'assistant/message') return
    if (!records.has(session.id) && !messageDeclaresFastPath(event.data.message.content)) return
    records.set(session.id, { routed: true })
  })

  ctx.on('agent/disposed', ({ agent }) => {
    records.delete(agent.session.id)
  })
}

/**
 * Send the call that would write a new file beyond the configured budget to
 * approval.
 *
 * The count is distinct paths, not writes, so a turn that edits one file
 * repeatedly is not priced for the editing — breadth is what an unreviewed
 * turn's diff cannot recover from.
 *
 * Paths compare as the call wrote them, so `a.ts` and `./a.ts` count as two.
 * Canonicalizing them would need the filesystem resolved against the call's
 * working directory, which this rail would then own; the ceiling is recorded in
 * the README instead.
 */
function installWriteBudget(ctx: Context, resolved: ResolvedConfig, turns: TurnRecords | undefined): void {
  const limit = resolved.maxWrittenFilesPerTurn
  const writeTools = resolved.writeTools
  if (limit === undefined || writeTools === undefined || turns === undefined) return

  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (agent === undefined) return next()
    const written = writtenPathOf(writeTools, exec.name, exec.arguments)
    if (written === undefined) return next()
    const record = turns.of(agent)
    if (record.writtenPaths.has(written.path)) return next()
    const reached = record.writtenPaths.size + 1
    if (reached <= limit) return next()
    return Promise.resolve({
      kind: 'ask',
      reason: `this turn has already written ${String(record.writtenPaths.size)} distinct files and \`${exec.name}\` `
        + `would make \`${written.path}\` the ${String(reached)}th, beyond the ${String(limit)} the deployment allows; `
        + 'approve only if the wider change is intended',
    })
  })
}

/**
 * Refuse a written `ponytail:` marker that names no upgrade path.
 *
 * The method pack's convention is `ponytail: <ceiling>, <upgrade path>`, and
 * its own debt report tags a marker with no trigger as the one that silently
 * rots. Refusing the write is the only point where the fix is free: after the
 * file lands, the marker is a debt entry nobody reads.
 *
 * Only comment-prefixed markers are read, so prose that merely mentions the
 * convention — this file's own JSDoc included — is not a marker.
 */
function installPonytailMarkerDiscipline(ctx: Context, resolved: ResolvedConfig): void {
  if (!resolved.requirePonytailUpgradePaths) return
  const writeTools = resolved.writeTools
  if (writeTools === undefined) return

  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const written = writtenPathOf(writeTools, exec.name, exec.arguments)
    if (written === undefined || written.tool.contentArgument === undefined) return next()
    const content = stringArgument(exec.arguments, written.tool.contentArgument)
    if (content === undefined) return next()
    const marker = markerWithoutUpgradePath(content)
    if (marker === undefined) return next()
    return Promise.resolve({
      kind: 'deny',
      reason: `\`${written.path}\` writes a \`ponytail:\` marker with no upgrade path: ${JSON.stringify(marker)}. `
        + 'The convention is `ponytail: <ceiling>, <upgrade path>`; name the limit and the trigger that would '
        + 'revisit it, or delete the marker.',
    })
  })
}

/**
 * Send a write to a dependency manifest to approval.
 *
 * The method pack's ladder puts the standard library, the platform, and an
 * already-installed dependency above a new one, and a manifest write is where
 * that ordering is actually spent. Pricing the write puts the choice in front
 * of a human at the only moment the alternative is still cheap.
 */
function installDependencyApproval(ctx: Context, resolved: ResolvedConfig): void {
  const manifests = resolved.dependencyManifests
  const writeTools = resolved.writeTools
  if (manifests === undefined || writeTools === undefined) return

  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const written = writtenPathOf(writeTools, exec.name, exec.arguments)
    if (written === undefined) return next()
    const name = baseName(written.path)
    if (!manifests.has(name)) return next()
    return Promise.resolve({
      kind: 'ask',
      reason: `\`${exec.name}\` changes the dependency manifest \`${written.path}\`; approve only if the new `
        + 'dependency is genuinely needed rather than already covered by the standard library, the platform, or '
        + 'a library this project already depends on',
    })
  })
}

/**
 * Send a turn back for evidence before it stops, when it wrote files and ran no
 * verification.
 *
 * The stop boundary has no veto — nothing can refuse the assistant's final text
 * — so the rail uses the machine's own continuation path: steering at the
 * stopping boundary makes the loop observe pending input and run another step.
 * The model then either runs a check or says why it cannot, and the next stop
 * boundary is not interrupted again, so a model that ignores this costs one
 * extra step rather than looping.
 *
 * A completed call to any `verifyTools` tool is the evidence. A failing check
 * counts: the rail asks whether a check was run, not whether it passed, and a
 * report of a failing check is exactly the outcome this gate exists to make
 * possible.
 */
function installVerificationGate(ctx: Context, resolved: ResolvedConfig, turns: TurnRecords | undefined): void {
  const verifyTools = resolved.verificationGate
  if (verifyTools === undefined || turns === undefined) return

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const agent = exec.agent
    if (agent !== undefined && !result.isError && verifyTools.has(exec.name)) {
      turns.of(agent).verified = true
    }
    return next()
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const record = turns.of(agent)
    if (record.turn !== turn || record.writtenPaths.size === 0) return
    if (record.verified || record.steered) return
    record.steered = true
    const files = [...record.writtenPaths].join(', ')
    agent.steer(createUserMessage({
      content: [{
        type: 'text',
        text: `This turn wrote ${files} and ran no verification (\`${[...verifyTools].join('\`, \`')}\`). `
          + 'Run the check that would fail if the change is wrong, then report what you ran, its result, what it '
          + 'covers, and what remains unverified — or say plainly why no check is available. Do not claim the work '
          + 'is complete until then.',
      }],
      source: { kind: 'prism-guardrails', form: 'instructions' },
    }))
  })
}

/**
 * Track each agent's current turn, the files it wrote, and whether it verified.
 *
 * The turn number comes from the loop's own pre-step payload, so nothing is
 * counted here: a record is reset exactly when the loop opens a turn the record
 * has not seen, which keeps retries and resumed sessions correct by
 * construction.
 *
 * Written paths are recorded here rather than by the write-budget rail, because
 * the verification gate reads the same set with that rail off — one owner for
 * the fact, read by both.
 *
 * @param ctx - plugin context that owns the registrations.
 * @param resolved - the validated configuration supplying the writing tools.
 * @returns the lookup the rails read a turn's record through, or `undefined`
 * when the deployment named no writing tools.
 */
function installTurnRecords(ctx: Context, resolved: ResolvedConfig): TurnRecords | undefined {
  const writeTools = resolved.writeTools
  if (writeTools === undefined) return undefined
  const records = new WeakMap<Agent, TurnRecord>()
  const of = (agent: Agent): TurnRecord => {
    let record = records.get(agent)
    if (record === undefined) {
      record = { turn: -1, writtenPaths: new Set(), verified: false, steered: false }
      records.set(agent, record)
    }
    return record
  }

  ctx.on('agent/pre-step', ({ agent, turn }, next): Promise<PreStepDecision> => {
    const record = of(agent)
    if (record.turn !== turn) {
      record.turn = turn
      record.writtenPaths.clear()
      record.verified = false
      record.steered = false
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const agent = exec.agent
    // A refused or failed call reaches this waterfall too, and it did not write
    // the file: counting it would spend the budget on writes that never landed
    // and would report a file the verification gate never needs to cover.
    if (agent !== undefined && !result.isError) {
      const written = writtenPathOf(writeTools, exec.name, exec.arguments)
      if (written !== undefined) of(agent).writtenPaths.add(written.path)
    }
    return next()
  })

  return { of }
}

/**
 * The written path and tool settings of a call, when the call is one of the
 * deployment's writing tools.
 *
 * @param writeTools - the configured writing tools by name.
 * @param toolName - the called tool's name.
 * @param argumentsValue - the call's parsed arguments.
 * @returns the tool's settings and the path it writes, or `undefined` when the
 * call is not a configured write or carries no readable path.
 */
function writtenPathOf(
  writeTools: ReadonlyMap<string, ResolvedWriteTool>,
  toolName: string,
  argumentsValue: unknown,
): { tool: ResolvedWriteTool; path: string } | undefined {
  const tool = writeTools.get(toolName)
  if (tool === undefined) return undefined
  const path = stringArgument(argumentsValue, tool.pathArgument)
  return path === undefined ? undefined : { tool, path }
}

/**
 * The first comment-prefixed `ponytail:` marker whose text names no upgrade
 * path.
 *
 * @param content - the text the call would write.
 * @returns the offending marker's text, or `undefined` when every marker names
 * a comma-separated continuation.
 */
function markerWithoutUpgradePath(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const start = line.search(PONYTAIL_MARKER)
    if (start === -1) continue
    const text = line.slice(start).replace(PONYTAIL_MARKER, '').trim()
    if (!text.includes(',')) return text
  }
  return undefined
}

/**
 * The last path segment, on either separator.
 *
 * @param path - a path as a tool call wrote it.
 * @returns the file name the dependency rail matches against its configured names.
 */
function baseName(path: string): string {
  const segments = path.replaceAll('\\', '/').split('/')
  return segments[segments.length - 1] ?? path
}

/**
 * Whether a committed assistant message carries the routing contract's
 * fast-path declaration.
 *
 * @param content - the message's content blocks.
 * @returns `true` when any text block names the declaration.
 */
function messageDeclaresFastPath(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'text' && block.text.includes(FAST_PATH_DECLARATION))
}

/**
 * One string argument of a call, when the call carries one.
 *
 * `exec.arguments` is typed `unknown` and reaches this bundle from model tool
 * JSON. The registry validates a call against the tool's compiled object schema
 * first, so a non-object cannot arrive through the shipped tool set; the guard
 * keeps the function total at that boundary rather than throwing inside a
 * pre-execute listener, which would fail every call to the tool.
 *
 * @param argumentsValue - the call's parsed arguments.
 * @param key - the argument's name.
 * @returns the argument's value, or `undefined` when it is absent or not a non-empty string.
 */
function stringArgument(argumentsValue: unknown, key: string): string | undefined {
  if (typeof argumentsValue !== 'object' || argumentsValue === null) return undefined
  const value = (argumentsValue as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Identity of one call: the tool name plus its arguments with object keys
 * sorted, so two calls differing only in property order compare equal.
 *
 * Arguments reach this bundle as the loop's parsed JSON (or its raw-string
 * fallback for malformed argument JSON), so JSON's value domain is the whole
 * input domain here.
 *
 * @param toolName - the called tool's name.
 * @param argumentsValue - the call's parsed arguments.
 * @returns the chain key two identical calls share.
 */
function callKey(toolName: string, argumentsValue: unknown): string {
  return JSON.stringify([toolName, sortJsonValue(argumentsValue)])
}

/**
 * Deep key-sort of a parsed-JSON value.
 * @param value - any value from a tool call's arguments.
 * @returns the same value with every object's keys in sorted order.
 */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key])
    return sorted
  }
  return value
}
