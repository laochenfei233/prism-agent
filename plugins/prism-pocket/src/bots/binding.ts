/**
 * Session binding and delivery: every bot drives one bound session; inbound
 * chat text reaches the agent as a `pocket-bot`-sourced user message through
 * the schedule delivery pattern (followup + flush inside `withoutInitiator`).
 *
 * @module @prism/prism-pocket/bots
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { BotChannelId, BotInbound } from './types.ts'
import type { BotStore } from './store.ts'
import { HELP_TEXT, decideInbound } from './inbox.ts'

declare module '@deepseek-ai/dsh-llm' {
  // The message source the bot delivery carries; the session log records it.
  interface MessageSourceMap {
    'pocket-bot': { kind: 'pocket-bot' } & ContextFormed
  }
}

/** The live-agent view the bot delivery needs, read structurally. */
export interface PocketAgentView {
  readonly id: string
  followup(message: unknown): void
  readonly session: unknown
  /** Optional abort affordance; present only when the runtime face carries one. */
  interrupt?: () => void | Promise<void>
}

/** The session-controller view the binding needs, read structurally. */
export interface PocketSessionControllerLike {
  resolveAgent(sessionId: string): Promise<{ agent?: PocketAgentView; error?: unknown }>
  create(request?: unknown): Promise<{ sessionId?: string }>
}

/** The sessions view the binding needs, read structurally. */
export interface PocketSessionsLike {
  flush(session: unknown): Promise<boolean>
}

/** The agents registry view the binding needs, read structurally. */
export interface PocketAgentsLike {
  withoutInitiator<T>(work: () => Promise<T>): Promise<T>
}

/** What the conversations module reports upward. */
export interface BotConversationsHooks {
  /** Deliver one text to one chat. */
  send(channel: BotChannelId, chatId: string, text: string): Promise<void>
  /** The binding of one channel changed. */
  onBound(channel: BotChannelId, sessionId: string, chatId: string): void
}

/** Dependencies read off the host context. */
export interface BotConversationsDeps {
  readonly store: BotStore
  readonly sessionController: PocketSessionControllerLike
  readonly sessions: PocketSessionsLike
  readonly agents: PocketAgentsLike
  readonly hooks: BotConversationsHooks
}

/** Where one session's replies go. */
export interface BotReplyTarget {
  readonly channel: BotChannelId
  readonly chatId: string
}

/** The conversations module: commands, binding, and delivery. */
export class BotConversations {
  private readonly deps: BotConversationsDeps

  /**
   * @param deps - store, host services, and upward hooks.
   */
  constructor(deps: BotConversationsDeps) {
    this.deps = deps
  }

  /** The chat a session's replies go to, when a bot bound it. */
  targetOf(sessionId: string): BotReplyTarget | undefined {
    for (const channel of this.deps.store.enabledChannels()) {
      const entry = this.deps.store.entry(channel)
      if (entry?.sessionId === sessionId && entry.chatId !== undefined) {
        return { channel, chatId: entry.chatId }
      }
    }
    return undefined
  }

  /**
   * Handle one inbound chat message: commands act, other text forwards.
   * @param channel - the channel the message arrived on.
   * @param message - the normalized inbound message.
   * @returns whether the text was consumed as a command (ask-relay matching runs first, at the caller).
   */
  async onInbound(channel: BotChannelId, message: BotInbound): Promise<boolean> {
    const decision = decideInbound(message.text)
    if (decision.kind === 'help') {
      await this.deps.hooks.send(channel, message.chatId, HELP_TEXT)
      return true
    }
    if (decision.kind === 'new') {
      await this.rebind(channel, message.chatId)
      return true
    }
    if (decision.kind === 'stop') {
      await this.stopTurn(channel, message.chatId)
      return true
    }
    await this.forward(channel, message.chatId, decision.text, message.senderName)
    return true
  }

  /** Handle every other chat while a bot owns a binding. */
  async rejectForeignChat(channel: BotChannelId, chatId: string): Promise<void> {
    await this.deps.hooks.send(channel, chatId, '此机器人已绑定其他会话 · This bot is bound to another chat. Send /new to rebind.')
  }

