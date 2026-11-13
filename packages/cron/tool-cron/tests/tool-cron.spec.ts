import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, Inbox } from '@deepseek-ai/dsh-agent'
import { createInboxStub, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { CronServiceError, LEADER_LOCK_FILENAME, apply as cronApply, Config as cronConfig, inject as cronInject, name as cronName } from '@deepseek-ai/dsh-cron'
import type { CronJobId } from '@deepseek-ai/dsh-cron'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Storage from '@deepseek-ai/dsh-storage'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as toolCron from '@deepseek-ai/dsh-tool-cron'

const testToolSignal = new AbortController().signal

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  readonly inbox: Inbox
  setStatus(status: Agent['status']): void
}

const isolatedInboxCtx = new Context()
await isolatedInboxCtx.plugin(SessionStore)
await isolatedInboxCtx.plugin(SessionProjectionRegistry)
await isolatedInboxCtx.plugin(AgentRegistry)
await isolatedInboxCtx.plugin(SystemPrompt)
await isolatedInboxCtx.plugin(ToolRuntime)
await isolatedInboxCtx.plugin(NativeToolExecutor)

/** Build one registry-compatible live agent whose injections enter its test Inbox. */
function stubAgent(rawId: string, suppliedCtx?: Context): StubAgent {
  const agentCtx = suppliedCtx ?? isolatedInboxCtx
  const session = agentCtx.sessions.create(SessionId(rawId))
  if (agentCtx.sessions.get(session.id) !== session) agentCtx.sessions.enter(session)
  const inbox = createInboxStub()
  let status: Agent['status'] = 'running'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    model: unsupportedModel(),
    inbox,
    get status() { return status },
    ctx: agentCtx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) {
      this.inbox.append('next-step', input)
    },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session, inbox, setStatus(value) { status = value } }
}

/** Open one message-triggered turn with its accepted model-visible input. */
function openTurn(stub: StubAgent, source: MessageSource, text = 'prompt'): number {
  const turn = stub.session.snapshotEvents()
    .filter(event => event.type === 'turn/start')
    .reduce((max, event) => Math.max(max, event.data.turn), 0) + 1
  stub.agent.inbox.append('next-turn', createUserMessage({ content: [{ type: 'text', text }], source }))
  const claimed = stub.inbox.splice('next-turn', 0, 1, [])
  if (claimed.length === 0) throw new Error('expected queued turn input')
  stub.session.append('turn/start', { turn })
  for (const admitted of claimed) stub.session.append('user/message', admitted, { surfaceOp: 'append' })
  return turn
}

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** Mount the tool plugin over a real cron provider on a fresh storage root. */
async function harness(config: toolCron.Config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-cron-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(TimerService)
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin(
    { name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig },
    { backend: 'json' },
  )
  await ctx.plugin({ name: cronName, inject: cronInject, apply: cronApply, Config: cronConfig }, {
    leaderLockPath: join(root, LEADER_LOCK_FILENAME),
    leaderRetryMs: 30_000,
  })
  const fiber = await ctx.plugin(toolCron, config)
  const stub = stubAgent(`tool-cron-root-${Math.random()}`, ctx)
  await ctx.agents.register(stub.agent)
  return { ctx, fiber, root: stub }
}

