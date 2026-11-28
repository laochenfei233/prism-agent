/**
 * Behavior suite for the Prism Team bundle.
 *
 * The spec drives the REAL tools, system-prompt, session, and command
 * registries, so the assertions are on what a member actually gets: the
 * assembled prompt section, the text of `/team`, and the decision a write
 * receives. The Team and subagent services are upstream and are stubbed here,
 * which keeps the suite on this bundle's own logic.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamTaskId } from '@deepseek-ai/dsh-agent-team'
import type { TeamTaskView } from '@deepseek-ai/dsh-agent-team'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as PrismTeam from '../src/index.ts'

const SIGNAL = new AbortController().signal
const ROOT = 'C:/work/checkout'

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

/** A task view with the fields the write scope reads. */
function task(id: string, status: TeamTaskView['status'], ownerId: SessionId, writeScopes: string[]): TeamTaskView {
  return {
    id: TeamTaskId(id),
    revision: 1,
    subject: id,
    description: '',
    status,
    ownerId,
    ownerName: String(ownerId),
    blockedBy: [],
    writeScopes,
    ready: true,
    writeScopeWarnings: [],
  }
}

/** One descendant catalog row the stubbed subagent service answers with. */
function descendant(name: string): SubagentDescendantListEntry {
  const id = SessionId(name)
  return {
    kind: 'child',
    id,
    activity: 'running',
    mode: 'continuable',
    label: name,
    name,
    hasChildren: false,
    parentId: SessionId('lead'),
    depth: 1,
    path: name,
  }
}

/**
 * Boot the real registries plus stubbed Team and subagent services and mount
 * the bundle.
 *
 * The Lead is the first agent and every other member is a continuable
 * descendant of it, which is exactly the membership the upstream runtime
 * derives from an enabled subagent tree. Each member gets a real Session (so
 * command execution can append) and the scope `createScope` mints for it,
 * which is what the Agent runtime hands a member as `agent.ctx`.
 *
 * @param config - deployment configuration for the bundle.
 * @param teammates - teammate names to expose beside the Lead.
 * @param root - the Team Lead's working directory; a fresh temporary one by default.
 * @returns the live context, the Lead, one agent per teammate, the sent messages, and the task board.
 */
async function harness(
  config: PrismTeam.Config = {},
  teammates: readonly string[] = ['reviewer'],
  root: string = takeRoot(),
): Promise<{
  ctx: Context
  lead: Agent
  agents: Agent[]
  sent: { readonly target: string; readonly text: string }[]
  tasks: TeamTaskView[]
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(CommandRuntime)

  const names = ['lead', ...teammates]
  const agents: Agent[] = []
  for (const member of names) {
    const isLead = member === 'lead'
    const session = ctx.sessions.create(SessionId(member), {
      meta: isLead ? { cwd: root } : { cwd: root, origin: 'subagent' },
    })
    const key = { id: session.id, session, inject: () => undefined } as unknown as Agent
    let scope!: Scope
    await ctx.plugin(Object.assign(
      (inner: Context) => { scope = createScope(inner, key) },
      { inject: ['tools', 'systemPrompt', 'commands'] },
    ))
    Object.assign(key, { ctx: scope.ctx })
    agents.push(key)
  }
  const lead = agents[0]!

  const sent: { target: string; text: string }[] = []
  const tasks: TeamTaskView[] = []
  ctx.provide('agents', { list: () => agents } as unknown as (typeof ctx)['agents'])
  ctx.provide('agentTeams', {
    isEnabled: () => true,
    listTasks: () => tasks,
  } as unknown as (typeof ctx)['agentTeams'])
  ctx.provide('subagents', {
    rootOf: (agent: Agent): Agent => {
      if (!agents.includes(agent)) {
        throw new SubagentError('the caller has no live subagent tree root', 'UNAUTHORIZED')
      }
      return lead
    },
    listDescendants: async () => teammates.map(descendant),
    sendMessage: async (
      _sender: Agent,
      targetId: SessionId,
      content: readonly { readonly type: string; readonly text?: string }[],
    ): Promise<MessageId> => {
      sent.push({ target: String(targetId), text: content.map(block => block.text ?? '').join('') })
      return MessageId('m1')
    },
  } as unknown as (typeof ctx)['subagents'])

  await ctx.plugin(PrismTeam, config)
  // Adoption of the already-live agents is asynchronous; let it settle so the
  // assertions read the prepared names and worktrees.
  await new Promise(resolve => setImmediate(resolve))
  return { ctx, lead, agents, sent, tasks }
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

/** One tool execution through the real pipeline, admitted by the agent's own step. */
async function executeAs(
  ctx: Context,
  agent: Agent,
  callId: string,
  name: string,
  args: unknown,
): Promise<Awaited<ReturnType<typeof executeToolFixture>>> {
  const toolSet = await ctx.tools.resolve({
    agent, modelSelection: { provider: 'test', model: 'test' }, signal: SIGNAL,
  })
  try {
    return await executeToolFixture(ctx, {
      callId: ToolCallId(callId), name, arguments: args, signal: SIGNAL, agent, toolSet,
    })
  } finally {
    toolSet.dispose()
  }
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
    expect(() => PrismTeam.resolveConfig(JSON.parse('{"worktree":"yes"}') as PrismTeam.Config)).toThrow('worktree must be a boolean')
  })
})

