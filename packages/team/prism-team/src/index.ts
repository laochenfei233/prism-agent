/**
 * Team capabilities the shared Agent Teams packages leave open: a structured
 * report instead of prose, one needs-a-person list, a private worktree per
 * teammate, and an enforced write scope.
 *
 * A Team is an enabled subagent tree: the root Agent is the Lead and every
 * continuable descendant is a teammate, so membership is read from the live
 * tree rather than a separate roster. Every part attaches to a documented
 * extension point and owns its decision there, so this bundle adds behavior
 * without rewriting an upstream package:
 *
 * - **Reports** — `team_report` turns a teammate's progress into a structured
 *   status the Lead receives as one inbox message, so coordination stops
 *   depending on free text read out of order.
 * - **The needs-a-person list** — `/team` orders blocked, failed, ready and
 *   waiting rows before working ones, and a healthy team takes one line.
 * - **A worktree per teammate** — a continuable teammate gets its own
 *   `git worktree` and branch, so two members stop editing one checkout.
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
import type { TeamTaskView } from '@deepseek-ai/dsh-agent-team'
// Type-only: activates the `ctx.connection` service these routes register on.
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { defineTool, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { TeamPanelValue } from './panel-contract.ts'
import { TEAM_PANEL_PATH } from './routes.ts'

/** How the write scope applies: `observe` records a refusal and lets the write through. */
export type Mode = 'enforce' | 'observe'

/** One guarded write tool and the argument naming the path it writes. */
export interface WriteTool {
  /** Tool name as the model calls it. */
  readonly tool: string
  /** Argument carrying the written path. */
  readonly pathArgument: string
}

/** Deployment configuration for the team bundle. */
export interface Config {
  /** Whether an out-of-scope write is refused (`enforce`) or only recorded (`observe`). Defaults to `enforce`. */
  readonly mode?: Mode
  /** Whether each continuable teammate gets its own git worktree. Defaults to `true`. */
  readonly worktree?: boolean
  /** Write tools the scope check judges. Defaults to `write` and `edit` (`file_path`) plus `str_replace_editor` (`path`). */
  readonly writeTools?: readonly WriteTool[]
  /** Reports kept per team in the in-memory ledger. Defaults to `200`. */
  readonly maxReports?: number
}

/** Validated configuration. */
export interface ResolvedConfig {
  /** How the write scope applies. */
  readonly mode: Mode
  /** Whether each continuable teammate gets its own git worktree. */
  readonly worktree: boolean
  /** Guarded tool name to the argument naming the written path. */
  readonly writeTools: ReadonlyMap<string, string>
  /** Reports kept per team. */
  readonly maxReports: number
}

/**
 * Write tools the shipped profiles expose, each with the argument that names
 * its path; the opt-in editor spells it `path` while the filesystem tools use
 * `file_path`.
 */
const DEFAULT_WRITE_TOOLS: readonly WriteTool[] = [
  { tool: 'write', pathArgument: 'file_path' },
  { tool: 'edit', pathArgument: 'file_path' },
  { tool: 'str_replace_editor', pathArgument: 'path' },
]

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
  if (config.worktree !== undefined && typeof config.worktree !== 'boolean') {
    throw new Error(`prism-team: worktree must be a boolean, received ${JSON.stringify(config.worktree)}`)
  }
  const writeTools = config.writeTools ?? DEFAULT_WRITE_TOOLS
  if (!Array.isArray(writeTools) || writeTools.length === 0) {
    throw new Error('prism-team: writeTools must be a non-empty array of { tool, pathArgument }')
  }
  const guarded = new Map<string, string>()
  for (const entry of writeTools) {
    if (typeof entry?.tool !== 'string' || entry.tool.trim() === ''
      || typeof entry.pathArgument !== 'string' || entry.pathArgument.trim() === '') {
      throw new Error('prism-team: every writeTools entry must name a non-empty tool and pathArgument')
    }
    guarded.set(entry.tool, entry.pathArgument)
  }
  return { mode, worktree: config.worktree ?? true, writeTools: guarded, maxReports }
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
export const inject = ['agents', 'agentTeams', 'subagents', 'tools', 'systemPrompt', 'commands']

