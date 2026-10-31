/** General settings feedback row opening the configured GitHub issues address. */
import { IconRightUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './FeedbackRow.module.css'

/** Injected share: the deployment's feedback destination. */
export interface FeedbackRowInjected {
  /** GitHub issues URL the row opens in a new tab. */
  issuesUrl: string
}

/** Full component props: runtime share, copy and the destination. */
export type FeedbackRowProps =
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings.account'> & InjectFace<FeedbackRowInjected>

/**
 * Render the last General settings row.
 * @param props - runtime share, localized copy and the issues URL.
 * @returns the feedback link row.
 */
export function FeedbackRow({ issuesUrl, t }: FeedbackRowProps) {
  return (
    <div className={css.row}>
      <a className={css.link} href={issuesUrl} target="_blank" rel="noopener noreferrer">
        {t('feedback')}<IconRightUpOutlineRegular size={12} />
      </a>
    </div>
  )
}
