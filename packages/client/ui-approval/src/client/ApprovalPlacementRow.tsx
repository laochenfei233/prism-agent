// PRISM-DIVERGENCE: replay list in docs/compose/spec/approval-panel.md (S5).
/**
 * General-settings row for the approval placement preference. It is the same
 * browser preference the Progress panel's header control writes, so either
 * entry point moves the decisions between the two surfaces.
 */
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ApprovalPlacement } from './placement.ts'
import css from './ApprovalPlacementRow.module.css'

/** Injected share: the placement source and its single write path. */
export interface ApprovalPlacementRowInjected {
  hooks: {
    /** Where the decisions live; both surfaces stay readable either way. */
    placement: HostObservable<ApprovalPlacement>
  }
  /**
   * Persist a placement and publish it to every surface in this window.
   * @param value - the placement the reader chose.
   */
  setPlacement(value: ApprovalPlacement): void
}

/** Full component props: runtime share, copy, and the placement face. */
export type ApprovalPlacementRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'approval'>
  & InjectFace<ApprovalPlacementRowInjected>

/**
 * Render the approval-placement row.
 * @param props - runtime share, localized copy, and the placement hooks.
 * @returns the row element tree.
 */
export function ApprovalPlacementRow({ usePlacement, setPlacement, t }: ApprovalPlacementRowProps) {
  const placement = usePlacement(value => value)
  return (
    <div className={css.row}>
      <div className={css.text}>
        <div className={css.title}>{t('settings.title')}</div>
        <div className={css.description}>{t('settings.description')}</div>
      </div>
      <SegmentedControl
        id="approval-placement"
        label={t('settings.title')}
        value={placement}
        options={[
          { value: 'progress', label: t('settings.progress') },
          { value: 'list', label: t('settings.list') },
        ]}
        onChange={(value) => { setPlacement(value === 'list' ? 'list' : 'progress') }}
      />
    </div>
  )
}
