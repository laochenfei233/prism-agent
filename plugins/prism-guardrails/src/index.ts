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
 *   `shortcut:` comment (older code says `ponytail:`) naming its ceiling and
 *   upgrade path; a marker without an upgrade path is refused before it is
 *   written.
 * - **Dependency changes** — a write to a dependency manifest goes to
 *   approval, so adding a library is a priced decision rather than a line in
 *   a diff.
 * - **Verification gate** — a turn that wrote files and ran no verification is
 *   sent back for its evidence before it can stop.
 * - **Unfinished-todo gate** — a turn whose own todo list still holds pending or
 *   in-progress items is sent back to finish them before it can stop.
 * - **Sensitive reads** — a read of a path the deployment treats as credential
 *   material is refused, because the content would land in the session log.
 * - **Command guard** — a shell call whose text matches a guarded pattern goes
 *   to approval, so a force-push or a recursive delete is priced before it runs.
 *
 * `/guardrails` reports which of these a running deployment has armed, the mode
 * it decides in, and what an `observe` run has seen: under `observe` every rail
 * decides as it would under `enforce`, records the decision, and lets the call
 * through, so a deployment can read a rail's reach before arming it.
 *
 * The configuration surface, each rail's exact behavior, and the DeepSeek
 * Harness capability each one replaces are in the package README.
 *
 * @module prism-guardrails
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed, GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { PlanModeController } from '@deepseek-ai/dsh-plan-mode'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { PostToolDecision, PreToolDecision, ToolExecutionFailure } from '@deepseek-ai/dsh-tools'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/types'
import { configVersion, resolveConfig } from './config.ts'
import { createLedger } from './decision.ts'
import { PONYTAIL_MARKER } from './marker.ts'
import type { Config, Mode, ResolvedConfig, ResolvedWriteTool } from './config.ts'
import type { Decision, DecisionLedger, DecisionOutcome } from './decision.ts'

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

/** The session event that ends a compaction, after which the model no longer holds its routing decision. */
const COMPACTION_END = 'compaction/end'

/** How many unfinished todo items one continuation message names before summarizing the rest. */
const MAX_REPORTED_TODOS = 5

/** How many recorded decisions the status report lists. */
const MAX_REPORTED_DECISIONS = 10

/** How much of one decision's subject the status report shows. */
const MAX_REPORTED_SUBJECT = 60

/** How much of one failure's text the judge's prompt carries per entry. */
const STUCK_FAILURE_TEXT_MAX = 160

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
  const ledger = createLedger()
  const version = configVersion(config, resolved.mode)
  installPlanModeDenial(ctx, resolved, ledger)
  installRepeatApproval(ctx, resolved, ledger)
  installTurnBudget(ctx, resolved, ledger)
  installSkillInvocationGuidance(ctx, resolved, ledger)
  installRoutingContract(ctx, resolved, ledger)
  const turns = resolved.maxWrittenFilesPerTurn === undefined && resolved.verificationGate === undefined
    ? undefined
    : installTurnRecords(ctx, resolved)
  installWriteBudget(ctx, resolved, turns, ledger)
  installPonytailMarkerDiscipline(ctx, resolved, ledger)
  installDependencyApproval(ctx, resolved, ledger)
  installVerificationGate(ctx, resolved, turns, ledger)
  installUnfinishedTodoGate(ctx, resolved, ledger)
  installSensitiveReadDenial(ctx, resolved, ledger)
  installCommandGuard(ctx, resolved, ledger)
  installStuckNudge(ctx, resolved, ledger)
  installStatusCommand(ctx, resolved, ledger, version)
}

/**
 * Record a rail's decision and apply it, unless the deployment is observing.
 *
 * `observe` records what `enforce` would have done and delegates instead, so the
 * only behavior it changes is whether a refusal is returned. A `steer` does not
 * come through here: observing must not switch off the rails that send a turn
 * back for evidence.
 *
 * @param ledger - the session's decision record.
 * @param mode - how to apply the decision.
 * @param agent - the agent whose session is deciding.
 * @param rail - the rail's report name.
 * @param subject - what the rail judged.
 * @param decision - the refusal or approval to apply in `enforce` mode.
 * @param next - the waterfall's continue, which observing delegates to.
 * @returns the decision in `enforce` mode, and the delegated outcome in `observe`.
 */