  /** Create a fresh blank session and bind it to this chat. */
  async rebind(channel: BotChannelId, chatId: string): Promise<void> {
    const created = await this.deps.sessionController.create({})
    const sessionId = created.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      await this.deps.hooks.send(channel, chatId, '创建新会话失败 · Failed to create a new session.')
      return
    }
    this.deps.store.bind(channel, sessionId, chatId)
    this.deps.hooks.onBound(channel, sessionId, chatId)
    await this.deps.hooks.send(channel, chatId, `已开始新会话 · Started a new session (${sessionId})`)
  }

  /** Abort the bound turn when the agent exposes an interrupt, else say so. */
  async stopTurn(channel: BotChannelId, chatId: string): Promise<void> {
    const entry = this.deps.store.entry(channel)
    if (entry?.sessionId === undefined || entry.chatId !== chatId) {
      await this.deps.hooks.send(channel, chatId, '当前没有绑定的会话 · No bound session for this chat.')
      return
    }
    const resolved = await this.deps.sessionController.resolveAgent(entry.sessionId)
    const agent = resolved.agent
    if (agent === undefined || typeof agent.interrupt !== 'function') {
      await this.deps.hooks.send(channel, chatId, '请在应用内中止当前回合 · Stop the turn from the app.')
      return
    }
    await agent.interrupt()
    await this.deps.hooks.send(channel, chatId, '已请求中止 · Stop requested.')
  }

  /** Forward one chat text into the bound (or freshly created) session. */
  async forward(channel: BotChannelId, chatId: string, text: string, senderName?: string): Promise<void> {
    const entry = this.deps.store.entry(channel)
    let sessionId = entry?.sessionId
    if (entry !== undefined && sessionId !== undefined && entry.chatId !== chatId) {
      await this.rejectForeignChat(channel, chatId)
      return
    }
    if (sessionId === undefined) {
      const created = await this.deps.sessionController.create({})
      sessionId = created.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        await this.deps.hooks.send(channel, chatId, '创建会话失败 · Failed to create a session.')
        return
      }
      this.deps.store.bind(channel, sessionId, chatId)
      this.deps.hooks.onBound(channel, sessionId, chatId)
    }
    const resolved = await this.deps.sessionController.resolveAgent(sessionId)
    if (resolved.agent === undefined) {
      // The bound session is gone; rebind on the next message.
      const created = await this.deps.sessionController.create({})
      const fresh = created.sessionId
      if (typeof fresh !== 'string' || fresh.length === 0) {
        await this.deps.hooks.send(channel, chatId, '会话已失效且无法重建 · The bound session is gone and could not be recreated.')
        return
      }
      this.deps.store.bind(channel, fresh, chatId)
      this.deps.hooks.onBound(channel, fresh, chatId)
      await this.deliver(fresh, text, senderName)
      return
    }
    await this.deliver(sessionId, text, senderName)
  }

  /** Run one followup + flush inside `withoutInitiator`. */
  private async deliver(sessionId: string, text: string, senderName?: string): Promise<void> {
    const resolved = await this.deps.sessionController.resolveAgent(sessionId)
    const agent = resolved.agent
    if (agent === undefined) {
      throw resolved.error instanceof Error ? resolved.error : new Error(`agent for session "${sessionId}" did not resolve`)
    }
    const who = senderName === undefined ? '' : `${senderName}: `
    const message = createUserMessage({
      content: [{ type: 'text', text: `${who}${text}` }],
      source: { kind: 'pocket-bot' },
    })
    await this.deps.agents.withoutInitiator(async () => {
      agent.followup(message)
      const flushed = await this.deps.sessions.flush(agent.session)
      if (!flushed) throw new Error('Session persistence did not acknowledge the bot message')
    })
  }
}

/** Read the host services the conversations module needs off the context. */
export function readBotHostServices(ctx: Context): { sessionController: PocketSessionControllerLike; sessions: PocketSessionsLike; agents: PocketAgentsLike } {
  const read = (name: string): unknown => {
    const value: unknown = Reflect.get(ctx, name)
    if (value === undefined || typeof value !== 'object') {
      throw new Error(`pocket: the ${name} service is required for bot delivery`)
    }
    return value
  }
  return {
    sessionController: read('sessionController') as PocketSessionControllerLike,
    sessions: read('sessions') as PocketSessionsLike,
    agents: read('agents') as PocketAgentsLike,
  }
}