/** Order of the team section inside the assembled prompt, before tools. */
const TEAM_SECTION_ORDER = 40

/** Statuses the needs-a-person list shows before working rows. */
const NEEDS_A_PERSON: ReadonlySet<LedgerEntry['status']> = new Set(['blocked', 'failed', 'ready', 'waiting'])

/** The first eight characters of a team or session brand, used in paths and branches. */
function teamShort(id: string): string {
  return id.slice(0, 8)
}

/**
 * Resolve the Team this agent belongs to: the live root of its subagent tree
 * when that tree's Team mode is enabled.
 *
 * Every subagent-resolution failure means "no team here": an independently
 * resumed child has no live root, and a composition without the subagent
 * runtime has no tree at all. Both leave the agent outside this bundle.
 *
 * @param ctx - the plugin context carrying the Team and subagent services.
 * @param agent - the exact live agent to resolve.
 * @returns the live Lead (root) Agent, or `undefined` outside an enabled team.
 */
function teamRoot(ctx: Context, agent: Agent): Agent | undefined {
  try {
    if (!ctx.agentTeams.isEnabled(agent)) return undefined
    return ctx.subagents.rootOf(agent)
  } catch (error: unknown) {
    if (error instanceof SubagentError) return undefined
    throw error
  }
}

/** The path a write tool was called with, under the argument that tool names. */
function writtenPath(argumentsValue: unknown, pathArgument: string): string | undefined {
  if (typeof argumentsValue !== 'object' || argumentsValue === null) return undefined
  const value = (argumentsValue as Record<string, unknown>)[pathArgument]
  return typeof value === 'string' ? value : undefined
}

/** One workspace path normalized to the form task write scopes use. */
function relativeTo(root: string, target: string): string | undefined {
  const path = relative(root, resolve(root, target)).split(sep).join('/')
  return path.startsWith('..') ? undefined : path
}

/**
 * Drop a teammate worktree prefix, so a path inside `.worktrees/<checkout>/`
 * compares against the same scopes as the file in the shared checkout.
 *
 * @param path - a workspace-relative path.
 * @returns the path with any `.worktrees/<checkout>/` prefix removed.
 */
function withoutWorktree(path: string): string {
  const parts = path.split('/')
  return parts[0] === '.worktrees' && parts.length > 2 ? parts.slice(2).join('/') : path
}

/**
 * Whether one path is covered by any of a task's write scopes.
 *
 * @param root - the team workspace root the scopes are relative to.
 * @param target - the path the write named, absolute or relative to `root`.
 * @param scopes - the claimed task's advisory write scopes.
 * @returns whether the path is inside one scope, matched per path segment.
 */
