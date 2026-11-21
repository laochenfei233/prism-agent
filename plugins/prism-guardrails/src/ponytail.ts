/**
 * Ponytail as a plugin capability rather than a skill.
 *
 * The method pack asks the model to behave like a lazy senior developer. This
 * entry makes that request part of the plugin instead of text a host has to
 * install separately: one system-prompt section carries the level, and slash
 * commands own the gestures the skill set used to describe (`/ponytail`,
 * `/ponytail-debt`, `/ponytail-review`, `/ponytail-audit`, `/ponytail-gain`,
 * `/ponytail-help`). The bundle patch mounts this row in every profile, so the
 * mode is present under every agent preset, and a profile that does not want it
 * switches it off with `level: off` instead of uninstalling a skill.
 *
 * The rails in `index.ts` stay the enforcement half: this entry states the
 * rules, and those rails refuse the writes that break them.
 *
 * @module prism-guardrails/ponytail
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PONYTAIL_MARKER } from './marker.ts'

/** The modes a session can run in; `off` keeps the section and commands mounted but silent. */
export type PonytailLevel = 'off' | 'lite' | 'full' | 'ultra'

/** Every accepted level, in the order the help card lists them. */
export const PONYTAIL_LEVELS: readonly PonytailLevel[] = ['lite', 'full', 'ultra', 'off']

/** Deployment configuration for the mode entry. */
export interface Config {
  /** Level a session starts in when no automatic rule matches. Defaults to `full`. */
  readonly level?: PonytailLevel
  /** Agent presets that count as coding work and switch the session to `lite`. */
  readonly autoCodingPresets?: readonly string[]
  /** Steps after which a turn counts as a long task and switches to `lite`; `0` disables. */
  readonly autoLongTaskSteps?: number
}

/** Coding presets shipped by the Web bundle; a deployment adds its own ids here. */
const DEFAULT_CODING_PRESETS: readonly string[] = ['standard', 'ptc']

/** Cumulative steps in one session that make it a long task. */
const DEFAULT_LONG_TASK_STEPS = 20

/** Resolved automatic-switching rules. */
export interface AutoRules {
  /** Presets that switch the session to `lite`. */
  readonly codingPresets: readonly string[]
  /** Cumulative step count that switches the session to `lite`; `0` disables the rule. */
  readonly longTaskSteps: number
}

/** What the automatic rules may look at when deciding a session's level. */
export interface AutoSignals {
  /** The agent preset the session runs under, when it records one. */
  readonly preset?: string
  /** Cumulative steps this session has opened. */
  readonly steps?: number
}

/**
 * Validate the automatic-switching configuration.
 *
 * @param config - the deployment's mode configuration.
 * @returns the resolved rules, with the shipped defaults applied.
 */
export function resolveAutoRules(config: Config): AutoRules {
  const presets = config.autoCodingPresets ?? DEFAULT_CODING_PRESETS
  if (!Array.isArray(presets) || presets.some(preset => typeof preset !== 'string' || preset.trim() === '')) {
    throw new Error('prism-guardrails: ponytail autoCodingPresets must be an array of non-empty preset ids')
  }
  const steps = config.autoLongTaskSteps ?? DEFAULT_LONG_TASK_STEPS
  if (!Number.isInteger(steps) || steps < 0) {
    throw new Error(`prism-guardrails: ponytail autoLongTaskSteps must be an integer >= 0, received ${JSON.stringify(steps)}`)
  }
  return { codingPresets: [...presets], longTaskSteps: steps }
}

/**
 * The automatic level one session's signals select.
 *
 * A coding preset switches immediately; a turn that has opened enough steps
 * counts as a long task. The first matching rule wins, and `undefined` means
 * the deployment default applies.
 *
 * @param rules - resolved automatic-switching rules.
 * @param signals - the session's preset and cumulative step count.
 * @returns `lite` when a rule matches, otherwise `undefined`.
 */
export function autoLevel(rules: AutoRules, signals: AutoSignals): PonytailLevel | undefined {
  if (signals.preset !== undefined && rules.codingPresets.includes(signals.preset)) return 'lite'
  if (rules.longTaskSteps > 0 && (signals.steps ?? 0) >= rules.longTaskSteps) return 'lite'
  return undefined
}

/** Cordis plugin name; also the `cordis.patch.yml` row id this bundle inserts. */
export const name = 'prism-guardrails-ponytail'

/** Registries this row contributes to. */
export const inject = ['systemPrompt', 'commands'] as const

