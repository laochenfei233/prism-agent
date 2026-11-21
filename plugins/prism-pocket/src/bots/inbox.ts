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
  | { readonly kind: 'pair'; readonly code?: string }
  | { readonly kind: 'forward'; readonly text: string }

/**
 * Decide what one inbound text means.
 * @param text - the trimmed inbound text.
 * @returns the decision; non-command text forwards verbatim. `/start` pairs:
 * bare `/start` reads as the hint, `/start <code>` carries the pairing code.
 */
export function decideInbound(text: string): InboundDecision {
  const command = text.trim().toLowerCase()
  if (command === '/new') return { kind: 'new' }
  if (command === '/stop') return { kind: 'stop' }
  if (command === '/help') return { kind: 'help' }
  if (command === '/start') return { kind: 'pair' }
  if (command.startsWith('/start ')) {
    const code = command.slice('/start '.length).trim().split(/\s+/u)[0] ?? ''
    return code.length > 0 ? { kind: 'pair', code } : { kind: 'pair' }
  }
  return { kind: 'forward', text: text.trim() }
}

/** The bilingual command help the chat receives on `/help`. */
export const HELP_TEXT = '命令 / Commands:\n/start <code> — 用口袋页面的配对码绑定 · pair with the code from the Pocket page\n/new — 新会话 · new session\n/stop — 中止回合 · stop the turn\n/help — 本帮助 · this help'
