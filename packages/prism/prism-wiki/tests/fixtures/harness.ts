/**
 * Real-service fixture shared by the prism-wiki suites.
 *
 * Every suite drives the plugin through the surfaces a deployment actually
 * composes — the tool registry, the human-command registry, the system-prompt
 * registry, and the vault filesystem — so an assertion is about what the model,
 * the operator, or the disk observes rather than about a stand-in for a seam.
 */

import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type Inbox, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import { ToolCallId, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import WikiVaultService from '../../src/index.ts'
import * as WikiTools from '../../src/tools.ts'
import * as WikiCommands from '../../src/commands.ts'
import type { WikiPageType } from '../../src/types.ts'

/** Every model-facing vault tool, in the registry's sorted name order. */
export const WIKI_TOOL_NAMES = ['wiki_lint', 'wiki_read', 'wiki_search', 'wiki_source', 'wiki_write'] as const

/** Opening marker of the schema frame a session owes after using a vault tool. */
export const SCHEMA_FRAME_MARKER = '<prism-wiki-schema>'

/** Configuration every mount shares. */
export interface VaultMountOptions {
  /** Absolute vault directory the service is configured with. */
  readonly vaultRoot: string
  /** Additional `Config` fields, layered over the vault root. */
  readonly config?: Readonly<Record<string, unknown>>
}

/** Where a mount stops: the service alone, or the service plus its contributing rows. */
export interface WikiMountOptions extends VaultMountOptions {
  /** Mount the model-facing tool row; `false` leaves it to the caller. */
  readonly tools?: boolean
  /** Mount the `/wiki` operator row; `false` leaves it to the caller. */
  readonly commands?: boolean
}

/**
 * Mount the registries the vault service injects and the service itself.
 * @param ctx - context that owns the mounted plugins.
 * @param options - the vault directory and any `Config` overrides.
 * @returns after the service is active.
 */
export async function mountVault(ctx: Context, options: VaultMountOptions): Promise<void> {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // `ctx.tools.execute` dispatches through the composed executor seam; without
  // one it refuses every call before a tool runs.
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(WikiVaultService, { vaultRoot: options.vaultRoot, ...options.config })
}

/**
 * Mount the vault service and the rows that contribute to it.
 * @param options - the vault directory, `Config` overrides, and which rows to mount.
 * @returns the live context, owned by the caller (dispose its fiber).
 */
export async function mountWiki(options: WikiMountOptions): Promise<Context> {
  const ctx = new Context()
  await mountVault(ctx, options)
  if (options.tools !== false) await ctx.plugin(WikiTools)
  if (options.commands !== false) await ctx.plugin(WikiCommands)
  return ctx
}

/**
 * Build one Agent over a real Session. The vault reads only its identity and
 * its log, and nothing in these suites drives an Inbox.
 * @param id - the agent and session identity.
 * @returns a live agent handle.
 */
export function createAgent(id: string): Agent {
  const sessionId = SessionId(id)
  return {
    id: sessionId,
    options: {},
    session: Session.create(sessionId),
    model: {
      current: () => undefined,
      select: () => {},
    },
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** An Inbox whose pending lists stay empty; these suites never drive one. */
function unsupportedInbox(): Inbox {
  const reject = (): never => { throw new Error('this fixture Agent does not support Inbox mutation') }
  return {
    nextTurn: [],
    nextStep: [],
    clear: reject,
    append: reject,
    prepend: reject,
    replace: reject,
    remove: reject,
    splice: reject,
  }
}

let callSequence = 0

/**
 * Dispatch one tool call through the real registry.
 * @param ctx - a context with the tool registry mounted.
 * @param name - the registered tool name.
 * @param args - the model-supplied arguments.
 * @param agent - the calling agent, when the call has one.
 * @returns the settled result, whether it succeeded or returned a refusal.
 */
export async function callTool(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
  agent?: Agent,
): Promise<ToolExecutionResult> {
  callSequence += 1
  return await executeModelToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`prism-wiki-${String(callSequence)}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

/** One page a suite asks the model-facing write tool to store. */
export interface PageInput {
  /** Vault-relative page path including the `.md` suffix. */
  readonly path: string
  /** Human-facing page title. */
  readonly title: string
  /** Page kind, which fixes the directory the path must live in. */
  readonly type: WikiPageType
  /** Markdown body without the frontmatter block. */
  readonly body: string
  /** Recall tags to store. */
  readonly tags?: readonly string[]
  /** Raw source paths the page cites, relative to `raw/`. */
  readonly sources?: readonly string[]
}

/**
 * Store one page through the model-facing `wiki_write` tool.
 * @param ctx - a context with the tool registry mounted.
 * @param agent - the calling agent.
 * @param page - the page to store.
 * @returns the settled write result.
 */
export async function writePage(ctx: Context, agent: Agent, page: PageInput): Promise<ToolExecutionResult> {
  return await callTool(ctx, 'wiki_write', {
    path: page.path,
    title: page.title,
    type: page.type,
    body: page.body,
    ...page.tags === undefined ? {} : { tags: [...page.tags] },
    ...page.sources === undefined ? {} : { sources: [...page.sources] },
  }, agent)
}

/**
 * Execute one slash command through the real command registry.
 * @param ctx - a context with the command registry mounted.
 * @param agent - the receiving agent.
 * @param line - the complete slash-command line.
 * @returns the settled command result.
 * @throws when the registry resolves no such command.
 */
export async function runCommand(ctx: Context, agent: Agent, line: string): Promise<CommandResult> {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error(`the command registry resolved no command in ${JSON.stringify(line)}`)
  return execution.result
}

/**
 * Model-visible text of one settled tool result.
 * @param result - the settled call.
 * @returns every text block joined.
 */
export function toolText(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('')
}

/**
 * The canonical value of one settled call, as JSON, for a success or a refusal branch.
 * @param result - the settled call.
 * @returns the JSON text of the returned value.
 * @throws when the call failed instead of returning a value.
 */
export function valueJson(result: ToolExecutionResult): string {
  if (result.isError) throw new Error(`expected a returned value, got the failure: ${toolText(result)}`)
  return JSON.stringify(result.value)
}

/**
 * Text of one command result.
 * @param result - the settled command.
 * @returns the operator-facing text.
 * @throws when the result carries none.
 */
export function commandText(result: CommandResult): string {
  if (result.text === undefined) throw new Error(`the command settled as ${result.kind} with no text`)
  return result.text
}

/**
 * The tools visible under the wiki prefix, sorted by name.
 * @param ctx - a context with the tool registry mounted.
 * @returns the registered wiki tool names.
 */
export function wikiToolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('wiki_')).sort()
}

/**
 * One tool's wire schema.
 * @param ctx - a context with the tool registry mounted.
 * @param name - the registered tool name.
 * @returns the schema, or `undefined` when the name is not registered.
 */
export function toolSchema(ctx: Context, name: string): ToolSchema | undefined {
  return ctx.tools.schemas().find(schema => schema.name === name)
}

/**
 * The argument names one tool's wire schema declares, in declaration order.
 * @param schema - the tool's wire schema.
 * @returns the declared argument names.
 */
export function parameterNames(schema: ToolSchema): string[] {
  const properties = schema.parameters['properties']
  return isRecord(properties) ? Object.keys(properties) : []
}

/**
 * Run the real `agent/pre-step` waterfall for one proposed step.
 * @param ctx - a context with the vault service mounted.
 * @param agent - the entering agent.
 * @param messages - the messages admitted to the step.
 * @returns the composed decision.
 */
export async function proposeStep(
  ctx: Context,
  agent: Agent,
  messages: readonly UserMessage[] = [],
): Promise<PreStepDecision> {
  const proposed = [...messages]
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    {
      messages: proposed,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      modelSelection: { provider: 'prism-wiki-test', model: 'prism-wiki-test' },
    },
    () => Promise.resolve({ kind: 'enter' as const, messages: proposed }),
  )
}

/**
 * The schema frames one proposed step would carry.
 * @param decision - the composed pre-step decision.
 * @returns one text per appended schema frame.
 */
export function schemaFrames(decision: PreStepDecision): string[] {
  if (decision.kind !== 'enter') return []
  return decision.messages.map(messageText).filter(text => text.includes(SCHEMA_FRAME_MARKER))
}

/**
 * Model-visible text of one message.
 * @param message - the message to read.
 * @returns every text block joined.
 */
export function messageText(message: UserMessage): string {
  return message.content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** Whether a value is a JSON-like record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
