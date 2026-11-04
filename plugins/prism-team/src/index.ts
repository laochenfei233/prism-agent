/**
 * Team capabilities the experimental Agent Teams packages leave open: a
 * structured report instead of prose, one needs-a-person list, a private
 * worktree per teammate, and an enforced write scope.
 *
 * Every part attaches to a documented extension point and owns its decision
 * there, so this bundle adds behavior without rewriting an upstream package:
 *
 * - **Reports** — `team_report` turns a teammate's progress into a structured
 *   status the Lead receives as one message, so coordination stops depending on
 *   free text read out of order.
 * - **The needs-a-person list** — `/team` orders blocked, failed, ready and
 *   waiting rows before working ones, and a healthy team takes one line.
 * - **A worktree per teammate** — a teammate gets its own `git worktree` and
 *   branch, so two members stop editing one checkout.
 * - **The write scope** — a teammate's write outside the scope of the task it
 *   claimed goes to approval instead of proceeding. The task board calls those
 *   scopes advisory; here the write tools obey them.
 *
 * The configuration surface and each part's exact behavior are in the package
 * README.
 *
 * @module prism-team
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TeamMembership } from '@deepseek-ai/dsh-experimental-agent-team'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

/** How the write scope applies: `observe` records a refusal and lets the write through. */
export type Mode = 'enforce' | 'observe'

/** Deployment configuration for the team bundle. */
export interface Config {
  /** Whether an out-of-scope write is refused (`enforce`) or only recorded (`observe`). Defaults to `enforce`. */
  readonly mode?: Mode
  /** Whether each teammate gets its own git worktree. Defaults to `true`. */
  readonly worktree?: boolean
  /** Write tools whose `file_path` argument the scope check judges. Defaults to `write`, `edit`, and `str_replace_editor`. */
  readonly writeTools?: readonly string[]
  /** Reports kept per team in the in-memory ledger. Defaults to `200`. */
  readonly maxReports?: number
}

/** Validated configuration. */
export interface ResolvedConfig {
  /** How the write scope applies. */
  readonly mode: Mode
  /** Whether each teammate gets its own git worktree. */
  readonly worktree: boolean
  /** Write tools the scope check judges. */
  readonly writeTools: ReadonlySet<string>
  /** Reports kept per team. */
  readonly maxReports: number
}

/** Write tools the shipped profiles expose, all taking the same path argument. */
const DEFAULT_WRITE_TOOLS: readonly string[] = ['write', 'edit', 'str_replace_editor']

/** Reports kept per team unless the deployment says otherwise. */
const DEFAULT_MAX_REPORTS = 200

/** Statuses a teammate reports. `observed` is the ledger's own row for a downgraded write. */
const REPORT_STATUSES = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'] as const

/** One reported status. */
type ReportStatus = typeof REPORT_STATUSES[number]

/** One entry in a team's ledger: a report, or a write the scope check would have refused. */
export interface LedgerEntry {
  /** Member name that produced the entry. */
  readonly name: string
  /** Reported status, or `observed` for a write the scope check let through. */
  readonly status: ReportStatus | 'observed'
  /** What the member reported, or the path a write touched. */
  readonly summary: string
  /** Task the report names, when it names one. */
  readonly taskId?: string
}

/**
 * Validate the deployment configuration, failing loud on a value the bundle cannot run.
 *
 * @param config - the deployment's configuration.
 * @returns the resolved configuration, with defaults applied.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const mode = config.mode ?? 'enforce'
  if (mode !== 'enforce' && mode !== 'observe') {
    throw new Error(`prism-team: mode must be "enforce" or "observe", received ${JSON.stringify(mode)}`)
  }
  const maxReports = config.maxReports ?? DEFAULT_MAX_REPORTS
  if (!Number.isInteger(maxReports) || maxReports < 1) {
    throw new Error(`prism-team: maxReports must be an integer >= 1, received ${JSON.stringify(maxReports)}`)
  }
  const writeTools = config.writeTools ?? DEFAULT_WRITE_TOOLS
  if (!Array.isArray(writeTools) || writeTools.some(tool => typeof tool !== 'string' || tool.trim() === '')) {
    throw new Error('prism-team: writeTools must be an array of non-empty tool names')
  }
  return { mode, worktree: config.worktree ?? true, writeTools: new Set(writeTools), maxReports }
}

/** Per-team report ledger with the bound the deployment set. */
export interface Ledger {
  /**
   * Append one entry, dropping the oldest once the bound is reached.
   * @param team - brand of the team the entry belongs to.
   * @param entry - the report or observation.
   */
  record(team: string, entry: LedgerEntry): void
  /**
   * Read one team's entries, oldest first.
   * @param team - brand of the team to read.
   * @returns the retained entries.
   */
  list(team: string): readonly LedgerEntry[]
}