/** Order of the mode section inside the assembled prompt, after the persona and before tools. */
const PONYTAIL_SECTION_ORDER = 30

/** Directories never worth scanning for markers. */
const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.cache',
  '.venv', 'venv', '__pycache__', '.pnpm-store', '.turbo',
])

/** Extensions whose comments can carry a marker. */
const SCANNED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt',
  '.cs', '.c', '.h', '.cc', '.cpp', '.hpp', '.rb', '.php', '.swift', '.scala', '.sh', '.ps1', '.lua', '.sql',
])

/** Files larger than this are skipped; a marker ledger does not need generated blobs. */
const MAX_FILE_BYTES = 262_144

/** Directories visited per scan. */
const MAX_DIRECTORIES = 2_000

/** Ledger rows reported per scan. */
const MAX_ROWS = 200

/** One marker found in the workspace. */
export interface ShortcutRow {
  /** Repository-relative path. */
  readonly file: string
  /** 1-based line number. */
  readonly line: number
  /** Text after the marker prefix. */
  readonly text: string
  /** Whether the marker names no upgrade path, which makes it silently rot. */
  readonly noTrigger: boolean
}

/** Resolve the configured level, failing loud on a value the mode cannot run. */
export function resolveLevel(value: string | undefined): PonytailLevel {
  if (value === undefined) return 'full'
  if (!PONYTAIL_LEVELS.includes(value as PonytailLevel)) {
    throw new Error(`prism-guardrails: ponytail level must be one of ${PONYTAIL_LEVELS.join(', ')}, received ${JSON.stringify(value)}`)
  }
  return value as PonytailLevel
}

const LADDER = [
  'Take the first option that fully works:',
  '1. Does it need to exist? Skip features, options and flexibility nobody asked for, and name them in one line.',
  '2. Already in this codebase (a helper, component, service, pattern)? Use it the way the surrounding code does.',
  '3. Standard library or a platform feature? Use it, unless the project has its own.',
  '4. An installed dependency? Use it. Never add a dependency for a few lines.',
  '5. Can it be one line a reader gets at a glance? One line.',
  '6. Otherwise: the minimum code that works.',
].join('\n')

/**
 * The prompt section for one level.
 *
 * @param level - the level the profile is running.
 * @returns the section text, or an empty string when the mode is off.
 */
export function sectionText(level: PonytailLevel): string {
  if (level === 'off') return ''
  const opening = level === 'lite'
    ? 'You build what was asked with the least new code, and name the smaller option you did not take in one line.'
    : 'You are a lazy senior developer. The best code is the code never written: you solve the whole problem with the least new code.'
  const ultra = level === 'ultra'
    ? '\nBefore building, push back on any part of the request the need does not justify, and say which part you would drop.'
    : ''
  return [
    `PONYTAIL MODE (level: ${level})`,
    '',
    opening,
    '',
    'Before you write, read the task and the code it touches. List every place the change must reach — callers, tests, fixtures, config, exports — and check what it could break for users: data it would destroy or expose, callers that stop working. That is the scope; extra features are not.',
    '',
    LADDER,
    '',
    'Be lazy about the solution, never about the change itself: finish every part the task needs, including the callers and tests your change breaks. No abstraction, wrapper, option, config, or "for later" code nobody asked for; deletion beats addition. Keep the structure the codebase already has.',
    'Bug fix: grep every caller of the function you touch, then fix the root cause once in the shared code.',
    'A shortcut with a known limit gets a code comment in the form `shortcut: <the limit>, <when to upgrade>`.',
    'New non-trivial logic (a branch, a loop, a parser, money or security) leaves one small test or an assert-based self-check.',
    'Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything the user asked for.',
    'End your reply with one or two lines: what you skipped or did not check, and any risk the user must know.',
    ultra,
  ].join('\n').trim()
}

const HELP_CARD = [
  'Ponytail levels',
  '  /ponytail            show the current level and these gestures',
  '  /ponytail full       smallest complete change, a check where the logic needs one (default)',
  '  /ponytail lite       build what was asked, name the smaller option in one line',
  '  /ponytail ultra      also question the request and push back before building',
  '  /ponytail off        stop the mode (the rails and commands stay mounted)',
  '  /ponytail auto       drop an explicit choice and follow the automatic rules again',
  '',
  'Automatic rules (a session starts at the configured level, then):',
  '  Coding preset        a session created under, or switched to, a coding preset runs at lite',
  '  Long task            a session past the configured step count runs at lite',
  '  An explicit /ponytail choice wins over both rules until /ponytail auto.',
  '',
  'Commands',
  '  /ponytail-debt [word]  markers in this workspace as a ledger (default marker word: shortcut)',
  '  /ponytail-review       quality review of the current change: bugs, safety, load, tests, speed, leanness',
  '  /ponytail-audit        the same review for the whole repository',
  '  /ponytail-gain         the published benchmark scoreboard',
  '  /ponytail-help         this card',
].join('\n')