function decide(
  ledger: DecisionLedger,
  mode: Mode,
  agent: Agent | undefined,
  rail: string,
  subject: string,
  decision: RailRefusal,
  next: () => Promise<PreToolDecision>,
): Promise<PreToolDecision> {
  ledger.record(agent, { rail, outcome: mode === 'observe' ? 'observed' : decision.kind, subject })
  return mode === 'observe' ? next() : Promise.resolve(decision)
}

/** A decision a rail applies to one tool call: the two kinds `observe` can downgrade. */
type RailRefusal = Extract<PreToolDecision, { kind: 'deny' } | { kind: 'ask' }>

/**
 * Record one rail decision outside the pre-execute waterfall.
 *
 * @param ledger - the session's decision record.
 * @param agent - the agent whose session is deciding.
 * @param rail - the rail's report name.
 * @param subject - what the rail judged.
 * @param outcome - what the rail did.
 */
function note(
  ledger: DecisionLedger,
  agent: Agent | undefined,
  rail: string,
  subject: string,
  outcome: DecisionOutcome,
): void {
  ledger.record(agent, { rail, outcome, subject })
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
 *
 * Observing records the refusal and returns `undefined`, which the guard reads
 * as permission.
 */
function installPlanModeDenial(ctx: Context, resolved: ResolvedConfig, ledger: DecisionLedger): void {
  const denied = resolved.planDeniedTools
  if (denied === undefined) return
  ctx.tools.guard((exec) => {
    const agent = exec.agent
    if (agent === undefined || !denied.has(exec.name)) return undefined
    const planMode = ctx.get('planMode') as PlanModeController | undefined
    if (planMode === undefined) return undefined
    const state = planMode.get(agent)
    if (!(state.pending ?? state.active)) return undefined
    const reason = `plan mode is active: \`${exec.name}\` is not executed until the plan is approved; `
      + 'present the plan with exit_plan_mode or leave with /plan off'
    note(ledger, agent, 'plan-mode denial', exec.name, resolved.mode === 'observe' ? 'observed' : 'deny')
    return resolved.mode === 'observe' ? undefined : reason
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
function installRepeatApproval(ctx: Context, resolved: ResolvedConfig, ledger: DecisionLedger): void {
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
    return decide(ledger, resolved.mode, agent, 'repeat approval', exec.name, {
      kind: 'ask',
      reason: `\`${exec.name}\` has now been called ${String(reached - 1)} times in a row with identical `
        + 'arguments and made no progress; approve only if repeating it is still the right action',
    }, next)
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
 * the log line and the ledger row are the only record of why the turn stopped.
 * Observing skips both the refusal and the log line, which would otherwise say a
 * step was not opened when it was.
 */
function installTurnBudget(ctx: Context, resolved: ResolvedConfig, ledger: DecisionLedger): void {
  const limit = resolved.maxStepsPerTurn
  if (limit === undefined) return
  ctx.on('agent/pre-step', ({ agent, turn, step }, next): Promise<PreStepDecision> => {
    if (step <= limit) return next()
    note(ledger, agent, 'turn budget', `step ${String(step)}`, resolved.mode === 'observe' ? 'observed' : 'deny')
    if (resolved.mode === 'observe') return next()
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
function installSkillInvocationGuidance(ctx: Context, resolved: ResolvedConfig, ledger: DecisionLedger): void {
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
    return decide(ledger, resolved.mode, agent, 'skill guidance', requested, {
      kind: 'deny',
      reason: `skill "${requested}" is user-invoked only: ask the user to type /${requested} in their next message`,
    }, next)
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
function installRoutingContract(ctx: Context, resolved: ResolvedConfig, ledger: DecisionLedger): void {
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
    return decide(ledger, resolved.mode, agent, 'routing contract', exec.name, {
      kind: 'deny',
      reason: `the routing contract is not satisfied: \`${exec.name}\` is the first non-readonly call of this `
        + `session. Load the task's skill with the \`${SKILL_TOOL}\` tool, or declare \`${FAST_PATH_DECLARATION}\` `
        + 'with a one-line reason, then repeat this call.',
    }, next)
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
function installWriteBudget(
  ctx: Context,
  resolved: ResolvedConfig,
  turns: TurnRecords | undefined,
  ledger: DecisionLedger,
): void {
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
    return decide(ledger, resolved.mode, agent, 'write budget', written.path, {
      kind: 'ask',
      reason: `this turn has already written ${String(record.writtenPaths.size)} distinct files and \`${exec.name}\` `
        + `would make \`${written.path}\` the ${String(reached)}th, beyond the ${String(limit)} the deployment allows; `
        + 'approve only if the wider change is intended',
    }, next)
  })
}

/**
 * Refuse a written `shortcut:` marker that names no upgrade path.
 *
 * The method pack's convention is `shortcut: <ceiling>, <upgrade path>`
 * (older code says `ponytail:`), and its own debt report tags a marker with no
 * trigger as the one that silently rots. Refusing the write is the only point
 * where the fix is free: after the file lands, the marker is a debt entry
 * nobody reads.
 *
 * Only comment-prefixed markers are read, so prose that merely mentions the
 * convention — this file's own JSDoc included — is not a marker.
 */
function installPonytailMarkerDiscipline(ctx: Context, resolved: ResolvedConfig, ledger: DecisionLedger): void {
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
    return decide(ledger, resolved.mode, exec.agent, 'ponytail markers', written.path, {
      kind: 'deny',
      reason: `\`${written.path}\` writes a \`shortcut:\` marker with no upgrade path: ${JSON.stringify(marker)}. `
        + 'The convention is `shortcut: <ceiling>, <upgrade path>` (older code says `ponytail:`); name the limit '
        + 'and the trigger that would revisit it, or delete the marker.',
    }, next)
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
function installDependencyApproval(ctx: Context, resolved: ResolvedConfig, ledger: DecisionLedger): void {
  const manifests = resolved.dependencyManifests
  const writeTools = resolved.writeTools
  if (manifests === undefined || writeTools === undefined) return

  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const written = writtenPathOf(writeTools, exec.name, exec.arguments)
    if (written === undefined) return next()
    const name = baseName(written.path)
    if (!manifests.has(name)) return next()
    return decide(ledger, resolved.mode, exec.agent, 'dependency manifests', written.path, {
      kind: 'ask',
      reason: `\`${exec.name}\` changes the dependency manifest \`${written.path}\`; approve only if the new `
        + 'dependency is genuinely needed rather than already covered by the standard library, the platform, or '
        + 'a library this project already depends on',
    }, next)
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
function installVerificationGate(
  ctx: Context,
  resolved: ResolvedConfig,
  turns: TurnRecords | undefined,
  ledger: DecisionLedger,
): void {
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
    note(ledger, agent, 'verification gate', files, 'steer')
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
 * Send a turn back to its own todo list before it stops with work left on it.
 *
 * The list is the plan the model wrote for itself, so a stop that leaves items
 * `pending` or `in_progress` is the turn ending mid-plan — the shape a long
 * implementation run keeps producing when it reports progress instead of
 * finishing. The stop boundary has no veto, so the rail uses the loop's own
 * continuation path: steering there makes the loop observe pending input and
 * run another step.
 *
 * The latest snapshot is read from the session log, so a resumed or forked
 * session is judged by the list it actually has. `unfinishedTodoContinuations`
 * bounds the steers per turn, so a model that keeps stopping reaches its budget
 * and the next stop boundary is left alone: the worst case is that many extra
 * steps, not a loop.
 */
function installUnfinishedTodoGate(ctx: Context, resolved: ResolvedConfig, ledger: DecisionLedger): void {
  const limit = resolved.unfinishedTodoContinuations
  if (limit === undefined) return
  const records = new WeakMap<Agent, { turn: number; steered: number }>()

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const previous = records.get(agent)
    const record = previous !== undefined && previous.turn === turn ? previous : { turn, steered: 0 }
    records.set(agent, record)
    if (record.steered >= limit) return
    const unfinished = unfinishedTodos(agent)
    if (unfinished.length === 0) return
    record.steered += 1
    note(ledger, agent, 'unfinished todos', `${String(unfinished.length)} item(s)`, 'steer')
    const shown = unfinished.slice(0, MAX_REPORTED_TODOS).map(item => `"${item.content}"`).join(', ')
    const rest = unfinished.length - Math.min(unfinished.length, MAX_REPORTED_TODOS)
    agent.steer(createUserMessage({
      content: [{
        type: 'text',
        text: `Your todo list still has ${String(unfinished.length)} unfinished item(s): ${shown}`
          + `${rest > 0 ? ` and ${String(rest)} more` : ''}. Continue with the next one, and rewrite the list when `
          + 'an item is no longer needed. Report the work as complete only when every item is completed or removed '
          + 'with its reason; if an item is blocked on a human decision, say which decision and why.',
      }],
      source: { kind: 'prism-guardrails', form: 'instructions' },
    }))
  })
}

/**
 * The items the agent's own todo list still has open.
 *
 * The latest `todo/write` snapshot wins, matching the log's whole-value rule; a
 * session that never wrote a list has nothing this rail can enforce.
 */
function unfinishedTodos(agent: Agent): readonly TodoItem[] {
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'todo/write') return event.data.todos.filter(item => item.status !== 'completed')
  }
  return []
}

/** One failed call in a stuck chain: the tool and what it said went wrong. */
interface StuckFailure {
  readonly tool: string
  readonly message: string
}

/** One agent's stuck chain and its per-turn quota spend. */
interface StuckRecord {
  readonly failures: StuckFailure[]
  nudged: number
}

/** The judge's verdict on one failure chain. */
interface StuckVerdict {
  readonly spinning: boolean
  readonly confidence: number
}

/**
 * The bound judge's outcome: a verdict, or why there is none. The caller logs
 * the reason, so an operator can tell a missing route from an unusable reply.
 */
type StuckJudgement = StuckVerdict | 'no-route' | 'unusable'

/** The bound judge, or `undefined` while no llm service is mounted. */
type StuckJudge = (agent: Agent, failures: readonly StuckFailure[], signal: AbortSignal) => Promise<StuckJudgement>

/**
 * Nudge an agent that keeps repeating the same failing call.
 *
 * The failure chain is per turn — the loop opening a turn the record has not
 * seen resets it, whatever enqueued the turn — and any successful call clears
 * it, so the judge only ever sees a run of consecutive failures inside one
 * turn. When the
 * run reaches the threshold, one one-shot model call decides whether the run
 * really is a loop, and only a confident yes sends a reminder. The reminder
 * rides the accepted result's additional contexts: the call itself is never
 * refused, this rail has no deny to make, and the text says plainly that
 * stopping is the person's call.
 *
 * The judge is an external dependency. No llm service, no routed model, an
 * unusable reply, or a failed call all mean this window sends nothing, and
 * only a log line records why; the chain keeps accumulating, and the next
 * qualifying window tries the judge again.
 */
function installStuckNudge(ctx: Context, resolved: ResolvedConfig, ledger: DecisionLedger): void {
  const threshold = resolved.stuckNudgeAfterFailures
  const quota = resolved.stuckNudgePerTurn
  if (threshold === undefined || quota === undefined) return
  const records = new WeakMap<Agent, StuckRecord>()
  let judge: StuckJudge | undefined

  ctx.inject(['llm'], childCtx => {
    const llm = childCtx.llm
    judge = (agent, failures, signal) => judgeStuck(llm, agent, failures, resolved.stuckNudgeMaxTokens, signal)
    childCtx.effect(() => () => {
      judge = undefined
    }, 'prism-guardrails.stuckJudgeRelease')
  })

  const turnSeen = new WeakMap<Agent, number>()

  ctx.on('agent/pre-step', ({ agent, turn }, next): Promise<PreStepDecision> => {
    // The loop opens every turn, whatever enqueued it — a claimed user message
    // or a scheduled follow-up — so the run and its quota reset per turn rather
    // than per message source.
    if (turnSeen.get(agent) !== turn) {
      turnSeen.set(agent, turn)
      records.delete(agent)
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const decided = await next()
    const agent = exec.agent
    if (agent === undefined) return decided
    // Child calls of a composite tool run the same pipeline with the same
    // agent, and this rail counts them like any other call — the same blind
    // spot the repeat rail has: one child failure each, one child success
    // clearing the run, while the model only sees the parent's outcome.
    const record = records.get(agent) ?? { failures: [], nudged: 0 }
    records.set(agent, record)
    if (result.isError) {
      record.failures.push({ tool: exec.name, message: failureText(result) })
    } else {
      record.failures.length = 0
    }
    if (record.failures.length < threshold || record.nudged >= quota) return decided
    const bound = judge
    if (bound === undefined) {
      ctx.logger.warn('prism-guardrails: stuck chain reached the threshold but no llm service is mounted; no nudge sent')
      return decided
    }
    const judgement = await bound(agent, record.failures, exec.signal).catch((error: unknown) => {
      ctx.logger.warn('prism-guardrails: the stuck judge call failed; no nudge sent')
      ctx.logger.warn(error)
      return undefined
    })
    if (judgement === 'no-route') {
      ctx.logger.warn('prism-guardrails: the stuck judge has no routed model to call; no nudge sent')
      return decided
    }
    if (judgement === 'unusable') {
      ctx.logger.warn('prism-guardrails: the stuck judge reply was not a readable verdict; no nudge sent')
      return decided
    }
    const verdict = judgement
    if (verdict === undefined || !verdict.spinning || verdict.confidence < resolved.stuckNudgeConfidence) {
      return decided
    }
    if (decided.kind !== 'accept') return decided
    record.nudged += 1
    note(ledger, agent, 'stuck nudge', `${exec.name} failed ${String(record.failures.length)} time(s)`, 'steer')
    return {
      ...decided,
      additionalContexts: [
        createUserMessage({
          content: [{
            type: 'text',
            text: `You have now seen ${String(record.failures.length)} consecutive failures of \`${exec.name}\` with the same `
              + 'outcome. Retrying the same call is unlikely to change it. Read the error and change the approach: '
              + 'try a different method, fix the underlying cause first, or ask the person. If you are genuinely '
              + 'stuck, say so plainly and stop — the person can interrupt at any time.',
          }],
          source: { kind: 'prism-guardrails', form: 'instructions' },
        }),
      ],
    }
  })
}

/** The error text one failed call contributes to the chain, bounded for the judge's prompt. */
function failureText(result: ToolExecutionFailure): string {
  const raw = result.error.message
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  return collapsed.length <= STUCK_FAILURE_TEXT_MAX ? collapsed : `${collapsed.slice(0, STUCK_FAILURE_TEXT_MAX - 1)}…`
}

/**
 * The identity-free instruction for every judge call.
 */
const STUCK_JUDGE_SYSTEM = [
  'You decide whether an agent is stuck in a loop.',
  'The input is a run of consecutive tool failures inside one turn, oldest first.',
  'Answer with JSON only: {"spinning": <true|false>, "confidence": <0..1>}.',
  '"spinning" is true only when the same failure keeps repeating and retrying alone will not fix it.',
  'An empty answer or prose means no verdict.',
].join(' ')

/**
 * The provider route one agent's calls take, or `undefined` when none is recorded.
 * @param agent - the agent whose route is read.
 * @returns the route, or `undefined`.
 */
function routeOf(agent: Agent): { readonly provider: string, readonly model: string } | undefined {
  const routed = agent.session.requestHeader()?.config
  if (routed?.provider !== undefined && routed.provider !== ''
    && routed.model !== undefined && routed.model !== '') {
    return { provider: routed.provider, model: routed.model }
  }
  if (agent.options.provider !== undefined && agent.options.provider !== ''
    && agent.options.model !== undefined && agent.options.model !== '') {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return undefined
}

/**
 * Ask one model whether a run of consecutive failures is a loop.
 *
 * The request is a one-shot call whose content is the chain summary, routed
 * through the agent's own provider route and bound to the failing call's
 * cancellation signal; the caller owns its inputs until the stream settles.
 * @param llm - the llm runtime to dispatch through.
 * @param agent - the agent whose routed model judges the chain.
 * @param failures - the consecutive failures, oldest first.
 * @param maxTokens - the token cap the deployment allows one judge call.
 * @param signal - the failing call's cancellation signal, honored by the judge.
 * @returns the verdict, or why there is none.
 */
async function judgeStuck(
  llm: LlmRuntime,
  agent: Agent,
  failures: readonly StuckFailure[],
  maxTokens: number,
  signal: AbortSignal,
): Promise<StuckJudgement> {
  const route = routeOf(agent)
  if (route === undefined) return 'no-route'
  const summary = failures
    .map((failure, index) => `${index + 1}. [${failure.tool}] ${failure.message}`)
    .join('\n')
  const assembler = new BlockAssembler()
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    system: STUCK_JUDGE_SYSTEM,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `Consecutive tool failures:\n${summary}\n\nIs the agent spinning? Answer as the JSON object.` }],
    }],
    maxTokens,
    signal,
  }
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind !== 'stop' && finish.kind !== 'tool-calls') return 'unusable'
  return parseStuckVerdict(assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')) ?? 'unusable'
}

/**
 * Read one judge reply into a verdict.
 *
 * The first balanced brace region is the answer; anything the model wrapped
 * around it is ignored, and an unreadable region is no verdict.
 * @param raw - the judge's full text output.
 * @returns the verdict, or `undefined`.
 */
function parseStuckVerdict(raw: string): StuckVerdict | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.spinning !== 'boolean') return undefined
  if (!Number.isFinite(record.confidence) || (record.confidence as number) < 0 || (record.confidence as number) > 1) {
    return undefined
  }
  return { spinning: record.spinning, confidence: record.confidence as number }
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
 * The first comment-prefixed `shortcut:` or `ponytail:` marker whose text
 * names no upgrade path.
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

/**
 * Refuse a read of a path the deployment treats as credential material.
 *
 * `deny` rather than `ask`: the read would write the secret into the session
 * log, and no later approval removes it from there. The alternative the model
 * needs — ask the user for the value — never needs the file's contents, so
 * there is nothing for an approval to price.
 *
 * The rail matches the path the call names, not the file it resolves to, so a
 * symlink or a relative detour around a guarded directory is not covered.
 */
function installSensitiveReadDenial(ctx: Context, resolved: ResolvedConfig, ledger: DecisionLedger): void {
  const readTools = resolved.readTools
  const segments = resolved.sensitivePaths
  if (readTools === undefined || segments === undefined) return

  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const pathArgument = readTools.get(exec.name)
    if (pathArgument === undefined) return next()
    const path = stringArgument(exec.arguments, pathArgument)
    if (path === undefined) return next()
    const matched = sensitiveSegment(path, segments)
    if (matched === undefined) return next()
    return decide(ledger, resolved.mode, exec.agent, 'sensitive reads', path, {
      kind: 'deny',
      reason: `\`${exec.name}\` targets ${JSON.stringify(path)}, which this deployment treats as credential `
        + `material (matched ${JSON.stringify(matched)}); reading it would write the secret into the session log `
        + 'permanently. Ask the user for the specific value if it is needed.',
    }, next)
  })
}

/**
 * The configured segment a path names, when it names one.
 *
 * A segment matches by equality or by a dotted extension of the configured
 * name, so `.env.local` is guarded by `.env` while `environment.ts` is not.
 *
 * @param path - a path as a tool call wrote it, under either separator.
 * @param segments - the configured credential segments.
 * @returns the configured segment the path names, or `undefined`.
 */
function sensitiveSegment(path: string, segments: readonly string[]): string | undefined {
  for (const segment of path.split(/[\\/]/u)) {
    const written = segment.toLowerCase()
    for (const name of segments) {
      const wanted = name.toLowerCase()
      if (written === wanted || written.startsWith(`${wanted}.`)) return name
    }
  }
  return undefined
}

/**
 * Send a shell call whose text matches a guarded pattern to approval.
 *
 * `ask` rather than `deny`: deleting a build directory or force-pushing a
 * personal branch is sometimes exactly the intended action, and only a human
 * can tell that from the accident. With no approval channel the fail-closed
 * approval ladder denies the call, which is the intended unattended outcome.
 *
 * `shortcut:` the pattern sees the raw command text, so `bash -c "…"` is still
 * matched, but quoting or variable tricks evade it; upgrade to a shell parser
 * when a consumer needs wrapper-proof matching.
 */
function installCommandGuard(ctx: Context, resolved: ResolvedConfig, ledger: DecisionLedger): void {
  const guard = resolved.commandGuard
  if (guard === undefined) return

  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const commandArgument = guard.tools.get(exec.name)
    if (commandArgument === undefined) return next()
    const command = stringArgument(exec.arguments, commandArgument)
    if (command === undefined) return next()
    for (const rule of guard.rules) {
      if (!rule.pattern.test(command)) continue
      return decide(ledger, resolved.mode, exec.agent, 'command guard', command, {
        kind: 'ask',
        reason: `\`${exec.name}\` would run a command this deployment guards (matched \`${rule.source}\`): `
          + `${rule.reason}; approve only if the command is intended`,
      }, next)
    }
    return next()
  })
}

