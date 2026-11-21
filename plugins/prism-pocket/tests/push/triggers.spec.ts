/**
 * The trigger decisions: which session events and answerer asks deliver
 * which payloads, and that every observer delegates instead of claiming.
 *
 * The unknown-kind silence case declares its own `TurnEndReasonMap` variant
 * through the same merge extension a real plugin would use.
 */
import { describe, expect, it } from 'vitest'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import type { SessionEvent, SessionId, SessionSeq, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { installTriggerLogic, type TriggerRegistrar } from '../../src/push/triggers.ts'
import type { PocketPushPayload } from '../../src/types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface TurnEndReasonMap {
    /** A merge-extension reason kind no pocket trigger may notify about. */
    'test/silent': { kind: 'test/silent' }
  }
}

/** Recorded deliveries. */
type Delivery = { payload: PocketPushPayload; urgency: string }

/** A registrar that captures its listeners for direct invocation. */
function capturing(): TriggerRegistrar & {
  sessionEvents: Array<(session: { id: SessionId }, event: SessionEvent) => void>
  approvals: Array<(request: { toolName: string }, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>>
  questions: Array<(request: { questions: Array<{ question: string }> }, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>>
} {
  const sessionEvents: Array<(session: { id: SessionId }, event: SessionEvent) => void> = []
  const approvals: Array<(request: { toolName: string }, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>> = []
  const questions: Array<(request: { questions: Array<{ question: string }> }, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>> = []
  return {
    sessionEvents,
    approvals,
    questions,
    onSessionEvent: listener => { sessionEvents.push(listener) },
    onApprovalRequest: listener => { approvals.push(listener) },
    onUserQuestionsRequest: listener => { questions.push(listener) },
  }
}

/** One `turn/end` envelope carrying the requested outcome. */
function turnEnd(reason: TurnEndReason): SessionEvent {
  return { type: 'turn/end', seq: brandNumber<SessionSeq>(7), time: 0, data: { turn: 2, reason } }
}

/** The subject under test: captured seats plus that run's deliveries. */
function installed(notifyTurnComplete = true): {
  registrar: ReturnType<typeof capturing>
  delivered: Delivery[]
} {
  const registrar = capturing()
  const delivered: Delivery[] = []
  installTriggerLogic(registrar, (payload, urgency) => { delivered.push({ payload, urgency }) }, { notifyTurnComplete })
  return { registrar, delivered }
}

describe('installTriggerLogic', () => {
  it('delivers completed turns when turn notifications are on', () => {
    const { registrar, delivered } = installed(true)
    registrar.sessionEvents[0]?.({ id: brandString<SessionId>('sess-1') }, turnEnd({ kind: 'completed' }))
    expect(delivered).toEqual([
      { payload: { kind: 'turn-end', sessionId: 'sess-1' }, urgency: 'normal' },
    ])
  })

  it('suppresses completed turns when turn notifications are off', () => {
    const { registrar, delivered } = installed(false)
    registrar.sessionEvents[0]?.({ id: brandString<SessionId>('sess-1') }, turnEnd({ kind: 'completed' }))
    expect(delivered).toEqual([])
  })

  it('delivers failures at high urgency and stays silent on other kinds', () => {
    const { registrar, delivered } = installed(true)
    const session = { id: brandString<SessionId>('sess-1') }
    registrar.sessionEvents[0]?.(session, turnEnd({ kind: 'error', error: { code: 'UNKNOWN', message: 'boom' } }))
    registrar.sessionEvents[0]?.(session, turnEnd({ kind: 'test/silent' }))
    expect(delivered).toEqual([
      { payload: { kind: 'error', sessionId: 'sess-1' }, urgency: 'high' },
    ])
  })

  it('ignores non-turn events', () => {
    const { registrar, delivered } = installed(true)
    registrar.sessionEvents[0]?.({ id: brandString<SessionId>('sess-1') }, {
      type: 'turn/start',
      seq: brandNumber<SessionSeq>(1),
      time: 0,
      data: { turn: 2 },
    })
    expect(delivered).toEqual([])
  })

  it('observes approval asks, carries the tool name, and still delegates', async () => {
    const { registrar, delivered } = installed()
    let delegated = false
    const outcome = await registrar.approvals[0]?.({ toolName: 'bash' }, async () => {
      delegated = true
      return 'allowed-once'
    })
    expect(delegated).toBe(true)
    expect(outcome).toBe('allowed-once')
    expect(delivered).toEqual([
      { payload: { kind: 'approval', detail: 'bash' }, urgency: 'high' },
    ])
  })

  it('observes user-question asks with the first question and delegates', async () => {
    const { registrar, delivered } = installed()
    const answer: AskUserQuestionAnswer = { answers: [{ id: 'q1', selected: ['postgres'] }] }
    await registrar.questions[0]?.({ questions: [{ question: 'Which database?' }] }, async () => answer)
    expect(delivered).toEqual([
      { payload: { kind: 'question', detail: 'Which database?' }, urgency: 'high' },
    ])
  })
})
