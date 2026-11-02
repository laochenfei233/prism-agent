/**
 * Inbound command decisions: the three slash commands a chat can send and
 * how every other text forwards. Pure and tested.
 *
 * @module @prism/prism-pocket/bots
 */

/** What one inbound text means. */
export type InboundDecision =
  | { readonly kind: 'new' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'help' }
  | { readonly kind: 'forward'; readonly text: string }

/**
 * Decide what one inbound text means.
 * @param text - the trimmed inbound text.
 * @returns the decision; non-command text forwards verbatim.
 */
export function decideInbound(text: string): InboundDecision {
  const command = text.trim().toLowerCase()
  if (command === '/new') return { kind: 'new' }
  if (command === '/stop') return { kind: 'stop' }
  if (command === '/help') return { kind: 'help' }
  return { kind: 'forward', text: text.trim() }
}

/** The bilingual command help the chat receives on `/help`. */
export const HELP_TEXT = '命令 / Commands:\n/new — 新会话 · new session\n/stop — 中止回合 · stop the turn\n/help — 本帮助 · this help'
