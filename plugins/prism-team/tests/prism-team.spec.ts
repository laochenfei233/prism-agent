/**
 * Behavior suite for the Prism Team bundle.
 *
 * The spec drives the REAL tools, system-prompt, session, and command
 * registries, so the assertions are on what a member actually gets: the
 * registered tool set, the assembled prompt section, the text of `/team`, and
 * the decision a write receives. The Team service itself is upstream and is
 * stubbed here, which keeps the suite on this bundle's own logic.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { TeamId } from '@deepseek-ai/dsh-experimental-agent-team'
import type { TeamMembership, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as PrismTeam from '../src/index.ts'

const SIGNAL = new AbortController().signal
const ROOT = 'C:/work/checkout'
const TEAM = TeamId('01234567-89ab-cdef-0123-456789abcdef')

/** Working directories this suite created, removed after each test. */
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Create a temporary working directory the suite removes after the test. */
function takeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'prism-team-'))
  roots.push(root)
  return root
}

/** One stubbed Team service, recording what the bundle sends it. */
interface StubTeam {
  readonly sent: { readonly target: string; readonly text: string }[]
  tasks: TeamTaskView[]
}

/** A task view with the fields the write scope reads. */
function task(id: string, status: TeamTaskView['status'], ownerName: string, writeScopes: string[]): TeamTaskView {
  return {
    id: id as TeamTaskView['id'],
    revision: 1,
    subject: id,
    description: '',
    status,
    ownerName,
    blockedBy: [],
    writeScopes,
    ready: true,
    writeScopeWarnings: [],
  }
}

/** One member definition the harness publishes. */
interface MemberSpec {
  readonly name: string
  readonly role: 'lead' | 'teammate'
}

/**
 * Boot the real registries plus a stubbed Team service and mount the bundle.
 *
 * Each member gets a real Session (so command execution can append) and the
 * scope `createScope` mints for it, which is what the Agent Teams runtime hands
 * a member as `agent.ctx`.
 *
 * @param config - deployment configuration for the bundle.
 * @param members - member names to expose, lead first.
 * @param root - the Team Lead's working directory; a fresh temporary one by default.
 * @returns the live context, one agent per member, and the Team stub.
 */
async function harness(
  config: PrismTeam.Config = {},
  members: readonly MemberSpec[] = [{ name: 'lead', role: 'lead' }, { name: 'reviewer', role: 'teammate' }],
  root: string = takeRoot(),
): Promise<{ ctx: Context; agents: Agent[]; team: StubTeam }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CommandRuntime)

  const agents: Agent[] = []
  for (const member of members) {
    const session = ctx.sessions.create(SessionId(member.name), { meta: { cwd: root } })
    const key = { id: session.id, session, inject: () => undefined } as unknown as Agent
    let scope!: Scope
    await ctx.plugin(Object.assign(
      (inner: Context) => { scope = createScope(inner, key) },
      { inject: ['tools', 'systemPrompt', 'commands'] },
    ))
    Object.assign(key, { ctx: scope.ctx })
    agents.push(key)
  }

  const memberships = new Map<Agent, TeamMembership>(agents.map((agent, index) => {
    const member = members[index]!
    return [agent, { root: agents[0]!, id: TEAM, role: member.role, name: member.name }]
  }))

  const team: StubTeam = { sent: [], tasks: [] }
  ctx.provide('agents', { list: () => agents } as unknown as (typeof ctx)['agents'])
  ctx.provide('agentTeams', {
    tryMembership: (agent: Agent) => memberships.get(agent),
    listMembers: () => members.map(member => ({ name: member.name, role: member.role, status: 'running', diagnostics: [] })),
    listTasks: () => team.tasks,
    sendMessage: async (_caller: Agent, request: { target: string; content: { type: string; text?: string }[] }) => {
      team.sent.push({ target: request.target, text: request.content.map(block => block.text ?? '').join('') })
      return { messageId: 'm1' }
    },
  } as unknown as (typeof ctx)['agentTeams'])

  await ctx.plugin(PrismTeam, config)
  return { ctx, agents, team }
}

/** The assembled prompt as this agent reads it. */
async function promptOf(ctx: Context, agent: Agent): Promise<string> {
  return renderPrompt(await ctx.systemPrompt.assemble({ agent, scope: agent }))
}

/** Run one slash command as the agent and return its text. */
async function run(ctx: Context, agent: Agent, line: string): Promise<string> {
  const execution = await ctx.commands.execute(agent, line, [], SIGNAL)
  return execution?.result.text ?? ''
}

/** Every text block of one tool result. */
function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('\n')
}

/** Register a stand-in for the shipped `write` tool. */
function registerWrite(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'write',
    description: 'write a file',
    parameters: { file_path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: args => Promise.resolve(args.file_path),
  }))
}