export function withinScopes(root: string, target: string, scopes: readonly string[]): boolean {
  const path = relativeTo(root, target)
  if (path === undefined) return false
  const normalized = withoutWorktree(path)
  return scopes.some((scope) => {
    const prefix = scope.replace(/\/+$/u, '')
    return normalized === prefix || normalized.startsWith(`${prefix}/`)
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
 * already created by the subagent runtime, so refusing here would leave a
 * member with no explanation of why it has no directory.
 *
 * @param root - the Team Lead's working directory, when it records one.
 * @param short - the team's short brand.
 * @param member - the teammate's immutable catalog name.
 * @returns the prepared path and branch, or a warning to state in the member's prompt.
 */
function prepareWorktree(root: string | undefined, short: string, member: string): Workspace {
  if (root === undefined) return { warning: 'the Team Lead session records no working directory' }
  if (!existsSync(join(root, '.git'))) return { warning: `${root} is not a git checkout` }
  const path = join(root, '.worktrees', `team-${short}-${member}`)
  const branch = `team/${short}/${member}`
  if (existsSync(path)) return { path, branch }
  try {
    // Ignore the directory before creating the checkout, so the Lead's status
    // never lists a teammate's tree. Only reached once `.git` proves this is a
    // repository, so a non-git working directory keeps no stray `.worktrees`.
    const ignore = join(root, '.worktrees', '.gitignore')
    if (!existsSync(ignore)) {
      mkdirSync(join(root, '.worktrees'), { recursive: true })
      writeFileSync(ignore, '*\n')
    }
    execFileSync('git', ['-C', root, 'worktree', 'add', path, '-b', branch], { stdio: 'pipe', timeout: 30_000 })
    return { path, branch }
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '').trim().split('\n')[0]
      : ''
    const detail = stderr !== undefined && stderr !== '' ? stderr : error instanceof Error ? error.message : String(error)
    return { warning: `git worktree add failed: ${detail}` }
  }
}

/** The prompt section one member reads. */
function sectionText(role: 'lead' | 'teammate', member: string, workspace: Workspace | undefined): string {
  const lines = [
    `PRISM TEAM (${role} "${member}")`,
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

/** One roster row: the Lead first, then every continuable descendant. */
interface RosterMember {
  /** Model-facing member name. */
  readonly name: string
  /** Team role. */
  readonly role: 'lead' | 'teammate'
  /** Live status; `inactive` means no turn is executing. */
  readonly status: string
}

/**
 * Read the roster of one live team: the Lead, then every continuable
 * descendant in catalog order. One-shot and external children are ordinary
 * delegation, not Team members; an unreadable branch is skipped rather than
 * failing the whole read.
 *
 * @param ctx - the plugin context carrying the subagent service.
 * @param root - the live Lead Agent.
 * @returns the roster rows, Lead first.
 */
async function roster(ctx: Context, root: Agent): Promise<readonly RosterMember[]> {
  const members: RosterMember[] = [{ name: 'lead', role: 'lead', status: 'running' }]
  const entries = await listDescendants(ctx, root)
  for (const entry of entries) {
    if (entry.kind !== 'child' || entry.mode !== 'continuable') continue
    members.push({ name: entry.path ?? entry.name ?? entry.label, role: 'teammate', status: entry.activity })
  }
  return members
}

/**
 * List one team's descendants, tolerating an unreadable catalog: the roster
 * and reports degrade to what the live tree still answers.
 *
 * @param ctx - the plugin context carrying the subagent service.
 * @param root - the live Lead Agent.
 * @returns the descendant entries, or an empty list when the catalog cannot be read.
 */
async function listDescendants(ctx: Context, root: Agent): Promise<readonly SubagentDescendantListEntry[]> {
  return await ctx.subagents.listDescendants(root.session.id).catch(() => [] as SubagentDescendantListEntry[])
}

/** A continuable child row: the only descendant kind that is a Team teammate. */
type TeammateEntry = Extract<SubagentDescendantListEntry, { readonly kind: 'child'; readonly mode: 'continuable' }>

/**
 * Narrow one descendant to a continuable child. Diagnostics and one-shot or
 * external children are ordinary delegation, not Team teammates.
 *
 * @param entry - one descendant catalog row.
 * @returns the continuable-child view, or `undefined` when the row is not a teammate.
 */
function continuable(entry: SubagentDescendantListEntry): TeammateEntry | undefined {
  return entry.kind === 'child' && entry.mode === 'continuable' ? entry : undefined
}

/**
 * Install the team prompt section, shown only to members of an enabled team.
 *
 * @param ctx - the plugin context the section is registered on.
 * @param workspaces - prepared teammate checkouts, keyed by session id.
 * @param names - resolved member names, keyed by session id.
 */
function installSection(
  ctx: Context,
  workspaces: ReadonlyMap<string, Workspace>,
  names: ReadonlyMap<string, string>,
): void {
  ctx.systemPrompt.section({
    name: 'prism-team',
    order: TEAM_SECTION_ORDER,
    text: ({ agent }) => {
      if (agent === undefined) return ''
      const root = teamRoot(ctx, agent)
      if (root === undefined) return ''
      const lead = root === agent
      const key = String(agent.session.id)
      const fallback = lead ? 'lead' : teamShort(key)
      return sectionText(lead ? 'lead' : 'teammate', names.get(key) ?? fallback, workspaces.get(key))
    },
  })
}

/**
 * Install the `team_report` tool, available to every member of an enabled
 * team. A teammate's report becomes one message in the Lead's inbox; the
 * Lead's own report only fills the ledger, because the team service refuses
 * self-messages and a Lead report has no other receiver.
 *
 * @param ctx - the plugin context the tool is registered on.
 * @param ledger - the shared team ledger.
 * @param names - resolved member names, keyed by session id.
 */
function installReportTool(ctx: Context, ledger: Ledger, names: ReadonlyMap<string, string>): void {
  ctx.tools.register(defineTool({
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
      const agent = exec.agent
      if (agent === undefined) throw new ToolContextUnavailableError('team_report requires a calling Agent')
      const root = teamRoot(ctx, agent)
      if (root === undefined) throw new Error('team_report: this session is not on an enabled Team')
      const lead = root === agent
      const key = String(agent.session.id)
      const member = lead ? 'lead' : names.get(key) ?? teamShort(key)
      const entry: LedgerEntry = {
        name: member,
        status: args.status as ReportStatus,
        summary: args.summary,
        ...args.task_id === undefined ? {} : { taskId: args.task_id },
      }
      if (!lead) {
        const text = `Report from ${member} [${entry.status}]: ${entry.summary}`
          + (entry.taskId === undefined ? '' : ` (task ${entry.taskId})`)
        await ctx.subagents.sendMessage(agent, root.session.id, [{ type: 'text', text }], { signal: exec.signal })
      }
      const team = String(root.session.id)
      ledger.record(team, entry)
      return { delivered: !lead, status: entry.status, reports: ledger.list(team).length }
    },
  }), { when: ({ agent }) => agent !== undefined && teamRoot(ctx, agent) !== undefined })
}

/**
 * Refuse a teammate's write outside the scope of the task it claimed.
 *
 * A path inside a claimed task's `writeScopes` is the explicit case and passes;
 * everything else is inferred and goes to approval, where a person prices it.
 * Under `observe` the same decision is recorded and the write proceeds.
 *
 * @param ctx - the plugin context the listener is registered on.
 * @param config - resolved configuration.
 * @param ledger - the shared team ledger.
 * @param names - resolved member names, keyed by session id.
 */
function installWriteGate(
  ctx: Context,
  config: ResolvedConfig,
  ledger: Ledger,
  names: ReadonlyMap<string, string>,
): void {
  ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => {
    const agent = exec.agent
    if (agent === undefined) return next()
    if (!config.writeTools.has(exec.name)) return next()
    const root = teamRoot(ctx, agent)
    // Only teammates are gated: the Lead owns the shared checkout and every scope.
    if (root === undefined || root === agent) return next()
    const pathArgument = config.writeTools.get(exec.name)
    if (pathArgument === undefined) return next()
    const path = writtenPath(exec.arguments, pathArgument)
    if (path === undefined) return next()
    const workspaceRoot = root.session.header.cwd
    if (workspaceRoot === undefined) return next()

    // Only the caller's own claimed task authorizes a write: another member's
    // scope is context, not permission.
    const claimed = ctx.agentTeams.listTasks(agent)
      .filter(task => task.status === 'in_progress' && String(task.ownerId) === String(agent.session.id))
    const covered = claimed.some(task => withinScopes(workspaceRoot, path, task.writeScopes))
    if (covered) return next()

    const reason = claimed.length === 0
      ? `\`${path}\` is written with no claimed shared task of your own, so no write scope covers it. Claim the task this work belongs to (team_task_list, then team_task_update with action "claim") and retry.`
      : `\`${path}\` is outside the write scopes of your claimed task (${claimed.map(task => `${task.id}: ${task.writeScopes.join(', ') || 'none'}`).join('; ')}). Either stay inside that scope or tell the Lead the task's scope is wrong.`
    if (config.mode === 'observe') {
      const key = String(agent.session.id)
      ledger.record(String(root.session.id), {
        name: names.get(key) ?? teamShort(key),
        status: 'observed',
        summary: path,
      })
      return next()
    }
    return Promise.resolve({ kind: 'ask', reason })
  })
}

/** Format one report row for `/team`. */
function reportRow(entry: LedgerEntry): string {
  const task = entry.taskId === undefined ? '' : `  ${entry.taskId}`
  return `  ${entry.status.padEnd(9)} ${entry.name.padEnd(12)} ${entry.summary}${task}`
}

/** Order needs-a-person rows: a stoppage first, then a result, then a question. */
function rank(status: LedgerEntry['status']): number {
  if (status === 'blocked' || status === 'failed') return 0
  if (status === 'ready') return 1
  return 2
}

/** `1 member`, `2 members`. */
function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Assemble the `/team` body: the head line, needs-a-person rows before working
 * ones, observed writes, open tasks, and the roster with worktree paths.
 *
 * @param team - the team brand.
 * @param members - the live roster, Lead first.
 * @param tasks - the team's open task views.
 * @param entries - the team's ledger entries.
 * @param worktreePaths - prepared checkout paths, keyed `<teamShort>:<member>`.
 * @returns the rendered command text.
 */
function teamText(
  team: string,
  members: readonly RosterMember[],
  tasks: readonly TeamTaskView[],
  entries: readonly LedgerEntry[],
  worktreePaths: ReadonlyMap<string, string>,
): string {
  const needs = entries.filter(entry => NEEDS_A_PERSON.has(entry.status)).sort((left, right) => rank(left.status) - rank(right.status))
  const observed = entries.filter(entry => entry.status === 'observed')
  const working = entries.filter(entry => !NEEDS_A_PERSON.has(entry.status) && entry.status !== 'observed')

  const head = `Team ${teamShort(team)}: ${plural(members.length, 'member')}, ${String(tasks.length)} open ${tasks.length === 1 ? 'task' : 'tasks'} (${String(needs.length)} need a person).`
  if (needs.length === 0 && observed.length === 0 && working.length === 0 && tasks.length === 0) {
    return head
  }

  const lines = [head]
  if (needs.length > 0) lines.push('', 'needs a person:', ...needs.map(reportRow))
  if (working.length > 0) lines.push('', 'working:', ...working.map(reportRow))
  if (observed.length > 0) lines.push('', 'observed writes:', ...observed.map(reportRow))
  if (tasks.length > 0) {
    lines.push('', 'tasks:', ...tasks.map(task => `  ${task.id} ${task.status}${task.ownerName === undefined ? '' : ` (${task.ownerName})`}${task.ready ? '' : ' blocked'} · ${task.subject}`))
  }
  lines.push('', ...members.map(member => {
    const path = worktreePaths.get(`${teamShort(team)}:${member.name}`)
    return `${memberLine(member)}${path === undefined ? '' : ` · ${path}`}`
  }))
  return lines.join('\n')
}

/**
 * Install the `/team` command, which any member may run.
 *
 * @param ctx - the plugin context the command is registered on.
 * @param ledger - the shared team ledger.
 * @param worktreePaths - prepared checkout paths, keyed `<teamShort>:<member>`.
 */
function installTeamCommand(ctx: Context, ledger: Ledger, worktreePaths: ReadonlyMap<string, string>): void {
  ctx.effect(() => ctx.commands.register({
    definitionId: CommandDefinitionId('prism-team/team'),
    name: 'team',
    description: 'Show the roster, the open tasks, and the reports this team recorded, needs-a-person rows first',
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const agent = invocation.agent
      const root = teamRoot(ctx, agent)
      if (root === undefined) return { kind: 'error', text: '/team: this session is not a Team member.' }
      const team = String(root.session.id)
      const members = await roster(ctx, root)
      const tasks = ctx.agentTeams.listTasks(agent).filter(task => task.status !== 'completed')
      return { kind: 'success', text: teamText(team, members, tasks, ledger.list(team), worktreePaths) }
    },
  }), 'prism-team.team()')
}

/**
 * Answer one panel read: the roster, tasks, and reports for the team a session
 * belongs to. A teammate's session resolves to its Team through its live tree
 * root, so the browser never has to know which member the open page shows.
 *
 * @param ctx - the plugin context carrying the Team and subagent services.
 * @param ledger - the shared team ledger.
 * @param worktreePaths - prepared checkout paths, keyed `<teamShort>:<member>`.
 * @param sessionId - the session the open panel belongs to.
 * @returns the panel value; a session with no live team still returns its recorded reports.
 */
async function panelValue(
  ctx: Context,
  ledger: Ledger,
  sessionId: string,
): Promise<TeamPanelValue> {
  const agent = ctx.agents.list().find(candidate => String(candidate.session.id) === sessionId)
  const root = agent === undefined ? undefined : teamRoot(ctx, agent)
  if (agent === undefined || root === undefined) {
    return { team: sessionId, live: false, members: [], tasks: [], reports: ledger.list(sessionId) }
  }
  const team = String(root.session.id)
  return {
    team,
    live: true,
    members: await roster(ctx, root),
    tasks: ctx.agentTeams.listTasks(agent)
      .filter(task => task.status !== 'completed')
      .map(task => ({
        id: String(task.id),
        subject: task.subject,
        status: task.status,
        ...task.ownerName === undefined ? {} : { ownerName: task.ownerName },
        ready: task.ready,
      })),
    reports: ledger.list(team),
  }
}

/**
 * Register the panel's one read on Connection's shared `/api` channel.
 *
 * The route is optional: a profile that composes no web server keeps the rest
 * of the bundle, and `ctx.get` reads the service without making it a dependency
 * of every deployment.
 *
 * @param ctx - the plugin context carrying the connection service.
 * @param ledger - the shared team ledger.
 */
function installPanelRoute(ctx: Context, ledger: Ledger): void {
  const connection = ctx.get('connection')
  if (connection === undefined) return
  ctx.effect(() => connection.fetch.register({
    path: TEAM_PANEL_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      const body = await request.json().catch(() => undefined)
      const sessionId = typeof body === 'object' && body !== null && 'sessionId' in body
        ? (body as { sessionId?: unknown }).sessionId
        : undefined
      if (typeof sessionId !== 'string' || sessionId === '') {
        return Response.json({ error: 'sessionId is required' }, { status: 400 })
      }
      return Response.json(await panelValue(ctx, ledger, sessionId))
    },
  } satisfies ConnectionFetchRoute), 'prism-team.panel()')
}