/**
 * Register `/guardrails`, which reports which rails the deployment has armed.
 *
 * The `commands` service mounts independently of this bundle and may appear
 * after it, so the registration waits for the service instead of reading the
 * store once at apply time. A profile with no commands service keeps every rail
 * and loses only the report.
 */
function installStatusCommand(
  ctx: Context,
  resolved: ResolvedConfig,
  ledger: DecisionLedger,
  version: string,
): void {
  ctx.inject(['commands'], (scope: Context) => {
    scope.effect(() => scope.commands.register({
      definitionId: CommandDefinitionId('prism-guardrails/status'),
      name: 'guardrails',
      description: 'Report which guardrail rails this deployment has armed',
      handler: (invocation): CommandResult => ({
        kind: 'success',
        text: describeRails(resolved, ledger.list(invocation.agent), version),
      }),
    }), 'prism-guardrails.status')
  })
}

/**
 * The status report: a count with the mode and configuration version, one line
 * per rail with its configured value or `off`, and the session's decisions.
 *
 * The mode sits on the first line because observing is a weaker deployment, and
 * a report that hid it would be read as protection it is not.
 *
 * @param resolved - the validated configuration the running deployment uses.
 * @param decisions - the session's recorded decisions, oldest first.
 * @param version - the configuration version those decisions were made under.
 * @returns the text a `/guardrails` invocation prints.
 */
