/**
 * The ask relay: approvals and user questions of bot-bound sessions render
 * in the chat as numbered choices; the operator's next reply resolves the
 * ask, and silence delegates through `next()` so the host's own surfaces
 * keep the request. The relay observes only — it never claims a request
 * whose session no bot bound, never two asks per session at once, and
 * leaves every non-operator reply for the caller's own handling.
 *
 * @module @prism/prism-pocket/bots
 */

import type { BotChannelId } from './types.ts'
import type { BotReplyTarget } from './binding.ts'

/** How long one ask waits for the chat's reply. */
export const ASK_TIMEOUT_MS = 120_000

/** The words one chat reply is read as. */
export type AskReply = 'yes' | 'no' | 'number' | 'other'

/** What the relay sends and how it resolves. */
export interface BotAskDeps {
  /** Resolve one session's reply target, when a bot bound it. */
  readonly targetOf: (sessionId: string) => BotReplyTarget | undefined
  /** Whether the sender may resolve the binding's asks (the operator rule, read off the store). */
  readonly authorized: (channel: BotChannelId, chatId: string, senderId: string) => boolean
  /** Deliver one text to one chat. */
  readonly send: (channel: BotChannelId, chatId: string, text: string) => Promise<void>
}

/** One approval waiting on its chat. */
interface PendingApproval {
  readonly kind: 'approval'
  readonly sessionId: string
  readonly target: BotReplyTarget
  readonly resolve: (outcome: 'allowed-once' | 'rejected' | undefined) => void
}

/** One user question waiting on its chat; the options are the labels in order. */
interface PendingQuestion {
  readonly kind: 'question'
  readonly sessionId: string
  readonly target: BotReplyTarget
  readonly questionId: string
  readonly options: readonly string[]
  readonly resolve: (selected: readonly string[] | undefined) => void
}

/** A pending ask of either kind. */
type PendingAsk = PendingApproval | PendingQuestion

/** The classify result of one chat reply against a pending ask. */
export function classifyAskReply(text: string): AskReply {
  const value = text.trim().toLowerCase()
  if (value === '1' || value === 'y' || value === 'yes' || value === '是' || value === '批准') return 'yes'
  if (value === '2' || value === 'n' || value === 'no' || value === '否' || value === '拒绝') return 'no'
  if (/^[0-9]+$/u.test(value)) return 'number'
  return 'other'
}

/** The relay: one pending ask per session, resolved by the chat's next reply. */
export class BotAskRelay {
  private readonly pending = new Map<string, PendingAsk>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly deps: BotAskDeps

  /**
   * @param deps - target resolution and delivery.
   */
  constructor(deps: BotAskDeps) {
    this.deps = deps
  }

  /**
   * Observe one approval ask; resolves through the chat or delegates via `next()`.
   * @param sessionId - the session the approval belongs to.
   * @param toolName - the tool the decision is about.
   * @param next - the delegate call.
   * @returns the outcome the ask settled with.
   */
  async handleApproval<T>(sessionId: string, toolName: string, next: () => Promise<T>): Promise<'allowed-once' | 'rejected' | T> {
    const target = this.deps.targetOf(sessionId)
    if (target === undefined || this.pending.has(sessionId)) return await next()
    const outcome = await new Promise<'allowed-once' | 'rejected' | undefined>(resolve => {
      const ask: PendingApproval = { kind: 'approval', sessionId, target, resolve }
      this.pending.set(sessionId, ask)
      const timer = setTimeout(() => { this.expire(sessionId) }, ASK_TIMEOUT_MS)
      this.timers.set(sessionId, timer)
      void this.deps.send(target.channel, target.chatId,
        `需要批准 · Approval needed: ${toolName}\n回复 1 / y 批准 · reply 1 / y to approve\n回复 2 / n 拒绝 · reply 2 / n to reject (120s)`)
    })
    return outcome === undefined ? await next() : outcome
  }