/**
 * Install the team bundle.
 *
 * Membership is the enabled subagent tree: the root Agent is the Lead and every
 * continuable descendant is a teammate. A session outside such a tree receives
 * no tool, no section, and no write check.
 *
 * @param ctx - plugin context; every registration is scoped to it and disposed with it.
 * @param config - deployment configuration, validated here so a misconfiguration fails at load.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const ledger = createLedger(resolved.maxReports)
  const workspaces = new Map<string, Workspace>()
  const worktreePaths = new Map<string, string>()
  const names = new Map<string, string>()
  const adopted = new Set<string>()

  /**
   * Adopt one subagent into its team: cache its catalog name, and prepare its
   * own worktree when the deployment asks for one. One-shot children stay in
   * the shared checkout; their turns are too short to own a directory.
   */
  const adopt = async (agent: Agent): Promise<void> => {
    if (agent.session.header.origin !== 'subagent') return
    const key = String(agent.session.id)
    if (adopted.has(key)) return
    adopted.add(key)
    try {
      const root = teamRoot(ctx, agent)
      if (root === undefined || root === agent) return
      const short = teamShort(String(root.session.id))
      const entry = (await listDescendants(ctx, root))
        .map(continuable)
        .find(member => member !== undefined && String(member.id) === key)
      const member = entry === undefined ? short : entry.path ?? entry.name ?? entry.label ?? short
      names.set(key, member)
      if (!resolved.worktree || entry === undefined) return
      const prepared = prepareWorktree(root.session.header.cwd, short, entry.name ?? member)
      workspaces.set(key, prepared)
      if ('path' in prepared) worktreePaths.set(`${short}:${entry.name ?? member}`, prepared.path)
    } catch (error) {
      // Adoption never breaks the member: a missing name or checkout only
      // degrades the section text, so record and move on.
      ctx.logger.warn(`prism-team: adopting ${key} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  for (const agent of ctx.agents.list()) void adopt(agent)
  ctx.on('agent/created', ({ agent }) => { void adopt(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const key = String(agent.session.id)
    adopted.delete(key)
    names.delete(key)
    workspaces.delete(key)
  })
  ctx.effect(() => () => {
    adopted.clear()
    names.clear()
    workspaces.clear()
    worktreePaths.clear()
  }, 'prism-team.scoped()')

  installSection(ctx, workspaces, names)
  installReportTool(ctx, ledger, names)
  installWriteGate(ctx, resolved, ledger, names)
  installTeamCommand(ctx, ledger, worktreePaths)
  installPanelRoute(ctx, ledger)
}