describe('write scope matching', () => {
  it('matches a scope per path segment and refuses a sibling with the same prefix', () => {
    expect(PrismTeam.withinScopes(ROOT, 'src/a.ts', ['src'])).toBe(true)
    expect(PrismTeam.withinScopes(ROOT, `${ROOT}/src/deep/b.ts`, ['src/'])).toBe(true)
    expect(PrismTeam.withinScopes(ROOT, 'srcx/a.ts', ['src'])).toBe(false)
    expect(PrismTeam.withinScopes(ROOT, 'assets/a.md', ['src'])).toBe(false)
    expect(PrismTeam.withinScopes(ROOT, '../../outside.ts', ['src'])).toBe(false)
  })

  it('compares a path inside a teammate worktree against the same scopes', () => {
    expect(PrismTeam.withinScopes(ROOT, '.worktrees/team-01234567-one/src/a.ts', ['src'])).toBe(true)
    expect(PrismTeam.withinScopes(ROOT, '.worktrees/team-01234567-one/assets/a.md', ['src'])).toBe(false)
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
  it('leaves a non-member session with no section, no command, and no write check', async () => {
    const { ctx } = await harness()
    const stranger = { id: SessionId('stranger'), session: ctx.sessions.create(SessionId('stranger')), ctx } as unknown as Agent

    expect(await promptOf(ctx, stranger)).not.toContain('PRISM TEAM')
    expect(await run(ctx, stranger, '/team')).toContain('this session is not a Team member')
    registerWrite(ctx)
    const write = await executeAs(ctx, stranger, 'c1', 'write', { file_path: 'src/a.ts' })
    expect(write.isError, textOf(write)).toBe(false)
  })

  it('gives every member the shared report protocol section', async () => {
    const { ctx, agents } = await harness()
    expect(await promptOf(ctx, agents[1]!)).toContain('PRISM TEAM (teammate "reviewer")')
    expect(await promptOf(ctx, agents[0]!)).toContain('PRISM TEAM (lead "lead")')
  })
})

describe('team_report', () => {
  it('sends a teammate report to the Lead as one framed message', async () => {
    const { ctx, agents, sent } = await harness()
    const result = await executeAs(ctx, agents[1]!, 'c1', 'team_report',
      { status: 'blocked', summary: 'missing repro steps', task_id: 'task-4' })
    expect(result.isError, textOf(result)).toBe(false)
    expect(sent).toEqual([{ target: 'lead', text: 'Report from reviewer [blocked]: missing repro steps (task task-4)' }])
    expect(textOf(result)).toContain('"delivered":true')
  })

  it('records a Lead report without messaging itself', async () => {
    const { ctx, agents, sent } = await harness()
    const result = await executeAs(ctx, agents[0]!, 'c1', 'team_report',
      { status: 'progress', summary: 'reading the diff' })
    expect(result.isError, textOf(result)).toBe(false)
    expect(sent).toEqual([])
    expect(textOf(result)).toContain('"delivered":false')
  })
})

describe('/team', () => {
  it('lists needs-a-person rows before working rows', async () => {
    const { ctx, agents, tasks } = await harness()
    await executeAs(ctx, agents[1]!, 'c1', 'team_report', { status: 'progress', summary: 'rewrote the parser' })
    await executeAs(ctx, agents[1]!, 'c2', 'team_report', { status: 'blocked', summary: 'cannot reproduce on windows' })
    tasks.push(task('task-4', 'in_progress', SessionId('reviewer'), []))
    const text = await run(ctx, agents[0]!, '/team')
    expect(text.indexOf('needs a person:')).toBeLessThan(text.indexOf('working:'))
    expect(text).toContain('blocked   reviewer')
    expect(text).toContain('cannot reproduce on windows')
  })

  it('takes one line for a healthy team', async () => {
    const { ctx, lead } = await harness({}, [])
    const text = await run(ctx, lead, '/team')
    expect(text).toBe(`Team ${String(lead.session.id).slice(0, 8)}: 1 member, 0 open tasks (0 need a person).`)
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
    const result = await executeAs(ctx, agents[1]!, 'c1', 'write', { file_path: 'src/a.ts' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('no claimed shared task')
  })

  it('ignores another member task scope as authorization', async () => {
    const { ctx, agents, tasks } = await harness()
    registerWrite(ctx)
    tasks.push(task('task-1', 'in_progress', SessionId('someone-else'), ['src']))
    const result = await executeAs(ctx, agents[1]!, 'c1', 'write', { file_path: 'src/a.ts' })
    expect(result.isError).toBe(true)
  })

  it('reads the path argument each guarded tool names', async () => {
    const { ctx, agents, tasks } = await harness()
    ctx.tools.register(defineTool({
      name: 'str_replace_editor',
      description: 'edit a file',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: args => Promise.resolve(args.path),
    }))
    tasks.push(task('task-1', 'in_progress', SessionId('reviewer'), ['src']))
    const inside = await executeAs(ctx, agents[1]!, 'c1', 'str_replace_editor', { path: 'src/a.ts' })
    expect(inside.isError, textOf(inside)).toBe(false)
  })

  it('lets a write inside the claimed task scope through and refuses a sibling', async () => {
    const { ctx, agents, tasks } = await harness()
    registerWrite(ctx)
    tasks.push(task('task-1', 'in_progress', SessionId('reviewer'), ['src']))

    const inside = await executeAs(ctx, agents[1]!, 'c1', 'write', { file_path: 'src/a.ts' })
    expect(inside.isError, textOf(inside)).toBe(false)

    const outside = await executeAs(ctx, agents[1]!, 'c2', 'write', { file_path: 'assets/a.md' })
    expect(outside.isError).toBe(true)
    expect(textOf(outside)).toContain('outside the write scopes')
  })

  it('leaves the Lead alone', async () => {
    const { ctx, agents } = await harness()
    registerWrite(ctx)
    const result = await executeAs(ctx, agents[0]!, 'c1', 'write', { file_path: 'assets/a.md' })
    expect(result.isError, textOf(result)).toBe(false)
  })

  it('lets an out-of-scope write through and records it under observe', async () => {
    const { ctx, agents } = await harness({ mode: 'observe' })
    registerWrite(ctx)
    const result = await executeAs(ctx, agents[1]!, 'c1', 'write', { file_path: 'assets/a.md' })
    expect(result.isError, textOf(result)).toBe(false)
    expect(await run(ctx, agents[0]!, '/team')).toContain('observed  reviewer')
  })
})

describe('worktree', () => {
  it('gives each continuable teammate its own checkout and branch, and the Lead none', async () => {
    const root = takeRoot()
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'pipe' })
    execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })

    const { ctx, lead, agents } = await harness({}, ['one', 'two'], root)
    const short = String(lead.session.id).slice(0, 8)

    expect(await promptOf(ctx, agents[1]!)).toContain(join(root, '.worktrees', `team-${short}-one`))
    expect(await promptOf(ctx, agents[2]!)).toContain(join(root, '.worktrees', `team-${short}-two`))
    expect(await promptOf(ctx, agents[0]!)).not.toContain('.worktrees')

    const listed = execFileSync('git', ['-C', root, 'worktree', 'list'], { stdio: 'pipe' }).toString()
    expect(listed).toContain(`team-${short}-one`)
    expect(listed).toContain(`team-${short}-two`)
  }, 20_000)

  it('keeps the member working when there is no repository to isolate', async () => {
    const { ctx, agents } = await harness()
    expect(await promptOf(ctx, agents[1]!)).toContain('You have no isolated checkout')
  })
})
