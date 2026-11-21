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
 * The decision logic takes a structural registrar, so the tests drive it
 * without a Cordis context; {@link installPocketTriggers} is the thin
 * wiring onto the real seams.
 *
 * @module @prism/prism-pocket/push
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the 'session/event' Events merge and the Session/SessionEvent types.
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: the 'approval/request' Events merge and its outcome union.
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
// Type-only: the 'user-questions/request' Events merge and its answer union.
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type { PocketPushPayload } from '../types.ts'

/** Fire-and-forget notification sink; implementations must not throw. */
export type PocketDeliverer = (payload: PocketPushPayload, urgency: 'high' | 'normal') => void

/** Turn-completion notification policy. */
export interface TriggerOptions {
  /** Deliver a `turn-end` payload for cleanly completed turns. */
  notifyTurnComplete: boolean
}

/** The three listener seats the triggers need, abstracted for testing. */
export interface TriggerRegistrar {
  /** Observe one session's event stream; the listener reads only the id. */
  onSessionEvent(listener: (session: Pick<Session, 'id'>, event: SessionEvent) => void): void
  /** Observe one approval ask; the listener delegates through `next()`. */
  onApprovalRequest(listener: (request: { readonly toolName: string }, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>): void
  /** Observe one user-question ask; the listener delegates through `next()`. */
  onUserQuestionsRequest(listener: (request: { readonly questions: ReadonlyArray<{ question: string }> }, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>): void
}

/**
 * Install the trigger listeners on the real host seams.
 * @param ctx - host context; every registration rides `ctx.effect`.
 * @param deliver - the notification sink.
 * @param options - turn-completion policy.
 */
export function installPocketTriggers(ctx: Context, deliver: PocketDeliverer, options: TriggerOptions): void {
  const registrar: TriggerRegistrar = {
    onSessionEvent: listener => { ctx.effect(() => ctx.on('session/event', listener), 'pocket: turn events') },
    onApprovalRequest: listener => {
      ctx.effect(() => ctx.on('approval/request', async (request, next) => listener(request, next)), 'pocket: approval requests')
    },
    onUserQuestionsRequest: listener => {
      ctx.effect(() => ctx.on('user-questions/request', async (request, next) => listener(request, next)), 'pocket: user questions')
    },
  }
  installTriggerLogic(registrar, deliver, options)
}

/**
 * The trigger decisions, testable without a Cordis context.
 * @param registrar - the listener seats.
 * @param deliver - the notification sink.
 * @param options - turn-completion policy.
 */
export function installTriggerLogic(registrar: TriggerRegistrar, deliver: PocketDeliverer, options: TriggerOptions): void {
  registrar.onSessionEvent((session, event) => {
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
  })

  registrar.onApprovalRequest(async (request, next) => {
    deliver({ kind: 'approval', detail: request.toolName }, 'high')
    return await next()
  })

  registrar.onUserQuestionsRequest(async (request, next) => {
    const detail = request.questions[0]?.question
    deliver({ kind: 'question', ...(detail !== undefined ? { detail } : {}) }, 'high')
    return await next()
  })
}