const GAIN_CARD = [
  'ponytail gain           benchmark · 39 tasks × 5 runs · Opus 5.5',
  '',
  '  no-skill        ████████████████████  100%',
  '  Lines of code   █████████···········   47%   ▼ 53%',
  '  Output tokens   ███████████·········   55%   ▼ 45%',
  '  Cost            ███████████████·····   74%   ▼ 26%',
  '  Time            ████████████········   59%   ▼ 41%',
  '  Hidden checks passed   97%  (no-skill 96%)',
  '  Tests where the logic needs one   98%  (no-skill 68%)',
  '',
  'These are benchmark averages for Ponytail 5, not this repository: the unbuilt version was never written, so',
  'there is no per-repo baseline to subtract from. The only real per-repo figures come from /ponytail-debt.',
].join('\n')

const REVIEW_PROMPT = [
  'Review the current change like the senior developer who will be paged when it breaks. Order of importance:',
  'correct, safe, holds under load, tested, fast, lean. Read the diff, then the code it touches: callers of every',
  'changed function, the functions it calls, the tests, the README. Find the expected load in the repo and say',
  'which load you assumed.',
  '',
  'Look for, in this order: (1) bugs — wrong result, crash, missed edge case, a caller the change broke;',
  '(2) risk — security holes, data loss, checks missing at trust boundaries; (3) scale — races, per-item queries,',
  'state that only grows; (4) missing tests — risky logic with no test that fails when it breaks; (5) speed — big',
  'slowdowns; (6) leanness — code to delete, reuse, replace with the standard library, or merge.',
  '',
  'Every finding needs a concrete case: this input or situation leads to this wrong result. No case, no finding.',
  'Propose the smallest fix that works, prefer fixes that delete code, and add no layers or config the problem',
  'does not need. A `shortcut:` marker that names its limit is a decision, not a finding, unless the expected load',
  'already crosses it. No style taste, no "consider", no vague worries.',
].join('\n')

const AUDIT_PROMPT = [
  'Audit this repository like the senior developer who just inherited it and will be paged when it breaks. Order of',
  'importance: correct, safe, holds under load, tested, fast, lean. Map first: read the README, the build and deploy',
  'config, the dependency list, the entry points (main, routes, handlers, jobs, CLI commands) and the tests. Find the',
  'expected load and say which load you assumed. Trace the main flows end to end, and go deep where a mistake costs',
  'the most rather than file by file; say which parts you did not read.',
  '',
  'Look for, in this order: (1) bugs and rules applied differently in two places; (2) risk — security holes, data',
  'loss, checks missing at trust boundaries; (3) scale — races, per-item queries, state that only grows;',
  '(4) missing tests — risky logic with no test that fails when it breaks; (5) speed — big slowdowns;',
  '(6) leanness — dead code, near-duplicate helpers, dependencies doing what a few lines can do, interfaces with one',
  'implementation.',
  '',
  'Every finding needs a concrete case. Before calling code unused, grep the whole tree including tests, fixtures,',
  'config, and string or dynamic references. Propose the smallest fix that works and prefer fixes that delete code. A',
  '`shortcut:` marker that names its limit is a decision, not a finding. No style taste, no "consider", no vague worries.',
].join('\n')

/**
 * Collect `shortcut:`/`ponytail:` markers under one workspace root.
 *
 * @param root - absolute directory the ledger is scoped to.
 * @returns the rows found, the file count read, and whether the scan hit its row cap.
 */
