/**
 * Capability-hardening bundle: four places where DeepSeek Harness offers an
 * advisory capability become enforced ones.
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
 *
 * The configuration surface, each rail's exact behavior, and the DeepSeek
 * Harness capability each one replaces are in the package README.
 *
 * @module prism-guardrails
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PlanModeController } from '@deepseek-ai/dsh-plan-mode'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
import type { PostToolDecision, PreToolDecision } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from './config.ts'
import type { Config, ResolvedConfig } from './config.ts'

/** Cordis plugin name; also the `cordis.patch.yml` row id this bundle inserts. */
export const name = 'prism-guardrails'

/** The tool registry owns every registration this bundle makes. */
export const inject = ['tools']

/**
 * The model-facing loader registered by `@deepseek-ai/dsh-tool-skill`. A
 * protocol constant: the skill capability's one model-facing entry point.
 */
export const SKILL_TOOL = 'skill'

/** One agent's consecutive-repeat chain: the last tracked call's identity and its run length. */
interface RepeatChain {
  readonly key: string
  readonly count: number
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
    const requested = skillNameArgument(exec.arguments)
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
 * The `name` argument of a call, when the call carries one.
 *
 * `exec.arguments` is typed `unknown` and reaches this bundle from model tool
 * JSON. The registry validates a call against the tool's compiled object schema
 * first, so a non-object cannot arrive through the shipped tool set; the guard
 * keeps the function total at that boundary rather than throwing inside a
 * pre-execute listener, which would fail every call to the tool.
 *
 * @param argumentsValue - the call's parsed arguments.
 * @returns the requested name, or `undefined` when the call carries none.
 */
function skillNameArgument(argumentsValue: unknown): string | undefined {
  if (typeof argumentsValue !== 'object' || argumentsValue === null) return undefined
  const value = (argumentsValue as { name?: unknown }).name
  return typeof value === 'string' && value !== '' ? value : undefined
}