/** Execute one registered tool under an optional driver initiator. */
async function execute(
  ctx: Context,
  name: string,
  args: unknown,
  agent: Agent | undefined,
  initiator: Agent | undefined = agent,
): Promise<ToolExecutionResult> {
  const run = () => executeModelToolFixture(ctx, {
    signal: testToolSignal,
    callId: ToolCallId(`call-${Math.random()}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
  return initiator === undefined ? run() : ctx.agents.withInitiator(initiator, run)
}

/** Parse the canonical JSON returned by one call. */
function resultJson(result: ToolExecutionResult): Record<string, unknown> {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected a canonical tool result')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected one text tool result')
  const parsed = JSON.parse(block.text) as Record<string, unknown>
  expect(result.value).toEqual(parsed)
  return parsed
}

/** Assert one timestamp in the canonical instant form every result renders. */
function expectIsoInstant(value: unknown): void {
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
}

const SESSION_TARGET = { kind: 'session', session_id: 'session-1' }

/** The arguments one session-targeted creation states. */
function createArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expression: '0 9 * * 1-5',
    time_zone: 'UTC',
    target: SESSION_TARGET,
    prompt: 'summarize the overnight build',
    ...overrides,
  }
}

/** Create one task through the tool and return its stored id. */
async function storedId(ctx: Context, agent: Agent, overrides: Record<string, unknown> = {}): Promise<string> {
  const created = resultJson(await execute(ctx, 'cron_create', createArgs(overrides), agent))
  return created['id'] as string
}

describe('scheduled-task tool registration', () => {
  it('registers five tools inside effects and disposes every contribution', async () => {
    const { ctx, fiber } = await harness({})
    expect(['cron_create', 'cron_list', 'cron_update', 'cron_delete', 'cron_run']
      .map(tool => ctx.tools.get(tool)?.name))
      .toEqual(['cron_create', 'cron_list', 'cron_update', 'cron_delete', 'cron_run'])

    await fiber.dispose()
    for (const tool of ['cron_create', 'cron_list', 'cron_update', 'cron_delete', 'cron_run']) {
      expect(ctx.tools.get(tool)).toBeUndefined()
    }
  })

  it('rejects a run ceiling that is not a positive safe integer', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    expect(() => { toolCron.apply(ctx, { defaultMaxRunMs: 1.5 }) }).toThrow(
      'defaultMaxRunMs must be a positive safe integer',
    )
    expect(() => { toolCron.apply(ctx, { defaultMaxRunMs: 0 }) }).toThrow(
      'defaultMaxRunMs must be a positive safe integer',
    )
    expect(ctx.tools.get('cron_create')).toBeUndefined()
    // A direct caller that states nothing still gets a stated ceiling.
    expect(() => { toolCron.apply(ctx, {}) }).not.toThrow()
    expect(ctx.tools.get('cron_create')).toBeDefined()
  })

  it('has the Loader-safe namespace export shape', () => {
    expect('default' in toolCron).toBe(false)
    expect(toolCron.name).toBe('tool-cron')
    expect(toolCron.inject).toEqual(['agents', 'cron', 'sessionProjections', 'tools'])
  })

  it('declares task-relevant args-only pending cards', async () => {
    const { ctx } = await harness()
    expect(ctx.tools.get('cron_create')?.presentCall?.(createArgs())).toEqual({
      card: 'generic', title: 'Create scheduled task', kind: 'other', rawInput: '0 9 * * 1-5',
    })
    expect(ctx.tools.get('cron_list')?.presentCall?.({})).toEqual({
      card: 'generic', title: 'List scheduled tasks', kind: 'read',
    })
    expect(ctx.tools.get('cron_update')?.presentCall?.({ id: 'cron-1' })).toEqual({
      card: 'generic', title: 'Update scheduled task', kind: 'other', rawInput: 'cron-1',
    })
    expect(ctx.tools.get('cron_delete')?.presentCall?.({ id: 'cron-1' })).toEqual({
      card: 'generic', title: 'Delete scheduled task', kind: 'other', rawInput: 'cron-1',
    })
    expect(ctx.tools.get('cron_run')?.presentCall?.({ id: 'cron-1' })).toEqual({
      card: 'generic', title: 'Run scheduled task now', kind: 'other', rawInput: 'cron-1',
    })
    // Malformed or older logged arguments fall back to the generic card.
    expect(ctx.tools.get('cron_create')?.presentCall?.({ wrong: true })).toBeUndefined()
  })
})

describe('scheduled-task tool authority', () => {
  it('admits a creation and an update from a direct human turn', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const created = resultJson(await execute(ctx, 'cron_create', createArgs(), root.agent))
    expect(created).toMatchObject({ ok: true, enabled: true })
    expectIsoInstant(created['next_due_at'])

    const updated = resultJson(await execute(ctx, 'cron_update', {
      id: created['id'], expression: '30 7 * * *',
    }, root.agent))
    expect(updated).toMatchObject({ ok: true, id: created['id'], enabled: true })
  })

  it('refuses a creation from an autonomous round a human did not ask for', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'goal', goalId: 'goal-1', revision: 1, round: 1 } as MessageSource)
    const result = await execute(ctx, 'cron_create', createArgs(), root.agent)
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('GOAL_TOOL_AUTHORITY_REQUIRED')
    expect(result.error?.message).toContain('this scheduled-task operation requires a direct human turn')
    expect(ctx.cron.list()).toEqual([])
  })

  it('refuses a creation and an update from an autonomous round', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const id = await storedId(ctx, root.agent)
    const autonomous = stubAgent('tool-cron-autonomous')
    await ctx.agents.register(autonomous.agent)
    openTurn(autonomous, { kind: 'goal', goalId: 'goal-1', revision: 1, round: 1 } as MessageSource)

    // Creating and re-pointing spend unattended resources, so they need the
    // human turn. Reading and cancelling take authority away, so they do not.
    const created = await execute(ctx, 'cron_create', createArgs(), autonomous.agent)
    expect(created.error?.info?.code).toBe('GOAL_TOOL_AUTHORITY_REQUIRED')
    const updated = await execute(ctx, 'cron_update', { id, expression: '1 1 * * *' }, autonomous.agent)
    expect(updated.error?.info?.code).toBe('GOAL_TOOL_AUTHORITY_REQUIRED')

    expect(resultJson(await execute(ctx, 'cron_list', {}, autonomous.agent))['jobs']).toHaveLength(1)
    expect(ctx.cron.get(id as CronJobId)?.expression).toBe('0 9 * * 1-5')
  })

  it('refuses an agentless, driverless, stale, non-root, and idle caller', async () => {
    const { ctx, root } = await harness()
    const agentless = await execute(ctx, 'cron_create', createArgs(), undefined)
    expect(agentless.error?.info?.code).toBe('GOAL_TOOL_AGENT_REQUIRED')

    openTurn(root, { kind: 'user' })
    const driverless = await executeModelToolFixture(ctx, {
      signal: testToolSignal,
      callId: ToolCallId('call-driverless'),
      name: 'cron_create',
      arguments: createArgs(),
      agent: root.agent,
    })
    expect(driverless.error?.info?.code).toBe('GOAL_TOOL_DRIVER_REQUIRED')

    const stale = stubAgent('tool-cron-stale').agent
    const staleResult = await execute(ctx, 'cron_create', createArgs(), stale, stale)
    expect(staleResult.error?.info?.code).toBe('GOAL_TOOL_DRIVER_REQUIRED')

    root.setStatus('idle')
    const idle = await execute(ctx, 'cron_create', createArgs(), root.agent)
    expect(idle.error?.info?.code).toBe('GOAL_TOOL_DRIVER_REQUIRED')

    root.setStatus('running')
    const child = stubAgent('tool-cron-child')
    ctx.agents.enter(child.agent, root.agent)
    await ctx.agents.announce(child.agent, 'startup')
    openTurn(child, { kind: 'user' })
    const nested = await execute(ctx, 'cron_create', createArgs(), child.agent)
    expect(nested.error?.info?.code).toBe('GOAL_TOOL_AUTHORITY_REQUIRED')
  })

  it('refuses a creation with no open turn at all', async () => {
    const { ctx, root } = await harness()
    const result = await execute(ctx, 'cron_create', createArgs(), root.agent)
    expect(result.error?.info?.code).toBe('GOAL_TOOL_DRIVER_REQUIRED')
  })
})

describe('scheduled-task management', () => {
  it('creates a task and reports its identity, next occurrence, and enabled state', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const created = resultJson(await execute(ctx, 'cron_create', createArgs({ max_run_ms: 1_000 }), root.agent))
    expect(created).toEqual({
      ok: true,
      id: created['id'],
      next_due_at: created['next_due_at'],
      enabled: true,
    })
    expectIsoInstant(created['next_due_at'])
    const stored = ctx.cron.get(created['id'] as CronJobId)
    expect(stored).toMatchObject({ maxRunMs: 1_000, overlapPolicy: 'skip', misfirePolicy: 'skip' })
  })

  it('applies the resolved deployment ceiling and stated policies', async () => {
    const { ctx, root } = await harness({ defaultMaxRunMs: 123_456 })
    openTurn(root, { kind: 'user' })
    const created = resultJson(await execute(ctx, 'cron_create', createArgs({
      overlap_policy: 'queue-one',
      misfire_policy: 'run-once-late',
    }), root.agent))
    expect(ctx.cron.get(created['id'] as CronJobId)).toMatchObject({
      maxRunMs: 123_456,
      overlapPolicy: 'queue-one',
      misfirePolicy: 'run-once-late',
    })
  })

  it('carries a new-session target with its stated presets and model', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const created = resultJson(await execute(ctx, 'cron_create', createArgs({
      target: {
        kind: 'new-session',
        workspace_path: '/work',
        agent_preset: 'coding',
        permission_preset: 'workspace-write',
        model_provider: 'deepseek',
        model: 'chat',
      },
    }), root.agent))
    expect(ctx.cron.get(created['id'] as CronJobId)?.target).toEqual({
      kind: 'new-session',
      workspacePath: '/work',
      agentPreset: 'coding',
      permissionPreset: 'workspace-write',
      model: { provider: 'deepseek', model: 'chat' },
    })
  })

  it('refuses an unattended target that does not state what it runs as', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const missing = [
      { kind: 'new-session' },
      { kind: 'new-session', workspace_path: ' ' },
      { kind: 'new-session', workspace_path: '/work', agent_preset: '' },
      { kind: 'new-session', workspace_path: '/work', agent_preset: 'coding' },
      { kind: 'new-session', workspace_path: '/work', agent_preset: 'coding', permission_preset: 'workspace-write', model_provider: 'deepseek' },
      { kind: 'session' },
    ]
    for (const target of missing) {
      const result = await execute(ctx, 'cron_create', createArgs({ target }), root.agent)
      expect(result.isError).toBe(true)
      // An argument the call got wrong is not one of the five provider states.
      expect(result.value).toBeUndefined()
    }
    expect(ctx.cron.list()).toEqual([])
  })

  it('refuses an empty prompt', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const result = await execute(ctx, 'cron_create', createArgs({ prompt: '  ' }), root.agent)
    expect(result.isError).toBe(true)
    if (!result.isError) throw new Error('expected a failure')
    expect(JSON.stringify(result.content)).toContain('prompt must be a non-empty message')
  })

  it('rejects a malformed call at the schema before the body runs', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const noExpression = await execute(ctx, 'cron_create', {
      time_zone: 'UTC', target: SESSION_TARGET, prompt: 'x',
    }, root.agent)
    expect(noExpression.isError).toBe(true)
    const wrongType = await execute(ctx, 'cron_create', createArgs({ expression: 7 }), root.agent)
    expect(wrongType.isError).toBe(true)
    // The implicit parameter root is open, so an extra key reaches the body
    // rather than failing validation; only a malformed declared field is refused.
    const openRoot = await execute(ctx, 'cron_delete', { id: 'cron-999', extra: true }, root.agent)
    expect(resultJson(openRoot)).toMatchObject({ ok: false, code: 'cron_not_found' })
    expect(ctx.cron.list()).toEqual([])
  })

  it('reports an invalid expression and an invalid zone as stable codes', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    expect(resultJson(await execute(ctx, 'cron_create', createArgs({ expression: 'every other tuesday' }), root.agent)))
      .toMatchObject({ ok: false, code: 'cron_invalid_expression' })
    expect(resultJson(await execute(ctx, 'cron_create', createArgs({ time_zone: 'Mars/Olympus' }), root.agent)))
      .toMatchObject({ ok: false, code: 'cron_invalid_time_zone' })
  })

  it('lists every task with its rule, target, ceiling, and bounded history', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const id = await storedId(ctx, root.agent, { max_run_ms: 2_000 })
    const listed = resultJson(await execute(ctx, 'cron_list', {}, root.agent))
    const [job] = listed['jobs'] as Record<string, unknown>[]
    expect(job).toBeDefined()
    expect(listed).toEqual({
      ok: true,
      jobs: [{
        id,
        expression: '0 9 * * 1-5',
        time_zone: 'UTC',
        enabled: true,
        target: { kind: 'session', session_id: 'session-1' },
        prompt: 'summarize the overnight build',
        overlap_policy: 'skip',
        misfire_policy: 'skip',
        max_run_ms: 2_000,
        next_due_at: job?.['next_due_at'],
        recent_runs: [],
      }],
    })
    expectIsoInstant(job?.['next_due_at'])
  })

  it('reports a stored new-session target back to the model', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    await storedId(ctx, root.agent, {
      target: { kind: 'new-session', workspace_path: '/work', agent_preset: 'coding', permission_preset: 'read-only' },
    })
    const listed = resultJson(await execute(ctx, 'cron_list', {}, root.agent))
    const jobs = listed['jobs'] as Record<string, unknown>[]
    expect(jobs[0]?.['target']).toEqual({
      kind: 'new-session',
      workspace_path: '/work',
      agent_preset: 'coding',
      permission_preset: 'read-only',
    })
  })

  it('reports a stated run model on a new-session target', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    await storedId(ctx, root.agent, {
      target: {
        kind: 'new-session',
        workspace_path: '/work',
        agent_preset: 'coding',
        permission_preset: 'read-only',
        model_provider: 'deepseek',
        model: 'chat',
      },
    })
    const listed = resultJson(await execute(ctx, 'cron_list', {}, root.agent))
    const jobs = listed['jobs'] as Record<string, unknown>[]
    expect(jobs[0]?.['target']).toEqual({
      kind: 'new-session',
      workspace_path: '/work',
      agent_preset: 'coding',
      permission_preset: 'read-only',
      model_provider: 'deepseek',
      model: 'chat',
    })
  })

  it('updates only the fields the call states and re-derives a changed rule', async () => {
    const { ctx, root } = await harness({ defaultMaxRunMs: 5_000 })
    openTurn(root, { kind: 'user' })
    const created = resultJson(await execute(ctx, 'cron_create', createArgs({ max_run_ms: 1_000 }), root.agent))
    const id = created['id'] as CronJobId

    const promptOnly = resultJson(await execute(ctx, 'cron_update', { id, prompt: 'new prompt' }, root.agent))
    expect(promptOnly).toMatchObject({ ok: true, id, enabled: true, next_due_at: created['next_due_at'] })

    const full = resultJson(await execute(ctx, 'cron_update', {
      id,
      expression: '*/15 * * * *',
      time_zone: 'Asia/Shanghai',
      target: { kind: 'new-session', workspace_path: '/work', agent_preset: 'coding', permission_preset: 'read-only' },
      prompt: 'second prompt',
      max_run_ms: 3_000,
      overlap_policy: 'queue-one',
      misfire_policy: 'run-once-late',
      enabled: false,
    }, root.agent))
    expect(full).toMatchObject({ ok: true, id, enabled: false })
    expect(ctx.cron.get(id)).toMatchObject({
      expression: '*/15 * * * *',
      timeZone: 'Asia/Shanghai',
      prompt: 'second prompt',
      maxRunMs: 3_000,
      overlapPolicy: 'queue-one',
      misfirePolicy: 'run-once-late',
      target: { kind: 'new-session', permissionPreset: 'read-only' },
    })

    // An empty filler states nothing, so the stored ceiling stands.
    const filler = resultJson(await execute(ctx, 'cron_update', {
      id, prompt: '', max_run_ms: 0, expression: '', time_zone: '',
    }, root.agent))
    expect(filler).toMatchObject({ ok: true, id })
    expect(ctx.cron.get(id)?.maxRunMs).toBe(3_000)
  })

  it('refuses an update with no id, an unusable target, and an unknown task', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const id = await storedId(ctx, root.agent)
    const blankId = await execute(ctx, 'cron_update', { id: ' ' }, root.agent)
    expect(blankId.isError).toBe(true)
    const badTarget = await execute(ctx, 'cron_update', { id, target: { kind: 'session' } }, root.agent)
    expect(badTarget.isError).toBe(true)
    expect(resultJson(await execute(ctx, 'cron_update', { id: 'cron-999', prompt: 'x' }, root.agent)))
      .toMatchObject({ ok: false, code: 'cron_not_found' })
    expect(resultJson(await execute(ctx, 'cron_update', { id, expression: 'nonsense' }, root.agent)))
      .toMatchObject({ ok: false, code: 'cron_invalid_expression' })
  })

  it('deletes a stored task and reports an unknown one', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const id = await storedId(ctx, root.agent)
    expect(resultJson(await execute(ctx, 'cron_delete', { id }, root.agent)))
      .toEqual({ ok: true, id, deleted: true })
    expect(ctx.cron.list()).toEqual([])
    expect(resultJson(await execute(ctx, 'cron_delete', { id }, root.agent)))
      .toEqual({ ok: false, code: 'cron_not_found', message: `no scheduled task is stored under '${id}'.` })
  })

  it('runs a task once now and reports how that run ended', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const id = await storedId(ctx, root.agent)
    const before = ctx.cron.get(id as CronJobId)?.nextDueAt
    // This composition loads no session persistence, so the run reaches
    // nothing; the tool reports that recorded outcome rather than a delivery.
    const run = resultJson(await execute(ctx, 'cron_run', { id }, root.agent))
    expect(run['ok']).toBe(true)
    const detail = run['run'] as Record<string, unknown>
    expect(detail).toMatchObject({ outcome: 'failed' })
    expectIsoInstant(detail['started_at'])
    expectIsoInstant(detail['finished_at'])
    // Running now is not a firing: the stored schedule is untouched.
    expect(ctx.cron.get(id as CronJobId)?.nextDueAt).toBe(before)
    expect(ctx.cron.get(id as CronJobId)?.recentRuns).toHaveLength(1)
  })

  it('reports an unknown task to a run request', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    expect(resultJson(await execute(ctx, 'cron_run', { id: 'cron-999' }, root.agent)))
      .toMatchObject({ ok: false, code: 'cron_not_found' })
  })

  it('passes a provider refusal through under its own code and fails loud on anything else', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const id = await storedId(ctx, root.agent)

    // Drive the provider's own refusal through the tool: the capability raises
    // this when the task already has a run in flight.
    const direct = ctx.cron.runNow.bind(ctx.cron)
    const busy = vi.spyOn(ctx.cron, 'runNow').mockImplementation(() => {
      throw new CronServiceError('cron_run_in_progress', 'a run is already in flight')
    })
    expect(resultJson(await execute(ctx, 'cron_run', { id }, root.agent)))
      .toEqual({ ok: false, code: 'cron_run_in_progress', message: 'a run is already in flight' })
    busy.mockRestore()

    // Anything outside the capability's five states is not a domain state, so
    // it surfaces as a tool failure rather than borrowing a code.
    const broken = vi.spyOn(ctx.cron, 'list').mockImplementation(() => { throw new Error('the store is gone') })
    const failed = await execute(ctx, 'cron_list', {}, root.agent)
    expect(failed.isError).toBe(true)
    if (!failed.isError) throw new Error('expected a failure')
    expect(JSON.stringify(failed.content)).toContain('the store is gone')
    broken.mockRestore()

    // A management call this process cannot serve answers with its own code.
    const follower = vi.spyOn(ctx.cron, 'remove').mockImplementation(() => {
      throw new CronServiceError('cron_not_leader', 'this process does not hold the cron scheduler lease')
    })
    expect(resultJson(await execute(ctx, 'cron_delete', { id }, root.agent))).toEqual({
      ok: false,
      code: 'cron_not_leader',
      message: 'this process does not hold the cron scheduler lease',
    })
    follower.mockRestore()
    await direct(id as CronJobId)
  })
})