export function scanShortcutLedger(root: string): { rows: ShortcutRow[]; files: number; truncated: boolean } {
  const rows: ShortcutRow[] = []
  let files = 0
  let directories = 0
  let truncated = false
  const walk = (dir: string): void => {
    if (truncated || directories >= MAX_DIRECTORIES) {
      truncated = directories >= MAX_DIRECTORIES
      return
    }
    directories += 1
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!entry.isFile() || !SCANNED_EXTENSIONS.has(extname(entry.name))) continue
      try {
        if (statSync(full).size > MAX_FILE_BYTES) continue
        files += 1
        const text = readFileSync(full, 'utf8')
        let lineNumber = 0
        for (const line of text.split('\n')) {
          lineNumber += 1
          if (!PONYTAIL_MARKER.test(line)) continue
          const marker = line.search(PONYTAIL_MARKER)
          const body = line.slice(marker).replace(PONYTAIL_MARKER, '').trim()
          rows.push({
            file: relative(root, full).replace(/\\/gu, '/'),
            line: lineNumber,
            text: body,
            noTrigger: !body.includes(','),
          })
          if (rows.length >= MAX_ROWS) {
            truncated = true
            return
          }
        }
      } catch {
        continue
      }
    }
  }
  walk(root)
  return { rows, files, truncated }
}

/** Render the ledger report for one scan. */
export function renderLedger(scan: { rows: ShortcutRow[]; files: number; truncated: boolean }): string {
  if (scan.rows.length === 0) return `No shortcut debt in ${String(scan.files)} scanned files. Clean ledger.`
  const grouped = new Map<string, ShortcutRow[]>()
  for (const row of scan.rows) {
    const list = grouped.get(row.file) ?? []
    list.push(row)
    grouped.set(row.file, list)
  }
  const lines: string[] = []
  for (const [file, list] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(file)
    for (const row of list) {
      const [ceiling, ...upgrade] = row.text.split(',')
      lines.push(`  ${String(row.line)}, ${ceiling?.trim() ?? ''}. ceiling: ${ceiling?.trim() ?? '—'}. upgrade: ${upgrade.join(',').trim() || '—'}${row.noTrigger ? '  [no-trigger]' : ''}`)
    }
  }
  const bare = scan.rows.filter(row => row.noTrigger).length
  lines.push('', `${String(scan.rows.length)} markers, ${String(bare)} with no trigger.${scan.truncated ? ' Scan hit its cap; narrow the scope for a complete ledger.' : ''}`)
  return lines.join('\n')
}

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
  /** Level an explicit `/ponytail` chose, which wins over every automatic rule. */
  readonly explicit: WeakMap<Agent, PonytailLevel>
  /** Level a long task selected, with the reason the report names. */
  readonly auto: WeakMap<Agent, { level: PonytailLevel; reason: string }>
  /** Cumulative steps this session has opened. */
  readonly steps: WeakMap<Agent, number>
  /** The preset each session last committed, which supersedes its creation header. */
  readonly selections: Map<string, string>
}

/**
 * The level one assembly runs at, and the rule that chose it.
 *
 * @param state - live per-session state.
 * @param rules - resolved automatic-switching rules.
 * @param agent - the assembly's agent, absent on diagnostics.
 * @param fallback - the configured level when no rule matches.
 * @returns the level and, for an automatic choice, its reason.
 */
function effectiveLevel(
  state: ModeState,
  rules: AutoRules,
  agent: Agent | undefined,
  fallback: PonytailLevel,
): { level: PonytailLevel; reason?: string } {
  if (agent === undefined) return { level: fallback }
  const explicit = state.explicit.get(agent)
  if (explicit !== undefined) return { level: explicit }
  const auto = state.auto.get(agent)
  if (auto !== undefined) return { level: auto.level, reason: auto.reason }
  const sessionId = String(agent.session.id)
  const preset = state.selections.get(sessionId) ?? agent.session.header.agentPreset
  const steps = state.steps.get(agent) ?? 0
  const rule = autoLevel(rules, { ...preset === undefined ? {} : { preset }, steps })
  if (rule === undefined) return { level: fallback }
  const reason = preset !== undefined && rules.codingPresets.includes(preset)
    ? `coding preset "${preset}"`
    : `long task (${String(steps)} steps)`
  return { level: rule, reason }
}

