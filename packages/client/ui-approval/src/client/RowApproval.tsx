// PRISM-DIVERGENCE: replay list in docs/compose/spec/approval-panel.md (S5).
/** One Session row's pending approval: its summary, and its decisions when the list carries them. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApprovalRowProps } from './contract/slots.ts'
import { PendingApproval } from './contract/slots.ts'
import { useApprovalAnswer } from './use-approval-answer.ts'
import css from './RowApproval.module.css'

/** One row's occupant; the alias names the props the registration derives. */
export type RowApprovalProps = ApprovalRowProps

/**
 * Project one row's pending approval from the Session status snapshot. The
 * summary is always shown; the decisions appear only while the reader's
 * placement preference names this surface.
 * @param props - the row's owner share, copy seat, reason resolver, and placement hook.
 * @returns the compact line, or nothing when this Session waits on another interaction.
 */
export function RowApproval(props: ApprovalRowProps) {
  const placement = props.usePlacement(value => value)
  const pending = props.useSessionStatus((snapshot) => {
    const value = snapshot.get(props.sessionId)?.pendingInteraction
    return value instanceof PendingApproval ? value : undefined
  })
  if (pending === undefined) return null
  // Resolve the requester's copy here, where the injected resolver is reached
  // as one member of the props object, and pass the finished text down.
  const summary = pending.displayReason === undefined
    ? pending.reason ?? props.t('escalation', { toolName: pending.toolName })
    : props.resolveReason(pending.displayReason)
  const actionable = placement === 'list'
  // The key states which request this line answers: a replacement request
  // remounts the line, so the previous answered state never leaks into it.
  return (
    <RowApprovalLine
      key={pending.key}
      pending={pending}
      summary={summary}
      actionable={actionable}
      displayTitle={props.displayTitle}
      t={props.t}
    />
  )
}

function RowApprovalLine({ pending, summary, actionable, displayTitle, t }: {
  pending: PendingApproval
  summary: string
  actionable: boolean
  displayTitle: string
  t: ApprovalRowProps['t']
}) {
  const { answered, answer } = useApprovalAnswer(pending)
  return (
    <div className={css.line} data-row-approval={pending.toolName} aria-busy={answered}>
      <span className={css.summary} title={summary}>{summary}</span>
      <span className={css.actions}>
        {actionable
          ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className={css.reject}
                disabled={answered}
                aria-label={t('rejectFor', { title: displayTitle })}
                onClick={() => { answer('rejected') }}
              >
                {t('reject')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={answered}
                aria-label={t('allowOnceFor', { title: displayTitle })}
                onClick={() => { answer('allowed-once') }}
              >
                {t('allowOnce')}
              </Button>
            </>
          )
          : <span className={css.hint}>{t('hint.progress')}</span>}
      </span>
    </div>
  )
}