function describeRails(resolved: ResolvedConfig, decisions: readonly Decision[], version: string): string {
  const rails: readonly (readonly [string, string | undefined])[] = [
    ['plan-mode denial', listed(resolved.planDeniedTools)],
    ['repeat approval', resolved.repeatAskAfter === undefined
      ? undefined
      : `after ${String(resolved.repeatAskAfter)} identical calls`],
    ['turn budget', resolved.maxStepsPerTurn === undefined
      ? undefined
      : `${String(resolved.maxStepsPerTurn)} steps`],
    ['unfinished todos', resolved.unfinishedTodoContinuations === undefined
      ? undefined
      : `${String(resolved.unfinishedTodoContinuations)} continuations`],
    ['skill guidance', resolved.skillInvocationGuidance ? 'on' : undefined],
    ['write budget', resolved.maxWrittenFilesPerTurn === undefined
      ? undefined
      : `${String(resolved.maxWrittenFilesPerTurn)} distinct files`],
    ['ponytail markers', resolved.requirePonytailUpgradePaths ? 'on' : undefined],
    ['dependency manifests', listed(resolved.dependencyManifests)],
    ['routing contract', listed(resolved.routingContract)],
    ['verification gate', listed(resolved.verificationGate)],
    ['sensitive reads', resolved.sensitivePaths?.join(', ')],
    ['command guard', resolved.commandGuard === undefined
      ? undefined
      : `${String(resolved.commandGuard.tools.size)} tool(s), ${String(resolved.commandGuard.rules.length)} pattern(s)`],
    ['stuck nudge', resolved.stuckNudgeAfterFailures === undefined || resolved.stuckNudgePerTurn === undefined
      ? undefined
      : `after ${String(resolved.stuckNudgeAfterFailures)} consecutive failures`],
  ]
  const armed = rails.filter(([, detail]) => detail !== undefined).length
  // An observing deployment is not protected, so its first line says so before
  // it says anything else: a reader who takes this report for protection is
  // worse off than with no rails at all.
  const lines = [resolved.mode === 'observe'
    ? `Guardrails: OBSERVE MODE — ${String(armed)} of ${String(rails.length)} rails armed, `
      + `nothing is refused (config ${version}).`
    : `Guardrails: ${String(armed)} of ${String(rails.length)} rails armed (mode: enforce, config ${version}).`]
    .concat(rails.map(([name, detail]) => `${name}: ${detail ?? 'off'}`))
  // The decisions block earns its space only where the ledger carries something
  // the model could not already see, which is the observe run itself: `observed`
  // is the only outcome that mode writes.
  if (resolved.mode === 'observe') lines.push(...describeDecisions(decisions))
  return lines.join('\n')
}