/**
 * Create the in-memory report ledger.
 *
 * State lives here rather than in the Session log because an out-of-tree plugin
 * cannot write Session events; the report text a teammate sends is the durable
 * copy, and this ledger only answers "what does the team look like right now".
 *
 * @param limit - entries retained per team.
 * @returns the ledger.
 */
export function createLedger(limit: number): Ledger {
  const entries = new Map<string, LedgerEntry[]>()
  return {
    record(team, entry) {
      const list = entries.get(team) ?? []
      list.push(entry)
      if (list.length > limit) list.splice(0, list.length - limit)
      entries.set(team, list)
    },
    list(team) {
      return entries.get(team) ?? []
    },
  }
}

/** Cordis plugin name; also the `cordis.patch.yml` row id this bundle inserts. */
export const name = 'prism-team'

/** Services this bundle reads. */
export const inject = ['agents', 'agentTeams', 'tools', 'systemPrompt', 'commands'] as const

/** Order of the team section inside the assembled prompt, before tools. */
const TEAM_SECTION_ORDER = 40

/** Statuses the needs-a-person list shows before working rows. */
const NEEDS_A_PERSON: ReadonlySet<LedgerEntry['status']> = new Set(['blocked', 'failed', 'ready', 'waiting'])

/** The first eight characters of a Team brand, used in paths and branches. */
function teamShort(id: string): string {
  return id.slice(0, 8)
}

/** The `file_path` a write tool was called with. */
function writtenPath(argumentsValue: unknown): string | undefined {
  if (typeof argumentsValue !== 'object' || argumentsValue === null) return undefined
  const value = (argumentsValue as Record<string, unknown>).file_path
  return typeof value === 'string' ? value : undefined
}

/** One workspace path normalized to the form task write scopes use. */
function relativeTo(root: string, target: string): string | undefined {
  const path = relative(root, resolve(root, target)).split(sep).join('/')
  return path.startsWith('..') ? undefined : path
}

/**
 * Whether one path is covered by any of a task's write scopes.
 *
 * @param root - the session working directory the scopes are relative to.
 * @param target - the path the write named, absolute or relative to `root`.
 * @param scopes - the claimed task's advisory write scopes.
 * @returns whether the path is inside one scope, matched per path segment.
 */
export function withinScopes(root: string, target: string, scopes: readonly string[]): boolean {
  const path = relativeTo(root, target)
  if (path === undefined) return false
  return scopes.some((scope) => {
    const prefix = scope.replace(/\/+$/u, '')
    return path === prefix || path.startsWith(`${prefix}/`)
  })
}

/** One teammate's prepared directory, or why it does not have one. */
type Workspace =
  | { readonly path: string; readonly branch: string }
  | { readonly warning: string }

/**
 * Create the teammate's own worktree and branch under the Lead's checkout.
 *
 * A failure is reported to the member instead of thrown: the teammate is
 * already created by the Team service, so refusing here would leave a member
 * with no explanation of why it has no directory.
 *
 * @param root - the Team Lead's working directory, when it records one.
 * @param short - the team's short brand.
 * @param member - the teammate's immutable name.
 * @returns the prepared path and branch, or a warning to state in the member's prompt.
 */
function prepareWorktree(root: string | undefined, short: string, member: string): Workspace {
  if (root === undefined) return { warning: 'the Team Lead session records no working directory' }
  const path = join(root, '.worktrees', `team-${short}-${member}`)
  const branch = `team/${short}/${member}`
  if (existsSync(path)) return { path, branch }
  try {
    const ignore = join(root, '.worktrees', '.gitignore')
    if (!existsSync(ignore)) {
      mkdirSync(join(root, '.worktrees'), { recursive: true })
      writeFileSync(ignore, '*\n')
    }
    execFileSync('git', ['-C', root, 'worktree', 'add', path, '-b', branch], { stdio: 'pipe', timeout: 30_000 })
    return { path, branch }
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)
    return { warning: `git worktree add failed: ${detail}` }
  }
}