  /**
   * Observe one user-question ask; only single-question forms with options
   * relay, everything else delegates immediately.
   * @param sessionId - the session the question belongs to.
   * @param request - the request the asker carried.
   * @param next - the delegate call.
   * @returns the answer the ask settled with.
   */
  async handleQuestion<T>(
    sessionId: string,
    request: { readonly questions?: readonly { readonly id?: unknown; readonly question?: unknown; readonly options?: unknown }[] },
    next: () => Promise<T>,
  ): Promise<{ answers: { id: string; selected: string[] }[] } | T> {
    const questions = request.questions
    if (!Array.isArray(questions) || questions.length !== 1) return await next()
    const only = questions[0]
    if (typeof only !== 'object' || only === null) return await next()
    const id = only.id
    const text = only.question
    const options = only.options
    if (typeof id !== 'string' || typeof text !== 'string' || !Array.isArray(options) || options.length === 0 || options.length > 6) {
      return await next()
    }
    const target = this.deps.targetOf(sessionId)
    if (target === undefined || this.pending.has(sessionId)) return await next()
    const labels = options.map(option => typeof option === 'object' && option !== null && typeof (option as { label?: unknown }).label === 'string'
      ? (option as { label: string }).label
      : String(option))
    const answer = await new Promise<readonly string[] | undefined>(resolve => {
      const ask: PendingQuestion = { kind: 'question', sessionId, target, questionId: id, options: labels, resolve }
      this.pending.set(sessionId, ask)
      const timer = setTimeout(() => { this.expire(sessionId) }, ASK_TIMEOUT_MS)
      this.timers.set(sessionId, timer)
      void this.deps.send(target.channel, target.chatId,
        `提问 · Question: ${text}\n${labels.map((label, index) => `${index + 1}. ${label}`).join('\n')}\n回复编号 · reply a number (120s)`)
    })
    if (answer === undefined) return await next()
    return { answers: [{ id, selected: [...answer] }] }
  }

  /**
   * Offer one inbound chat reply to the session's pending ask. A reply from
   * a sender the operator rule rejects is left unconsumed, so the caller's
   * own foreign-chat handling answers it.
   * @param channel - the channel the reply arrived on.
   * @param chatId - the chat the reply came from.
   * @param sessionId - the session the chat is bound to.
   * @param senderId - the sender identity the platform carried (`''` = unknown).
   * @param text - the reply text.
   * @returns whether the reply was consumed by a pending ask.
   */
  consume(channel: BotChannelId, chatId: string, sessionId: string, senderId: string, text: string): boolean {
    const ask = this.pending.get(sessionId)
    if (ask === undefined || ask.target.channel !== channel || ask.target.chatId !== chatId) return false
    if (!this.deps.authorized(channel, chatId, senderId)) return false
    if (ask.kind === 'approval') {
      const reply = classifyAskReply(text)
      if (reply === 'yes') this.settle(sessionId, 'allowed-once')
      else if (reply === 'no') this.settle(sessionId, 'rejected')
      else if (reply === 'number' || reply === 'other') {
        void this.deps.send(channel, chatId, '回复 1 / y 或 2 / n · reply 1 / y or 2 / n')
        return true
      }
      return true
    }
    // Digits map to the question's own options; 1/2 are not yes/no here.
    if (!/^[0-9]+$/u.test(text.trim())) {
      void this.deps.send(channel, chatId, '回复编号 · reply a number')
      return true
    }
    const index = Number.parseInt(text.trim(), 10) - 1
    const label = index >= 0 && index < ask.options.length ? ask.options[index] : undefined
    if (label === undefined) {
      void this.deps.send(channel, chatId, `编号在 1 到 ${ask.options.length} 之间 · reply 1 to ${ask.options.length}`)
      return true
    }
    this.settle(sessionId, [label])
    return true
  }

  /** Whether one session has an ask waiting. */
  has(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /** Expire every pending ask and clear the timers; plugin disposal. */
  dispose(): void {
    for (const sessionId of [...this.pending.keys()]) this.expire(sessionId)
  }

  /** Expire one ask on timeout: drop it so the caller delegates. */
  private expire(sessionId: string): void {
    const ask = this.pending.get(sessionId)
    if (ask === undefined) return
    this.clear(sessionId)
    ask.resolve(undefined)
  }

  /** Settle one ask with a concrete outcome. */
  private settle(sessionId: string, outcome: 'allowed-once' | 'rejected' | readonly string[]): void {
    const ask = this.pending.get(sessionId)
    if (ask === undefined) return
    this.clear(sessionId)
    if (ask.kind === 'approval' && typeof outcome === 'string') ask.resolve(outcome)
    else if (ask.kind === 'question' && Array.isArray(outcome)) ask.resolve(outcome)
  }

  private clear(sessionId: string): void {
    const timer = this.timers.get(sessionId)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(sessionId)
    this.pending.delete(sessionId)
  }
}