describe('configuration', () => {
  it('applies defaults and validates every key by name', () => {
    const resolved = PrismTeam.resolveConfig({})
    expect(resolved.mode).toBe('enforce')
    expect(resolved.worktree).toBe(true)
    expect(resolved.maxReports).toBe(200)
    expect([...resolved.writeTools]).toEqual([['write', 'file_path'], ['edit', 'file_path'], ['str_replace_editor', 'path']])

    expect(() => PrismTeam.resolveConfig({ mode: 'on' as PrismTeam.Mode })).toThrow('mode must be "enforce" or "observe"')
    expect(() => PrismTeam.resolveConfig({ maxReports: 0 })).toThrow('maxReports must be an integer >= 1')
    expect(() => PrismTeam.resolveConfig({ writeTools: [] })).toThrow('writeTools must be a non-empty array')
    expect(() => PrismTeam.resolveConfig({ writeTools: [{ tool: '', pathArgument: 'p' }] })).toThrow('every writeTools entry')
    expect(() => PrismTeam.resolveConfig({ worktree: 'yes' } as PrismTeam.Config)).toThrow('worktree must be a boolean')
  })
})

describe('write scope matching', () => {
  it('matches a scope per path segment and refuses a sibling with the same prefix', () => {
    expect(PrismTeam.withinScopes(ROOT, 'src/a.ts', ['src'])).toBe(true)
    expect(PrismTeam.withinScopes(ROOT, `${ROOT}/src/deep/b.ts`, ['src/'])).toBe(true)
    expect(PrismTeam.withinScopes(ROOT, 'srcx/a.ts', ['src'])).toBe(false)
    expect(PrismTeam.withinScopes(ROOT, 'docs/a.md', ['src'])).toBe(false)
    expect(PrismTeam.withinScopes(ROOT, '../../outside.ts', ['src'])).toBe(false)
  })

  it('compares a path inside a teammate worktree against the same scopes', () => {
    expect(PrismTeam.withinScopes(ROOT, '.worktrees/team-01234567-one/src/a.ts', ['src'])).toBe(true)
    expect(PrismTeam.withinScopes(ROOT, '.worktrees/team-01234567-one/docs/a.md', ['src'])).toBe(false)
  })
})

describe('report ledger', () => {
  it('drops the oldest entry once the bound is reached', () => {
    const ledger = PrismTeam.createLedger(2)
    ledger.record('t', { name: 'a', status: 'progress', summary: '1' })
    ledger.record('t', { name: 'a', status: 'progress', summary: '2' })
    ledger.record('t', { name: 'a', status: 'progress', summary: '3' })
    expect(ledger.list('t').map(entry => entry.summary)).toEqual(['2', '3'])
  })
})

describe('member installation', () => {
  it('leaves a non-member session with no tool and no section', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    ctx.provide('agents', { list: () => [] } as unknown as (typeof ctx)['agents'])
    ctx.provide('agentTeams', { tryMembership: () => undefined } as unknown as (typeof ctx)['agentTeams'])
    await ctx.plugin(PrismTeam)
    const stranger = { id: SessionId('stranger'), session: ctx.sessions.create(SessionId('stranger')), ctx } as unknown as Agent

    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('team_report')
    expect(await promptOf(ctx, stranger)).not.toContain('PRISM TEAM')
  })

  it('gives every member the shared report protocol section', async () => {
    const { ctx, agents } = await harness()
    expect(await promptOf(ctx, agents[1]!)).toContain('PRISM TEAM (teammate "reviewer")')
    expect(await promptOf(ctx, agents[0]!)).toContain('PRISM TEAM (lead "lead")')
  })
})

describe('team_report', () => {
  it('sends a teammate report to the Lead as one framed message', async () => {
    const { ctx, agents, team } = await harness()
    const result = await ctx.tools.execute({
      signal: SIGNAL,
      callId: ToolCallId('c1'),
      name: 'team_report',
      arguments: { status: 'blocked', summary: 'missing repro steps', task_id: 'task-4' },
      agent: agents[1]!,
    })
    expect(result.isError).toBe(false)
    expect(team.sent).toEqual([{ target: 'lead', text: 'Report from reviewer [blocked]: missing repro steps (task task-4)' }])
    expect(textOf(result)).toContain('"delivered":true')
  })

  it('records a Lead report without messaging itself', async () => {
    const { ctx, agents, team } = await harness()
    const result = await ctx.tools.execute({
      signal: SIGNAL,
      callId: ToolCallId('c1'),
      name: 'team_report',
      arguments: { status: 'progress', summary: 'reading the diff' },
      agent: agents[0]!,
    })
    expect(team.sent).toEqual([])
    expect(textOf(result)).toContain('"delivered":false')
  })
})