/**
 * The decisions block: a count, then the `observe` records the mode produced.
 *
 * Only `observed` rows are listed. An enforced `deny` is text the model read, and
 * an enforced `ask` is a decision the approver made, so neither tells an operator
 * what they do not already know; the rows that matter are the calls a rail would
 * have stopped and did not.
 *
 * @param decisions - the session's recorded decisions, oldest first.
 * @returns the block's lines.
 */
function describeDecisions(decisions: readonly Decision[]): readonly string[] {
  const observed = decisions.filter(decision => decision.outcome === 'observed')
  const lines = [`decisions this session: ${String(decisions.length)} (${String(observed.length)} observed)`]
  for (const decision of observed.slice(-MAX_REPORTED_DECISIONS)) {
    lines.push(`  observed  ${decision.rail}  ${subjectForReport(decision.subject)}`)
  }
  return lines
}

/**
 * One decision's subject, shortened for a report line.
 *
 * @param subject - the tool name, path, or command a rail judged.
 * @returns the subject, truncated on a code-point boundary with an ellipsis.
 */
function subjectForReport(subject: string): string {
  const points = [...subject.replaceAll('\n', ' ')]
  return points.length <= MAX_REPORTED_SUBJECT ? points.join('')
    : `${points.slice(0, MAX_REPORTED_SUBJECT - 1).join('')}…`
}

/**
 * A configured name set as one report value.
 *
 * @param names - the set a rail resolved, or `undefined` when the rail is off.
 * @returns the names joined for the report, or `undefined` when the rail is off.
 */
function listed(names: ReadonlySet<string> | undefined): string | undefined {
  return names === undefined ? undefined : [...names].join(', ')
}