/** The prompt section one member reads. */
function sectionText(membership: TeamMembership, workspace: Workspace | undefined): string {
  const lines = [
    `PRISM TEAM (${membership.role} "${membership.name}")`,
    '',
    'Report through `team_report` rather than prose: one status per report, `summary` saying where the work stands. Statuses are `progress`, `waiting`, `ready`, `blocked`, `failed`, and `dropped`. Use `waiting` only when you need a decision from the Lead, and say what the decision is.',
    'Claim a shared task before writing files, and keep writes inside the `writeScopes` the task names. A write outside that scope goes to approval; a write with no claimed task is refused the same way.',
    '`/team` prints the roster, the open tasks, and every report this team has recorded, needs-a-person rows first.',
  ]
  if (workspace !== undefined) {
    lines.push(
      '',
      'path' in workspace
        ? `You have your own checkout at ${workspace.path} (branch ${workspace.branch}). Work there with absolute paths, commit on that branch, and tell the Lead the branch when the work is ready.`
        : `You have no isolated checkout: ${workspace.warning}. Work in the shared directory and report the files you touched.`,
    )
  }
  return lines.join('\n')
}

/** One member's roster line, with the live status the roster reports. */
function memberLine(member: { readonly name: string; readonly status: string }): string {
  return `  ${member.name.padEnd(12)} ${member.status}`
}

/**
 * Install the tools and section one Team member needs.
 *
 * @param ctx - the plugin context every member-scoped registration derives from.
 * @param agent - the exact live member.
 * @param membership - its resolved team role.
 * @param ledger - the shared team ledger.
 * @param workspace - the member's prepared directory, when the deployment asks for one.
 * @returns the disposer that unwinds every registration.
 */
