// PRISM-DIVERGENCE: replay list in docs/compose/spec/approval-sidebar.md (S5).
/** Settlement guard shared by every presentation of one pending approval. */
import { useEffect, useRef, useState } from 'react'
import type { ApprovalDecision, PendingApproval } from './contract/slots.ts'

/** One answer attempt for one request, with the state its presentation renders. */
export interface ApprovalAnswer {
  /** True from the answer until a failed settlement restores the actions. */
  readonly answered: boolean
  /**
   * Answer the pending request, at most once.
   * @param outcome - the decision the user chose.
   */
  readonly answer: (outcome: ApprovalDecision) => void
}

/**
 * Bind one request's answer attempt to the presentation that renders it. A
 * click occupies the single decision slot immediately, so a second surface or
 * a repeated key cannot send another decision; a settlement that fails while
 * this presentation is still mounted and the request is still answerable
 * restores the actions. Rejections that arrive after the request settled or
 * the presentation unmounted belong to the request's own lifetime, not to this
 * one, so they change nothing here.
 * @param pending - the request this presentation shows.
 * @returns the answered state and the answer callback.
 */
export function useApprovalAnswer(pending: PendingApproval): ApprovalAnswer {
  const [answered, setAnswered] = useState(false)
  const waiting = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  const answer = (outcome: ApprovalDecision): void => {
    if (waiting.current || !pending.answerable) return
    waiting.current = true
    setAnswered(true)
    void pending.answer(outcome).catch(() => {
      if (!active.current || !pending.answerable) return
      waiting.current = false
      setAnswered(false)
    })
  }
  return { answered, answer }
}