/**
 * Install the mode section and its commands.
 *
 * The section resolves the level per assembly from the session's own state, so
 * one coding session running at lite never changes the level of a session
 * beside it. A coding preset switches a session as soon as it is created or
 * switched, and a session that passes the configured step count counts as a
 * long task; an explicit `/ponytail` choice wins over both.
 *
 * @param ctx - plugin context; the section and every command registration are scoped to it.
 * @param config - deployment configuration; the level and automatic rules are validated here so a typo fails at load.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const fallback = resolveLevel(config.level)
  const rules = resolveAutoRules(config)
  const state: ModeState = {
    explicit: new WeakMap(),
    auto: new WeakMap(),
    steps: new WeakMap(),
    selections: new Map(),
  }

  ctx.on('agent-preset/selected', (sessionId, preset) => {
    state.selections.set(String(sessionId), preset)
  })

  ctx.on('agent/pre-step', ({ agent }, next) => {
    const steps = (state.steps.get(agent) ?? 0) + 1
    state.steps.set(agent, steps)
    if (state.auto.get(agent) === undefined && rules.longTaskSteps > 0 && steps >= rules.longTaskSteps) {
      state.auto.set(agent, { level: 'lite', reason: `long task (${String(steps)} steps)` })
    }
    return next()
  })

  ctx.systemPrompt.section({
    name: 'ponytail',
    order: PONYTAIL_SECTION_ORDER,
    text: context => sectionText(effectiveLevel(state, rules, context.agent, fallback).level),
  })

  const report = (agent: Agent): CommandResult => {
    const { level, reason } = effectiveLevel(state, rules, agent, fallback)
    if (level === 'off') return { kind: 'success', text: 'Ponytail mode is off. `/ponytail lite|full|ultra` turns it back on.' }
    return {
      kind: 'success',
      text: reason === undefined ? `Ponytail mode: ${level}.` : `Ponytail mode: ${level} (auto: ${reason}).`,
    }
  }

  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('prism-guardrails/ponytail'),
    name: 'ponytail',
    description: 'Show or set the Ponytail mode level (lite, full, ultra, off, auto)',
    input: { hint: 'lite | full | ultra | off | auto' },
    handler: (invocation: CommandInvocation): CommandResult => {
      const { word } = firstWord(invocation.rawInput)
      if (word === '') return { kind: 'success', text: `${String(report(invocation.agent).text ?? '')}\n\n${HELP_CARD}` }
      if (word === 'help') return { kind: 'success', text: HELP_CARD }
      if (word === 'auto') {
        state.explicit.delete(invocation.agent)
        return report(invocation.agent)
      }
      if (!PONYTAIL_LEVELS.includes(word as PonytailLevel)) {
        return { kind: 'error', text: `/ponytail: unknown level "${word}". Use ${PONYTAIL_LEVELS.join(', ')}, auto.` }
      }
      state.explicit.set(invocation.agent, word as PonytailLevel)
      return report(invocation.agent)
    },
  }), 'prism-guardrails.ponytail')

  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('prism-guardrails/ponytail-help'),
    name: 'ponytail-help',
    description: 'Reference card for the Ponytail levels and commands',
    handler: () => ({ kind: 'success', text: HELP_CARD }),
  }), 'prism-guardrails.ponytail-help')

  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('prism-guardrails/ponytail-gain'),
    name: 'ponytail-gain',
    description: 'Published benchmark scoreboard for the Ponytail method',
    handler: () => ({ kind: 'success', text: GAIN_CARD }),
  }), 'prism-guardrails.ponytail-gain')

  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('prism-guardrails/ponytail-debt'),
    name: 'ponytail-debt',
    description: 'List `shortcut:` markers in this workspace as a debt ledger',
    input: { hint: '[marker word]' },
    handler: (invocation: CommandInvocation): CommandResult => {
      const root = invocation.agent.session.header.cwd
      if (root === undefined) return { kind: 'error', text: '/ponytail-debt: this session has no working directory.' }
      const custom = firstWord(invocation.rawInput).word
      const scan = scanShortcutLedger(root)
      const rows = custom === '' || custom === 'shortcut' || custom === 'ponytail'
        ? scan
        : { ...scan, rows: scan.rows.filter(row => row.text.toLowerCase().includes(custom)) }
      return { kind: 'success', text: renderLedger(rows) }
    },
  }), 'prism-guardrails.ponytail-debt')

  const steer = (invocation: CommandInvocation, prompt: string, label: string): CommandResult => {
    invocation.agent.inject(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'prism-guardrails', form: 'instructions' },
    }))
    return { kind: 'success', text: `${label} sent to the agent.` }
  }

  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('prism-guardrails/ponytail-review'),
    name: 'ponytail-review',
    description: 'Quality review of the current change, with a case for every finding',
    handler: (invocation: CommandInvocation) => steer(invocation, REVIEW_PROMPT, 'Ponytail review'),
  }), 'prism-guardrails.ponytail-review')

  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('prism-guardrails/ponytail-audit'),
    name: 'ponytail-audit',
    description: 'The same quality review, for the whole repository',
    handler: (invocation: CommandInvocation) => steer(invocation, AUDIT_PROMPT, 'Ponytail audit'),
  }), 'prism-guardrails.ponytail-audit')
}
