/**
 * Compose-next as a plugin capability rather than a skill.
 *
 * The method pack hands the model a nine-phase workflow (Orient → Grill → Spec
 * → Workspace → Implement → Verify → Review → Finalize → Finish) and asks it to
 * enter only on an explicit request. This entry makes the workflow part of the
 * plugin instead: one system-prompt section carries the level and `/compose-next`
 * owns the gestures the skill set described. The bundle patch mounts this row in
 * every profile, so every agent mode reads the same section; a profile that does
 * not want it switches it off with `level: off` instead of uninstalling a skill.
 *
 * The section carries the phases, not the skill's full text: the skill stays the
 * authority for a human-invoked run, and this row is what a long task falls back
 * to when nobody asked for the workflow.
 *
 * `autoLongTaskSteps` deliberately overrides the skill's "explicit request only"
 * entry rule. A deployment that sets it accepts an unrequested spec document on
 * a long turn; `0` keeps the skill's rule.
 *
 * @module prism-guardrails/compose
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

/** The modes a session can run in; `off` keeps the section and command mounted but silent. */
export type ComposeLevel = 'off' | 'lite' | 'full'

/** Every accepted level, in the order the help card lists them. */
export const COMPOSE_LEVELS: readonly ComposeLevel[] = ['lite', 'full', 'off']

/** Deployment configuration for the mode entry. */
export interface Config {
  /** Level a session starts in when no automatic rule matches. Defaults to `off`. */
  readonly level?: ComposeLevel
  /** Cumulative steps after which a turn counts as a long task and switches to `lite`; `0` disables. Defaults to `20`. */
  readonly autoLongTaskSteps?: number
}

/** Cumulative steps in one session that make it a long task. */
const DEFAULT_LONG_TASK_STEPS = 20

/** Resolved automatic-switching rules. */
export interface AutoRules {
  /** Cumulative step count that switches the session to `lite`; `0` disables the rule. */
  readonly longTaskSteps: number
}

/**
 * Validate the automatic-switching configuration.
 *
 * @param config - the deployment's mode configuration.
 * @returns the resolved rules, with the shipped defaults applied.
 */
export function resolveAutoRules(config: Config): AutoRules {
  const steps = config.autoLongTaskSteps ?? DEFAULT_LONG_TASK_STEPS
  if (!Number.isInteger(steps) || steps < 0) {
    throw new Error(`prism-guardrails: compose autoLongTaskSteps must be an integer >= 0, received ${JSON.stringify(steps)}`)
  }
  return { longTaskSteps: steps }
}

/**
 * The automatic level one session's signals select.
 *
 * @param rules - resolved automatic-switching rules.
 * @param steps - cumulative steps this session has opened.
 * @returns `lite` when the long-task rule matches, otherwise `undefined`.
 */
export function autoLevel(rules: AutoRules, steps: number): ComposeLevel | undefined {
  if (rules.longTaskSteps > 0 && steps >= rules.longTaskSteps) return 'lite'
  return undefined
}

/**
 * Resolve the configured level, failing loud on a value the mode cannot run.
 *
 * @param value - the configured level, when the deployment names one.
 * @returns the level the session starts in, `off` by default.
 */
export function resolveLevel(value: string | undefined): ComposeLevel {
  if (value === undefined) return 'off'
  if (!COMPOSE_LEVELS.includes(value as ComposeLevel)) {
    throw new Error(`prism-guardrails: compose level must be one of ${COMPOSE_LEVELS.join(', ')}, received ${JSON.stringify(value)}`)
  }
  return value as ComposeLevel
}

/** The phases a lite run carries: no durable feature document and no worktree ceremony. */
const LITE_PHASES = [
  '1. Orient — read the repository instructions, the code the change touches, and recent changes before asking anything. Do not ask for facts the environment already answers.',
  '2. Spec — write the change down before code: the problem, the design decisions, what is in and out of scope, the tasks, and how each is accepted. Keep it to the box the change needs.',
  '3. Implement — work the tasks in dependency order. Test public behavior; a bug fix gets a regression test when one can be written.',
  '4. Verify — run the relevant checks and read their output before any claim of completion. An acceptance criterion without evidence is a fail.',
  '5. Review — re-read the complete diff against the spec and hunt omissions: a required behavior with no diff line fails, even though nothing in the diff contradicts it.',
].join('\n')

/** The phases a full run carries, including the workspace and hand-off gates. */
const FULL_PHASES = [
  '1. Orient — read the repository instructions, the code the change touches, and recent changes before asking anything. Do not ask for facts the environment already answers.',
  '2. Grill — settle one open decision before building, with concrete options and a recommended one. Do not ask for permission while no decision remains.',
  '3. Spec — one document per feature carrying the problem, the design decisions, scope in and out, the tasks, and the acceptance criteria.',
  '4. Workspace — never implement on the main branch without explicit consent; use an isolated branch or worktree and record it.',
  '5. Implement — work the tasks in dependency order. Test public behavior; a bug fix gets a regression test when one can be written.',
  '6. Verify — run the relevant checks and read their output; record each command and its result. Prior output or a subagent report is not fresh evidence.',
  '7. Review — a fresh read of the complete diff: spec compliance, correctness, and consistency with the surrounding code.',
  '8. Finalize — mark the spec delivered with its evidence and commit it.',
  '9. Finish — report the branch, the evidence, and what remains; ask before any irreversible step such as pushing, merging, or opening a pull request.',
].join('\n')

/**
 * The prompt section for one level.
 *
 * @param level - the level the profile is running.
 * @returns the section text, or an empty string when the mode is off.
 */
