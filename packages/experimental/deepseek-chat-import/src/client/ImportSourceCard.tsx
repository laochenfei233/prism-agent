/** Import-page source card that opens the DeepSeek export import dialog. */
import { useState } from 'react'
import { IconUploadOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeepseekChatImportInjected, ImportSessionsActionProps } from './ImportSessions.tsx'
import { ImportDialog } from './ImportSessions.tsx'
import css from './ImportSessions.module.css'

/**
 * Props composed by the `settings.sessionImport.source` slot for the DeepSeek
 * export card: the import callback, the global hooks the dialog reuses, and
 * the namespace copy.
 */
export type DeepseekImportSourceProps =
  & Pick<
    ImportSessionsActionProps,
    'renderFactorySlot' | 'useSessions' | 'useWorkspaces' | 'useRemoteAccess'
  >
  & InjectFace<DeepseekChatImportInjected>
  & PropsLocale<'deepseekChatImport'>

/**
 * Render the first source card of the cross-agent import page; opening it
 * shows the same dialog the retired sidebar action used. A Peer that may not
 * import renders no card.
 * @param props - the import callback, global hooks, and the locale seat.
 * @returns the source card with its dialog while open, or nothing without permission.
 */
export function DeepseekImportSource(props: DeepseekImportSourceProps) {
  const { t, useRemoteAccess } = props
  const allowed = useRemoteAccess('deepseekChatImport/limits')
  const [open, setOpen] = useState(false)
  if (!allowed) return null
  return (
    <>
      <button
        type="button"
        className={css.sourceCard}
        onClick={() => { setOpen(true) }}
      >
        <span className={css.sourceMark} aria-hidden="true">DS</span>
        <span className={css.sourceBody}>
          <span className={css.sourceName}>{t('source.name')}</span>
          <span className={css.sourceDescription}>{t('source.description')}</span>
        </span>
        <IconUploadOutlineRegular size={18} />
      </button>
      {open && <ImportDialog {...props} onClose={() => { setOpen(false) }} />}
    </>
  )
}
