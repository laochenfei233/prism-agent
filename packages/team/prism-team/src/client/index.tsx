/**
 * Browser half of `prism-team`: the Team entry in the session header.
 *
 * It sits beside the subagent and background-job chips and reads only through
 * this plugin's own route, so it shows the roster, tasks, and reports the Host
 * already holds rather than a second copy.
 *
 * @module prism-team/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: activate the `ctx.locale` and `ctx.slots` Context merges.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the 'conversation.session.header.actions' SlotMap row must be in the program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { loadTeamPanel } from './api.ts'
import { en, NS, zh } from './locales.ts'
import { TeamAction } from './TeamAction.tsx'
import type { TeamActionInjected } from './TeamAction.tsx'

/** Services both registrations need. */
export const inject = ['slots', 'locale']

/**
 * Register the Team header entry and its copy.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prism-team:dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'prism-team',
    // Beside the subagent catalog (10) and the background jobs (20).
    order: 15,
    locale: NS,
    inject: (sessionId: SessionId): TeamActionInjected => ({
      load: signal => loadTeamPanel(String(sessionId), signal),
      t: key => t(key),
    }),
  }, TeamAction))
}
