// PRISM-DIVERGENCE: replay list in docs/compose/spec/approval-sidebar.md (S5).
/** Composer takeover for one pending approval waterfall. */
import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApprovalComposerProps, PendingApproval } from './contract/slots.ts'
import { useApprovalAnswer } from './use-approval-answer.ts'
import css from './ApprovalPanel.module.css'

/**
 * Render one pending approval and its optional Tool-owned detail.
 * @param props - selector-matched request and standard Slot props.
 * @returns The approval composer takeover.
 */
export function ApprovalPanel(props: ApprovalComposerProps) {
  const approval = props.matched
  const detail = approval.callId === undefined
    ? null
    : props.renderSlot('conversation.approval.detail', { callId: approval.callId })
  const reason = approval.displayReason === undefined ? approval.reason : props.resolveReason(approval.displayReason)
  return <ApprovalFlow key={approval.key} pending={approval} reason={reason} detail={detail} t={props.t} />
}

function ApprovalFlow({ pending, reason, detail, t }: {
  pending: PendingApproval
  reason: string | undefined
  detail: ReactNode
  t: ApprovalComposerProps['t']
}) {
  const { answered, answer } = useApprovalAnswer(pending)
  const composing = useRef(false)
  const compositionEnded = useRef(false)
  // Arrows move focus between the two actions; Enter then presses the focused one through its own click handler.
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>): boolean => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false
    const row = event.currentTarget.querySelector<HTMLElement>('[data-approval-actions]')
    /* v8 ignore next -- the action row is part of this component's own markup. */
    if (row === null) return false
    const actions = [...row.querySelectorAll<HTMLElement>('button:not(:disabled)')]
    if (actions.length === 0) return false
    const current = actions.indexOf(document.activeElement as HTMLElement)
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
    const next = current === -1 ? (delta === 1 ? 0 : actions.length - 1) : (current + delta + actions.length) % actions.length
    const target = actions[next]
    /* v8 ignore next -- a non-empty action list resolves every position it is asked for. */
    if (target === undefined) return false
    target.focus()
    event.preventDefault()
    event.stopPropagation()
    return true
  }
  const keydown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const element = event.target as Element
    if (event.defaultPrevented || !event.currentTarget.contains(document.activeElement)
      || element.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null) return
    if (moveFocus(event)) return
    if (event.key !== 'Enter' && event.key !== 'Escape') return
    if (event.key === 'Enter' && element.closest('button, a[href], [role="button"]') !== null) return
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    // oxlint-disable-next-line typescript/no-deprecated -- IME 229 covers engines without isComposing.
    if (event.repeat || composing.current || compositionEnded.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    answer(event.key === 'Enter' ? 'allowed-once' : 'rejected')
  }
  return (
    <div className={css.root} data-approval-key={pending.key} aria-busy={answered}
      onKeyDown={keydown}
      onKeyUpCapture={() => { compositionEnded.current = false }}
      onCompositionStartCapture={() => { composing.current = true }}
      onCompositionEndCapture={() => { composing.current = false; compositionEnded.current = true }}>
      <div className={css.card}>
        <div className={css.strip}><StateDot state={answered ? 'ongoing' : 'warning'} />{t('waiting')}</div>
        <div
          className={css.body}
          data-approval-scroll=""
          tabIndex={0}
          role="group"
          aria-label={t('detail.aria')}
        >
          <div className={css.headline}>{reason ?? t('escalation', { toolName: pending.toolName })}</div>
          {detail !== null && <div className={css.command}>{detail}</div>}
        </div>
        <div className={css.actionRow} data-approval-actions="">
          <Button variant="outline" className={css.reject} disabled={answered} onClick={() => { answer('rejected') }}>
            {t('reject')}
          </Button>
          <Button variant="primary" disabled={answered} onClick={() => { answer('allowed-once') }}>
            {t('allowOnce')}
          </Button>
        </div>
      </div>
    </div>
  )
}
