// PRISM-DIVERGENCE: replay list in docs/compose/spec/approval-sidebar.md (S5).
/** One Session row's pending approval: its summary and its two decisions. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ApprovalInjected } from './contract/slots.ts'
import { PendingApproval } from './contract/slots.ts'
import { useApprovalAnswer } from './use-approval-answer.ts'
import css from './RowApproval.module.css'

/** Props of the row occupant: the row's Session identity, approval copy, and its injected reason resolver. */
export type RowApprovalProps =
  PropsRuntime<'sidebar.workspaces.session.pending'>
  & PropsLocale<'approval'>
  & ApprovalInjected

/**
 * Project one row's pending approval from the Session status snapshot.
 * @param props - the row's owner share, copy seat, and reason resolver.
 * @returns the compact line, or nothing when this Session waits on another interaction.
 */
export function RowApproval(props: RowApprovalProps) {
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
  // The key states which request this line answers: a replacement request
  // remounts the line, so the previous answered state never leaks into it.
  return <RowApprovalLine key={pending.key} pending={pending} summary={summary} displayTitle={props.displayTitle} t={props.t} />
}

function RowApprovalLine({ pending, summary, displayTitle, t }: {
  pending: PendingApproval
  summary: string
  displayTitle: string
  t: RowApprovalProps['t']
}) {
  const { answered, answer } = useApprovalAnswer(pending)
  return (
    <div className={css.line} data-row-approval={pending.toolName} aria-busy={answered}>
      <span className={css.summary} title={summary}>{summary}</span>
      <span className={css.actions}>
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
      </span>
    </div>
  )
}
