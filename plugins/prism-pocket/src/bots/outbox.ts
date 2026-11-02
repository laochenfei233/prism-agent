/**
 * The reply outbox: assistant messages of bot-bound sessions queue per chat
 * and deliver through the channel handle, serialized so replies never
 * interleave. Failures log and never clear the binding.
 *
 * @module @prism/prism-pocket/bots
 */

import type { BotChannelId, BotHandle } from './types.ts'
import type { BotReplyTarget } from './binding.ts'

/** Where the outbox sends and how it reports failures. */
export interface BotOutboxDeps {
  /** Resolve one session's reply target, when a bot bound it. */
  readonly targetOf: (sessionId: string) => BotReplyTarget | undefined
  /** Resolve the running handle of one channel. */
  readonly handleOf: (channel: BotChannelId) => BotHandle | undefined
  /** Failure reporter. */
  readonly warn: (detail: string) => void
}

/** The outbox: per-chat serialized reply delivery. */
export class BotOutbox {
  private readonly queues = new Map<string, { channel: BotChannelId; chatId: string; pieces: readonly string[]; running: boolean }>()
  private readonly deps: BotOutboxDeps

  /**
   * @param deps - target resolution, handle resolution, and the failure reporter.
   */
  constructor(deps: BotOutboxDeps) {
    this.deps = deps
  }

  /**
   * Queue one assistant message for its bound chat; the channel adapter
   * chunks to its own limit.
   * @param sessionId - the session the assistant spoke in.
   * @param text - the assistant message's text content; empty text is dropped.
   */
  onAssistantText(sessionId: string, text: string): void {
    if (text.trim().length === 0) return
    const target = this.deps.targetOf(sessionId)
    if (target === undefined) return
    const handle = this.deps.handleOf(target.channel)
    if (handle === undefined) return
    const queue = this.queues.get(target.chatId) ?? { channel: target.channel, chatId: target.chatId, pieces: [], running: false }
    queue.pieces = [...queue.pieces, text]
    this.queues.set(target.chatId, queue)
    if (!queue.running) void this.drain(queue)
  }

  /** Drain one queue to the handle, one piece at a time. */
  private async drain(queue: { channel: BotChannelId; chatId: string; pieces: readonly string[]; running: boolean }): Promise<void> {
    queue.running = true
    try {
      while (queue.pieces.length > 0) {
        const piece = queue.pieces[0]
        if (piece === undefined) return
        queue.pieces = queue.pieces.slice(1)
        const handle = this.deps.handleOf(queue.channel)
        if (handle === undefined) return
        await handle.send(queue.chatId, piece)
      }
    } catch (cause: unknown) {
      this.deps.warn(cause instanceof Error ? cause.message : String(cause))
    } finally {
      queue.running = false
      if (queue.pieces.length === 0) this.queues.delete(queue.chatId)
    }
  }
}

/**
 * Extract the text content of one assistant message.
 * @param message - the `assistant/message` event's message value.
 * @returns the concatenated text parts, or the empty string when none.
 */
export function assistantTextOf(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const text = content
    .filter((part): part is { type: 'text'; text: string } =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text')
    .map(part => part.text)
    .join('')
  return text
}
