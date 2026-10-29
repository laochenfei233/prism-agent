/**
 * Notification triggers: wiring the host event seams to the deliverer.
 *
 * Three seams, all read-only observations:
 * - `session/event` for turn outcomes (`turn/end`, its reason map is
 *   merge-extensible, so unknown kinds fall through silently);
 * - the `approval/request` answerer waterfall, which MUST call `next()` and
 *   is only observed, never answered;
 * - the `user-questions/request` answerer waterfall, same contract.
 *
 * @module @prism/prism-pocket/push
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the 'session/event' Events merge and the Session/SessionEvent types.
import type {} from '@deepseek-ai/dsh-session'
// Type-only: the 'approval/request' Events merge.
import type {} from '@deepseek-ai/dsh-user-approval'
// Type-only: the 'user-questions/request' Events merge.
import type {} from '@deepseek-ai/dsh-user-questions'
import type { PocketPushPayload } from '../types.ts'

/** Fire-and-forget notification sink; implementations must not throw. */
export type PocketDeliverer = (payload: PocketPushPayload, urgency: 'high' | 'normal') => void

/** Turn-completion notification policy. */
export interface TriggerOptions {
  /** Deliver a `turn-end` payload for cleanly completed turns. */
  notifyTurnComplete: boolean
}

/**
 * Install the trigger listeners.
 * @param ctx - host context; every registration rides `ctx.effect`.
 * @param deliver - the notification sink.
 * @param options - turn-completion policy.
 */
export function installPocketTriggers(ctx: Context, deliver: PocketDeliverer, options: TriggerOptions): void {
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const kind = event.data.reason.kind
    if (kind === 'error') {
      deliver({ kind: 'error', sessionId: session.id }, 'high')
      return
    }
    if (kind === 'completed' && options.notifyTurnComplete) {
      deliver({ kind: 'turn-end', sessionId: session.id }, 'normal')
    }
    // Unknown reason kinds are merge extensions owned elsewhere; stay silent.
  }), 'pocket: turn events')

  ctx.effect(() => ctx.on('approval/request', async (request, next) => {
    deliver({ kind: 'approval', detail: request.toolName }, 'high')
    return await next()
  }), 'pocket: approval requests')

  ctx.effect(() => ctx.on('user-questions/request', async (request, next) => {
    const detail = request.questions[0]?.question
    deliver({ kind: 'question', ...(detail !== undefined ? { detail } : {}) }, 'high')
    return await next()
  }), 'pocket: user questions')
}