function installMember(
  ctx: Context,
  agent: Agent,
  membership: TeamMembership,
  ledger: Ledger,
  workspace: Workspace | undefined,
): () => void {
  const scoped = agent.ctx
  const team = String(membership.id)
  const disposers: (() => void)[] = []
  try {
    disposers.push(scoped.systemPrompt.section({
      name: 'prism-team',
      order: TEAM_SECTION_ORDER,
      text: () => sectionText(membership, workspace),
    }))
    disposers.push(scoped.tools.register(defineTool({
      name: 'team_report',
      description: 'Report one structured status for your Team work. The Lead receives it as one message; the status is what `/team` groups.',
      parameters: {
        status: { type: 'string', required: true, enum: [...REPORT_STATUSES], description: 'progress while working, waiting when you need a decision, ready when there is a result to review, blocked or failed when you cannot continue, dropped when there is nothing to do.' },
        summary: { type: 'string', required: true, description: 'Where the work stands in one or two sentences, and what the Lead should do next when the status needs a person.' },
        task_id: { type: 'string', description: 'Shared task this report is about, when it is about one.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            delivered: { type: 'boolean', required: true },
            status: { type: 'string', required: true },
            reports: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const entry: LedgerEntry = {
          name: membership.name,
          status: args.status as ReportStatus,
          summary: args.summary,
          ...args.task_id === undefined ? {} : { taskId: args.task_id },
        }
        const delivered = membership.role === 'teammate'
        if (delivered) {
          const text = `Report from ${membership.name} [${entry.status}]: ${entry.summary}`
            + (entry.taskId === undefined ? '' : ` (task ${entry.taskId})`)
          await ctx.agentTeams.sendMessage(agent, {
            target: 'lead',
            content: [{ type: 'text', text }],
            signal: exec.signal,
          })
        }
        ledger.record(team, entry)
        return { delivered, status: entry.status, reports: ledger.list(team).length }
      },
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * Refuse a teammate's write outside the scope of the task it claimed.
 *
 * A path inside a claimed task's `writeScopes` is the explicit case and passes;
 * everything else is inferred and goes to approval, where a person prices it.
 * Under `observe` the same decision is recorded and the write proceeds.
 *
 * @param ctx - the plugin context the listener is scoped to.
 * @param config - resolved configuration.
 * @param ledger - the shared team ledger.
 */
function installWriteGate(ctx: Context, config: ResolvedConfig, ledger: Ledger): void {
  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (agent === undefined) return next()
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership === undefined || membership.role === 'lead') return next()
    if (!config.writeTools.has(exec.name)) return next()
    const path = writtenPath(exec.arguments)
    if (path === undefined) return next()
    const root = agent.session.header.cwd
    if (root === undefined) return next()

    const claimed = ctx.agentTeams.listTasks(agent).filter(task => task.status === 'in_progress')
    const covered = claimed.some(task => withinScopes(root, path, task.writeScopes))
    if (covered) return next()

    const reason = claimed.length === 0
      ? `\`${path}\` is written with no claimed shared task, so no write scope covers it. Claim the task this work belongs to (team_task_list, then team_task_update with action "claim") and retry.`
      : `\`${path}\` is outside the write scopes of your claimed task (${claimed.map(task => `${task.id}: ${task.writeScopes.join(', ') || 'none'}`).join('; ')}). Either stay inside that scope or tell the Lead the task's scope is wrong.`
    const team = String(membership.id)
    if (config.mode === 'observe') {
      ledger.record(team, { name: membership.name, status: 'observed', summary: path })
      return next()
    }
    ledger.record(team, { name: membership.name, status: 'blocked', summary: path })
    return Promise.resolve({ kind: 'ask', reason })
  })
}

/** Format one report row for `/team`. */
function reportRow(entry: LedgerEntry): string {
  const task = entry.taskId === undefined ? '' : `  ${entry.taskId}`
  return `  ${entry.status.padEnd(9)} ${entry.name.padEnd(12)} ${entry.summary}${task}`
}

/**
 * Install the `/team` command, which any member may run.
 *
 * @param ctx - the plugin context the command is scoped to.
 * @param ledger - the shared team ledger.
 */
function installTeamCommand(ctx: Context, ledger: Ledger): void {
  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('prism-team/team'),
    name: 'team',
    description: 'Show the roster, the open tasks, and the reports this team recorded, needs-a-person rows first',
    handler: (invocation: CommandInvocation): CommandResult => {
      const agent = invocation.agent
      const membership = ctx.agentTeams.tryMembership(agent)
      if (membership === undefined) return { kind: 'error', text: '/team: this session is not a Team member.' }
      const team = String(membership.id)
      const members = ctx.agentTeams.listMembers(agent)
      const tasks = ctx.agentTeams.listTasks(agent)
      const entries = ledger.list(team)
      const needs = entries.filter(entry => NEEDS_A_PERSON.has(entry.status))
      const working = entries.filter(entry => !NEEDS_A_PERSON.has(entry.status))

      const lines = [`Team ${teamShort(team)}: ${String(members.length)} members, ${String(tasks.length)} open tasks (${String(needs.length)} need a person).`]
      if (needs.length > 0) lines.push('', 'needs a person:', ...needs.map(reportRow))
      if (working.length > 0) lines.push('', 'working:', ...working.map(reportRow))
      if (tasks.length > 0) {
        lines.push('', 'tasks:', ...tasks.map(task => `  ${task.id} ${task.status}${task.ownerName === undefined ? '' : ` (${task.ownerName})`}${task.ready ? '' : ' blocked'} · ${task.subject}`))
      }
      lines.push('', ...members.map(member => memberLine(member)))
      return { kind: 'success', text: lines.join('\n') }
    },
  }), 'prism-team.team()')
}

/**
 * Install the team bundle.
 *
 * Members are resolved from the live Team service, so a session that is not on
 * a team receives no tool, no section, and no write check.
 *
 * @param ctx - plugin context; every registration is scoped to it and disposed with it.
 * @param config - deployment configuration, validated here so a misconfiguration fails at load.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const ledger = createLedger(resolved.maxReports)
  const workspaces = new Map<Agent, Workspace>()
  const installed = new Map<Agent, () => void>()

  const workspaceFor = (agent: Agent, membership: TeamMembership, worktree: boolean): Workspace | undefined => {
    if (!worktree || membership.role !== 'teammate') return undefined
    const existing = workspaces.get(agent)
    if (existing !== undefined) return existing
    const prepared = prepareWorktree(membership.root.session.header.cwd, teamShort(String(membership.id)), membership.name)
    workspaces.set(agent, prepared)
    return prepared
  }

  const maybeInstall = (agent: Agent): void => {
    if (installed.has(agent)) return
    const membership = ctx.agentTeams.tryMembership(agent)
    if (membership === undefined) return
    installed.set(agent, installMember(ctx, agent, membership, ledger, workspaceFor(agent, membership, resolved.worktree)))
  }

  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => { maybeInstall(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
    workspaces.delete(agent)
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
    workspaces.clear()
  }, 'prism-team.scoped()')

  installWriteGate(ctx, resolved, ledger)
  installTeamCommand(ctx, ledger)
}