export function sectionText(level: ComposeLevel): string {
  if (level === 'off') return ''
  return [
    `COMPOSE (level: ${level})`,
    '',
    'This session runs the compose workflow. Carry the work through these phases in order; do not jump to implementation.',
    level === 'full' ? FULL_PHASES : LITE_PHASES,
    '',
    'Stop for an open product decision, a blocker that cannot be worked around, or a destructive action that needs consent; otherwise continue through the phases without approval pauses.',
    'Anti-drift: if an approach failed twice, change strategy or stop and ask. Never rationalize a skipped phase — "it is already done", "I will verify later" and "the workflow is overkill" are exactly that.',
  ].join('\n')
}

const HELP_CARD = [
  'Compose levels',
  '  /compose-next        show the current level and these gestures',
  '  /compose-next lite   five phases: orient, spec, implement, verify, review',
  '  /compose-next full   the nine phases, including workspace and hand-off gates',
  '  /compose-next off    stop the mode (the command stays mounted)',
  '  /compose-next auto   drop an explicit choice and follow the automatic rule again',
  '',
  'Automatic rule (a session starts at the configured level, then):',
  '  Long task            a session past the configured step count runs at lite',
  '  An explicit /compose-next choice wins until /compose-next auto.',
].join('\n')

/** Cordis plugin name; also the `cordis.patch.yml` row id this bundle inserts. */
export const name = 'prism-guardrails-compose'

/** Registries this row contributes to. */
export const inject = ['systemPrompt', 'commands'] as const

/** Order of the mode section inside the assembled prompt, after Ponytail and before tools. */
const COMPOSE_SECTION_ORDER = 31

/** Split one invocation into its lowercase first word and the remaining text. */
function firstWord(raw: string): { word: string; rest: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { word: '', rest: '' }
  const separator = trimmed.search(/\s/u)
  if (separator < 0) return { word: trimmed.toLowerCase(), rest: '' }
  return { word: trimmed.slice(0, separator).toLowerCase(), rest: trimmed.slice(separator).trim() }
}

/** Per-session state the mode resolves from. */
interface ModeState {
  /** Level an explicit `/compose-next` chose, which wins over the automatic rule. */
  readonly explicit: WeakMap<Agent, ComposeLevel>
  /** Cumulative steps this session has opened. */
  readonly steps: WeakMap<Agent, number>
}

/**
 * The level one assembly runs at, and the rule that chose it.
 *
 * @param state - live per-session state.
 * @param rules - resolved automatic-switching rules.
 * @param agent - the assembly's agent, absent on diagnostics.
 * @param fallback - the configured level when no rule matches.
 * @returns the level and, for an automatic choice, the step count that chose it.
 */
function effectiveLevel(
  state: ModeState,
  rules: AutoRules,
  agent: Agent | undefined,
  fallback: ComposeLevel,
): { level: ComposeLevel; steps?: number } {
  if (agent === undefined) return { level: fallback }
  const explicit = state.explicit.get(agent)
  if (explicit !== undefined) return { level: explicit }
  const steps = state.steps.get(agent) ?? 0
  const rule = autoLevel(rules, steps)
  return rule === undefined ? { level: fallback } : { level: rule, steps }
}

/**
 * Install the mode section and its command.
 *
 * The section resolves the level per assembly from the session's own state, so
 * one long session running under compose never changes the level of a session
 * beside it. An explicit `/compose-next` choice wins over the automatic rule.
 *
 * @param ctx - plugin context; the section and command registration are scoped to it.
 * @param config - deployment configuration; the level and automatic rules are validated here so a typo fails at load.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const fallback = resolveLevel(config.level)
  const rules = resolveAutoRules(config)
  const state: ModeState = { explicit: new WeakMap(), steps: new WeakMap() }

  ctx.on('agent/pre-step', ({ agent }, next) => {
    state.steps.set(agent, (state.steps.get(agent) ?? 0) + 1)
    return next()
  })

  ctx.systemPrompt.section({
    name: 'compose',
    order: COMPOSE_SECTION_ORDER,
    text: context => sectionText(effectiveLevel(state, rules, context.agent, fallback).level),
  })

  const report = (agent: Agent): CommandResult => {
    const { level, steps } = effectiveLevel(state, rules, agent, fallback)
    if (level === 'off') return { kind: 'success', text: 'Compose mode is off. `/compose-next lite|full` turns it on.' }
    return {
      kind: 'success',
      text: steps === undefined ? `Compose mode: ${level}.` : `Compose mode: ${level} (auto: long task, ${String(steps)} steps).`,
    }
  }

  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('prism-guardrails/compose-next'),
    name: 'compose-next',
    description: 'Show or set the Compose workflow level (lite, full, off, auto)',
    input: { hint: 'lite | full | off | auto' },
    handler: (invocation: CommandInvocation): CommandResult => {
      const { word } = firstWord(invocation.rawInput)
      if (word === '') return { kind: 'success', text: `${String(report(invocation.agent).text ?? '')}\n\n${HELP_CARD}` }
      if (word === 'help') return { kind: 'success', text: HELP_CARD }
      if (word === 'auto') {
        state.explicit.delete(invocation.agent)
        return report(invocation.agent)
      }
      if (!COMPOSE_LEVELS.includes(word as ComposeLevel)) {
        return { kind: 'error', text: `/compose-next: unknown level "${word}". Use ${COMPOSE_LEVELS.join(', ')}, auto.` }
      }
      state.explicit.set(invocation.agent, word as ComposeLevel)
      return report(invocation.agent)
    },
  }), 'prism-guardrails.compose-next')
}
