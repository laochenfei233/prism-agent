/**
 * Session binding and delivery: every bot drives one bound session, and the
 * binding records the operator's sender identity — only that identity (or,
 * on legacy alpha bindings without one, the bound chat) may drive the
 * session, rebind it with `/new`, or answer asks. The sender match also
 * recovers across chats, replacing the old open `/new` recovery path.
 * First binding is explicit: an unbound channel pairs through `/start <code>`
 * with the code the Pocket page displays. Inbound chat text reaches the
 * agent as a `pocket-bot`-sourced user message through the schedule delivery
 * pattern (followup + flush inside `withoutInitiator`).
 *
 * @module @prism/prism-pocket/bots
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { BotChannelId, BotEntry, BotInbound } from './types.ts'
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

/**
 * The authority rule: a message is operator-authorized against a binding
 * when it comes from the bound chat and the binding carries no sender
 * identity (legacy or platform-less), or when the sender identity matches
 * the recorded one even from a different chat (operator recovery).
 * @param entry - the channel's stored entry, when present.
 * @param chatId - the chat the message arrived in.
 * @param senderId - the sender identity the platform carried (`''` = unknown).
 * @returns whether the sender may drive, rebind, or answer for the binding.
 */
export function operatorAuthorized(entry: BotEntry | undefined, chatId: string, senderId: string): boolean {
  if (entry === undefined) return false
  const operatorScoped = entry.senderId !== undefined && entry.senderId.length > 0
  if (operatorScoped && senderId.length > 0 && entry.senderId === senderId) return true
  return entry.chatId === chatId && (!operatorScoped || entry.senderId === senderId)
}

/** The bilingual instruction an unbound chat receives: pairing is explicit, never automatic. */
export const PAIRING_HINT = '请先配对：在口袋页面获取配对码，然后发送 /start <配对码> · Pair first: get the code from the Pocket page, then send /start <code>.'

/** The bilingual rejection of a wrong or stale pairing code. */
export const PAIRING_REJECTED = '配对码不正确——请从口袋页面获取最新配对码后重试 · Wrong pairing code — get the current one from the Pocket page and try again.'

