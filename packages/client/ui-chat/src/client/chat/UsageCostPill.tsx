/**
 * Session-header cost pill: the estimate for this Session, opening the cost
 * dashboard.
 *
 * @module UsageCostPill
 */

import { useState } from 'react'
import { IconDataOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type { UsagePriceEditorInjected } from '../contract/usage.ts'
import { UsageDashboard } from './UsageDashboard.tsx'
import { formatUsd, sessionCost } from './usage-pricing.ts'
import css from './UsageCostPill.module.css'

/** Full props of the session-header cost pill. */
export type UsageCostPillProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'chat'>
  & InjectFace<UsagePriceEditorInjected>

/**
 * Render the Session cost reading and its dashboard.
 * @param props.useProjection - Session projection seat (`tokenUsage`, `modelSelection`).
 * @param props.unitPrices - live custom unit prices.
 * @param props.setUnitPrice - write face handed to the dashboard editor.
 * @param props.t - Chat locale seat.
 * @returns the pill, or null while the Session has no priced usage.
 */
export function UsageCostPill({ useProjection, useUnitPrices, setUnitPrice, t }: UsageCostPillProps) {
  const [open, setOpen] = useState(false)
  const usage = useProjection('tokenUsage')
  const selection = useProjection('modelSelection')
  const overrides = useUnitPrices(value => value)
  const cost = usage === undefined ? undefined : sessionCost(usage, selection?.next?.model, new Date(), overrides)
  const amount = cost === undefined ? undefined : t('cost.usd', { amount: formatUsd(cost.totalUsd) })
  if (cost === undefined || amount === undefined) return null
  return (
    <span className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('cost.pillAria', { amount })}
        onClick={() => { setOpen(!open) }}
      >
        <IconDataOutlineRegular />
        <span className={css.label}>{t('cost.approx', { amount })}</span>
      </button>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={t('cost.dialog.title')}
        closeLabel={t('cost.dialog.close')}
      >
        <UsageDashboard cost={cost} overrides={overrides} setUnitPrice={setUnitPrice} t={t} />
      </Modal>
    </span>
  )
}