describe('/team', () => {
  it('lists needs-a-person rows before working rows', async () => {
    const { ctx, agents } = await harness()
    await ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId('c1'), name: 'team_report',
      arguments: { status: 'progress', summary: 'rewrote the parser' }, agent: agents[1]!,
    })
    await ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId('c2'), name: 'team_report',
      arguments: { status: 'blocked', summary: 'cannot reproduce on windows' }, agent: agents[1]!,
    })
    const text = await run(ctx, agents[0]!, '/team')
    expect(text.indexOf('needs a person:')).toBeLessThan(text.indexOf('working:'))
    expect(text).toContain('blocked   reviewer')
    expect(text).toContain('cannot reproduce on windows')
  })

  it('takes one line for a healthy team', async () => {
    const { ctx, agents } = await harness({}, [{ name: 'lead', role: 'lead' }])
    const text = await run(ctx, agents[0]!, '/team')
    expect(text).toBe('Team 01234567: 1 member, 0 open tasks (0 need a person).')
  })

  it('refuses a session that is not on a team', async () => {
    const { ctx } = await harness()
    const stranger = { id: SessionId('stranger'), session: ctx.sessions.create(SessionId('stranger')), ctx } as unknown as Agent
    expect(await run(ctx, stranger, '/team')).toContain('this session is not a Team member')
  })
})

describe('write scope', () => {
  it('refuses a write with no claimed task', async () => {
    const { ctx, agents } = await harness()
    registerWrite(ctx)
    const result = await ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId('c1'), name: 'write',
      arguments: { file_path: 'src/a.ts' }, agent: agents[1]!,
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no claimed shared task')
  })

  it('ignores another member task scope as authorization', async () => {
    const { ctx, agents, team } = await harness()
    registerWrite(ctx)
    team.tasks = [task('task-1', 'in_progress', 'someone-else', ['src'])]
    const result = await ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId('c1'), name: 'write',
      arguments: { file_path: 'src/a.ts' }, agent: agents[1]!,
    })
    expect(result.isError).toBe(true)
  })

  it('reads the path argument each guarded tool names', async () => {
    const { ctx, agents, team } = await harness()
    ctx.tools.register(defineTool({
      name: 'str_replace_editor',
      description: 'edit a file',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: args => Promise.resolve(args.path),
    }))
    team.tasks = [task('task-1', 'in_progress', 'reviewer', ['src'])]
    const inside = await ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId('c1'), name: 'str_replace_editor',
      arguments: { path: 'src/a.ts' }, agent: agents[1]!,
    })
    expect(inside.isError).toBe(false)
  })

  it('lets a write inside the claimed task scope through and refuses a sibling', async () => {
    const { ctx, agents, team } = await harness()
    registerWrite(ctx)
    team.tasks = [task('task-1', 'in_progress', 'reviewer', ['src'])]

    const inside = await ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId('c1'), name: 'write',
      arguments: { file_path: 'src/a.ts' }, agent: agents[1]!,
    })
    expect(inside.isError).toBe(false)

    const outside = await ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId('c2'), name: 'write',
      arguments: { file_path: 'docs/a.md' }, agent: agents[1]!,
    })
    expect(outside.isError).toBe(true)
    expect(textOf(outside)).toContain('outside the write scopes')
  })

  it('leaves the Lead alone', async () => {
    const { ctx, agents } = await harness()
    registerWrite(ctx)
    const result = await ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId('c1'), name: 'write',
      arguments: { file_path: 'docs/a.md' }, agent: agents[0]!,
    })
    expect(result.isError).toBe(false)
  })

  it('lets an out-of-scope write through and records it under observe', async () => {
    const { ctx, agents } = await harness({ mode: 'observe' })
    registerWrite(ctx)
    const result = await ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId('c1'), name: 'write',
      arguments: { file_path: 'docs/a.md' }, agent: agents[1]!,
    })
    expect(result.isError).toBe(false)
    expect(await run(ctx, agents[0]!, '/team')).toContain('observed  reviewer')
  })
})

describe('worktree', () => {
  it('gives each teammate its own checkout and branch, and the Lead none', async () => {
    const root = takeRoot()
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' })
    execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })

    const { ctx, agents } = await harness({}, [
      { name: 'lead', role: 'lead' },
      { name: 'one', role: 'teammate' },
      { name: 'two', role: 'teammate' },
    ], root)

    expect(await promptOf(ctx, agents[1]!)).toContain(join(root, '.worktrees', 'team-01234567-one'))
    expect(await promptOf(ctx, agents[2]!)).toContain(join(root, '.worktrees', 'team-01234567-two'))
    expect(await promptOf(ctx, agents[0]!)).not.toContain('.worktrees')

    const listed = execFileSync('git', ['-C', root, 'worktree', 'list'], { stdio: 'pipe' }).toString()
    expect(listed).toContain('team-01234567-one')
    expect(listed).toContain('team-01234567-two')
  }, 20_000)

  it('keeps the member working when there is no repository to isolate', async () => {
    const { ctx, agents } = await harness()
    expect(await promptOf(ctx, agents[1]!)).toContain('You have no isolated checkout')
  })
})