/** The bilingual prompt a configured-but-unconfigured channel needs before pairing. */
export const PAIRING_NEEDS_CONFIG = '请先在口袋页面保存该渠道的凭据 · Save this channel\'s credentials on the Pocket page first.'

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
      await this.rebind(channel, message)
      return true
    }
    if (decision.kind === 'stop') {
      await this.stopTurn(channel, message)
      return true
    }
    if (decision.kind === 'pair') {
      await this.pair(channel, message, decision.code)
      return true
    }
    await this.forward(channel, message)
    return true
  }

  /** Handle every other chat while a bot owns a binding; never advertises `/new` to strangers. */
  async rejectForeignChat(channel: BotChannelId, chatId: string): Promise<void> {
    await this.deps.hooks.send(channel, chatId, '此机器人已绑定其他会话 · This bot is bound to another chat.')
  }

  /**
   * `/new`: create a fresh blank session and bind it to this chat. Only the
   * operator may rebind; a channel without a binding is told to pair first.
   * @param channel - the channel the command arrived on.
   * @param message - the inbound message carrying the sender identity.
   */
  async rebind(channel: BotChannelId, message: BotInbound): Promise<void> {
    const entry = this.deps.store.entry(channel)
    if (!operatorAuthorized(entry, message.chatId, message.senderId)) {
      await this.rejectUnboundOrForeign(channel, message.chatId)
      return
    }
    const created = await this.deps.sessionController.create({})
    const sessionId = created.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      await this.deps.hooks.send(channel, message.chatId, '创建新会话失败 · Failed to create a new session.')
      return
    }
    this.bindTo(channel, sessionId, message.chatId, message.senderId)
    await this.deps.hooks.send(channel, message.chatId, `已开始新会话 · Started a new session (${sessionId})`)
  }

  /**
   * `/start <code>`: pair this chat explicitly. A code matching the store's
   * active one binds the channel (replacing any existing binding) and the
   * store rotates the code; bare `/start` or a wrong code gets the hint.
   * @param channel - the channel the command arrived on.
   * @param message - the inbound message carrying the sender identity.
   * @param code - the pairing code argument, when the chat sent one.
   */
  async pair(channel: BotChannelId, message: BotInbound, code?: string): Promise<void> {
    if (code === undefined) {
      await this.deps.hooks.send(channel, message.chatId, PAIRING_HINT)
      return
    }
    if (this.deps.store.entry(channel) === undefined) {
      await this.deps.hooks.send(channel, message.chatId, PAIRING_NEEDS_CONFIG)
      return
    }
    if (!this.deps.store.consumePairingCode(code)) {
      await this.deps.hooks.send(channel, message.chatId, PAIRING_REJECTED)
      return
    }
    const created = await this.deps.sessionController.create({})
    const sessionId = created.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      await this.deps.hooks.send(channel, message.chatId, '创建会话失败 · Failed to create a session.')
      return
    }
    this.bindTo(channel, sessionId, message.chatId, message.senderId)
    await this.deps.hooks.send(channel, message.chatId, `已配对新会话 · Paired a new session (${sessionId})`)
  }

  /**
   * `/stop`: abort the bound turn when the agent exposes an interrupt, else
   * say so. The operator may stop from another chat via the sender match.
   * @param channel - the channel the command arrived on.
   * @param message - the inbound message carrying the sender identity.
   */
  async stopTurn(channel: BotChannelId, message: BotInbound): Promise<void> {
    const entry = this.deps.store.entry(channel)
    if (!operatorAuthorized(entry, message.chatId, message.senderId) || entry?.sessionId === undefined) {
      await this.deps.hooks.send(channel, message.chatId, '当前没有绑定的会话 · No bound session for this chat.')
      return
    }
    const resolved = await this.deps.sessionController.resolveAgent(entry.sessionId)
    const agent = resolved.agent
    if (agent === undefined || typeof agent.interrupt !== 'function') {
      await this.deps.hooks.send(channel, message.chatId, '请在应用内中止当前回合 · Stop the turn from the app.')
      return
    }
    await agent.interrupt()
    await this.deps.hooks.send(channel, message.chatId, '已请求中止 · Stop requested.')
  }

  /**
   * Forward one chat text into the bound session. Foreign senders are
   * rejected; the authorized operator may drive from another chat (replies
   * still return to the bound chat); an unbound channel is never claimed —
   * it is told to pair.
   * @param channel - the channel the message arrived on.
   * @param message - the normalized inbound message.
   */
  async forward(channel: BotChannelId, message: BotInbound): Promise<void> {
    const entry = this.deps.store.entry(channel)
    if (entry?.sessionId === undefined || !operatorAuthorized(entry, message.chatId, message.senderId)) {
      await this.rejectUnboundOrForeign(channel, message.chatId)
      return
    }
    const resolved = await this.deps.sessionController.resolveAgent(entry.sessionId)
    if (resolved.agent === undefined) {
      // The bound session is gone; rebind to the operator's current chat.
      const created = await this.deps.sessionController.create({})
      const fresh = created.sessionId
      if (typeof fresh !== 'string' || fresh.length === 0) {
        await this.deps.hooks.send(channel, message.chatId, '会话已失效且无法重建 · The bound session is gone and could not be recreated.')
        return
      }
      this.bindTo(channel, fresh, message.chatId, message.senderId)
      await this.deliver(fresh, message)
      return
    }
    await this.deliver(entry.sessionId, message)
  }

  /** The unbound and the foreign read differently: only a live binding speaks of another chat. */
  private async rejectUnboundOrForeign(channel: BotChannelId, chatId: string): Promise<void> {
    const entry = this.deps.store.entry(channel)
    if (entry?.sessionId !== undefined && entry.chatId !== undefined) await this.rejectForeignChat(channel, chatId)
    else await this.deps.hooks.send(channel, chatId, PAIRING_HINT)
  }

  /** Persist one binding and report it upward. */
  private bindTo(channel: BotChannelId, sessionId: string, chatId: string, senderId: string): void {
    this.deps.store.bind(channel, sessionId, chatId, senderId)
    this.deps.hooks.onBound(channel, sessionId, chatId)
  }

  /** Run one followup + flush inside `withoutInitiator`. */
  private async deliver(sessionId: string, message: BotInbound): Promise<void> {
    const resolved = await this.deps.sessionController.resolveAgent(sessionId)
    const agent = resolved.agent
    if (agent === undefined) {
      throw resolved.error instanceof Error ? resolved.error : new Error(`agent for session "${sessionId}" did not resolve`)
    }
    const who = message.senderName === undefined ? '' : `${message.senderName}: `
    const text = createUserMessage({
      content: [{ type: 'text', text: `${who}${message.text}` }],
      source: { kind: 'pocket-bot' },
    })
    await this.deps.agents.withoutInitiator(async () => {
      agent.followup(text)
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
