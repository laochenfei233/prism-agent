/**
 * Secondary-click additions to the Session row menu: reveal the working
 * directory, copy its path, and open the product settings. They register as
 * ordinary `sidebar.workspaces.session.menu.item` entries, so the "..." menu
 * and the row's context menu present the same rows.
 */
import {
  IconCopyOutlineRegular, IconFolderOpenOutlineRegular, IconSettingsOutlineRegular, MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SessionMenuItemProps, SessionPathInjected, SessionSettingsInjected,
} from '../contract/slots.ts'

/**
 * Reveal the Session's working directory in the Host file manager.
 * @param props - row identity, menu dismissal, the reveal share, and locale.
 * @returns the menu row.
 */
export function RevealSessionMenuItem({ sessionId, useMenuOpenState, revealSession, t }: SessionMenuItemProps<SessionPathInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton separatorBefore icon={<IconFolderOpenOutlineRegular size={14} />} onSelect={() => {
      setMenuOpen(false)
      revealSession(sessionId)
    }}>
      {t('menu.revealSession')}
    </MenuItemButton>
  )
}

/**
 * Copy the Session's working directory path.
 * @param props - row identity, menu dismissal, the path share, and locale.
 * @returns the menu row.
 */
export function CopySessionPathMenuItem({ sessionId, useMenuOpenState, copySessionPath, t }: SessionMenuItemProps<SessionPathInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton icon={<IconCopyOutlineRegular size={14} />} onSelect={() => {
      setMenuOpen(false)
      copySessionPath(sessionId)
    }}>
      {t('menu.copySessionPath')}
    </MenuItemButton>
  )
}

/**
 * Open the product settings surface.
 * @param props - menu dismissal, the settings share, and locale.
 * @returns the menu row.
 */
export function SessionSettingsMenuItem({ useMenuOpenState, openSettings, t }: SessionMenuItemProps<SessionSettingsInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton separatorBefore icon={<IconSettingsOutlineRegular size={14} />} onSelect={() => {
      setMenuOpen(false)
      openSettings()
    }}>
      {t('menu.settings')}
    </MenuItemButton>
  )
}
