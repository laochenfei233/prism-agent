/**
 * Boot the real Harness spine plus the Prism memory rows.
 *
 * The specs drive production services — the storage hub with its SQLite
 * backend, the domain facility, the session store, the system-prompt registry,
 * the session-projection registry, the tool runtime, the agent registry, and
 * the agent loop — so an assertion about memory is an assertion about what the
 * model actually sees, not about a hand-built stand-in for the seams.
 */

import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import PrismMemory from '../../src/index.ts'
import * as MemoryCommands from '../../src/commands.ts'
import * as MemoryTools from '../../src/tools.ts'

/** Configuration a spec overrides; every other field keeps its shipped default. */
export interface HarnessOptions {
  /** Fields of the plugin's `Config` row. */
  readonly config?: Record<string, unknown>
  /** Mount the model-facing tool registrant. */
  readonly tools?: boolean
  /** Mount the operator command registrant. */
  readonly commands?: boolean
}

/**
 * Mount the memory service over a real Harness spine.
 * @param options - configuration overrides and optional rows.
 * @returns the live context, owned by the caller (dispose its fiber).
 */
export async function mountMemory(options: HarnessOptions = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: ':memory:' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.commands === true) await ctx.plugin(CommandRuntime)
  await ctx.plugin(PrismMemory, options.config ?? {})
  if (options.tools === true) await ctx.plugin(MemoryTools)
  if (options.commands === true) await ctx.plugin(MemoryCommands)
  return ctx
}

/**
 * Create one real agent through the production loop.
 * @param ctx - a context mounted by {@link mountMemory}.
 * @param id - exact session id to create.
 * @param cwd - the session's working directory, which fixes its project scope.
 * @returns the live agent.
 */
export function createAgent(ctx: Context, id: string, cwd?: string): Promise<Agent> {
  const sessionId = `session-${id}` as SessionId
  return ctx.agentLoop.create(
    sessionId,
    { provider: 'mock', model: 'mock' },
    cwd === undefined ? {} : { cwd },
  )
}

/** One admitted step's messages, for driving the pre-step waterfall. */
export function stepMessages(text: string): UserMessage[] {
  return [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })]
}

/**
 * Run the real `agent/pre-step` waterfall with one already-claimed user turn.
 * @param ctx - a context mounted by {@link mountMemory}.
 * @param agent - the entering agent.
 * @param text - the claimed user text.
 * @param step - one-based step index within the turn.
 * @returns the final decision and the messages that entered the step.
 */
export async function drivePreStep(
  ctx: Context,
  agent: Agent,
  text: string,
  step = 1,
): Promise<{ readonly decision: PreStepDecision, readonly messages: readonly UserMessage[] }> {
  const messages = stepMessages(text)
  const payload = { agent, messages, turn: 1, step, signal: new AbortController().signal }
  const decision = await ctx.waterfall(
    ctx as never,
    'agent/pre-step',
    payload,
    () => Promise.resolve<PreStepDecision>({ kind: 'enter', messages }),
  ) as PreStepDecision
  return { decision, messages: decision.kind === 'enter' ? decision.messages : [] }
}

/** Text of every text block of one message. */
export function textOf(message: UserMessage): string {
  return message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

/** Commit one user message to a session's durable log, exactly as the loop does. */
export function appendUser(agent: Agent, text: string): void {
  agent.session.append(
    'user/message',
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    { surfaceOp: 'append' },
  )
}

/** Commit one assistant message to a session's durable log, exactly as the loop does. */
export function appendAssistant(agent: Agent, text: string): void {
  agent.session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'mock', model: 'mock' },
      }),
      stream: [],
    },
    { surfaceOp: 'append' },
  )
}

/**
 * Run the real `agent/turn-stopping` hook, which is where the plugin's automatic
 * memory work happens.
 * @param ctx - a context mounted by {@link mountMemory}.
 * @param agent - the agent whose turn is closing.
 */
export async function driveTurnStopping(ctx: Context, agent: Agent): Promise<void> {
  await ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
}
