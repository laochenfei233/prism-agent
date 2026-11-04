/**
 * Feedback rows of one assistant message's secondary-press menu. Either row
 * closes the menu and opens the Session's feedback dialog for that message,
 * which records the judgment with its category and text on submission. The
 * strip's one-click retract stays on the message's action row; the menu always
 * opens the dialog, the product's path for changing a recorded judgment.
 * @module @deepseek-ai/dsh-client-ui-message-feedback/client/MessageFeedbackMenuItems
 */

import { IconDislikeOutlineRegular, IconLikeOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MessageFeedbackRating } from '@deepseek-ai/dsh-message-feedback/types'
import type { MessageFeedbackMenuProps } from './slots.ts'

/**
 * One message's feedback rows in its context menu.
 * @param props - the message identity, the dialog verb, menu dismissal, and locale.
 * @returns the two menu rows.
 */
export function MessageFeedbackMenuItems({ messageId, openDialog, useMenuOpenState, t }: MessageFeedbackMenuProps) {
  const [, setMenuOpen] = useMenuOpenState()
  const choose = (rating: MessageFeedbackRating): void => {
    setMenuOpen(false)
    openDialog(messageId, rating)
  }
  return (
    <>
      <MenuItemButton separatorBefore icon={<IconLikeOutlineRegular size={14} />} onSelect={() => { choose('positive') }}>
        {t('action.like')}
      </MenuItemButton>
      <MenuItemButton icon={<IconDislikeOutlineRegular size={14} />} onSelect={() => { choose('negative') }}>
        {t('action.dislike')}
      </MenuItemButton>
    </>
  )
}
