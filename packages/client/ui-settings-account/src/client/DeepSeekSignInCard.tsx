// /** DeepSeek model card sign-in action, shown while the account is signed out. */
import { IconUserOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-settings-models' SlotMap merge (the provider-card slot).
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { AccountSectionInjected } from './AccountSection.tsx'
import css from './DeepSeekSignInCard.module.css'

/** Full component props: the card owner share, account actions and copy. */
export type DeepSeekSignInCardProps =
  PropsRuntime<'settings.models.provider-card'> & PropsLocale<'settings.account'> & InjectFace<AccountSectionInjected>

/**
 * Render the DeepSeek card's sign-in action while signed out. The dialog the
 * click opens is the launcher's; a stored credential removes this row and the
 * signed-in DeepSeek 账号 row reports the state itself.
 * @param props - account subscription and the shared sign-in start.
 * @returns the sign-in action row, or nothing while signed in.
 */
export function DeepSeekSignInCard({ useAccount, start, t }: DeepSeekSignInCardProps) {
  const account = useAccount(value => value)
  if (account.view?.status === 'credential-stored') return null
  // The plugin's start publishes `loginFailed` before it rejects, so the
  // dialog owns the report.
  return (
    <div className={css.actions}>
      <button type="button" className={css.button}
        onClick={() => { void start().catch(() => undefined) }}>
        <IconUserOutlineMedium size={16} />
        {t('signIn')}
      </button>
    </div>
  )
}
