/**
 * Project-row menu entry: download this Workspace's single-project archive
 * through the streaming export route. The browser owns the transfer; the row
 * closes the menu first so it does not stay open over the download.
 * @module @prism/prism-transfer/client/ProjectExportMenuItem
 */

import { IconDownloadOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { TRANSFER_EXPORT_PATH } from '../routes.ts'
import type { ProjectExportMenuProps } from './slots.ts'

/**
 * Export the pressed Workspace as a project archive.
 * @param props - the Workspace id, menu dismissal, and the transfer copy.
 * @returns the menu row.
 */
export function ProjectExportMenuItem({ workspaceId, useMenuOpenState, t }: ProjectExportMenuProps) {
  const [, setMenuOpen] = useMenuOpenState()
  const exportProject = (): void => {
    setMenuOpen(false)
    const query = new URLSearchParams({ projects: workspaceId, settings: '0', secrets: '0' })
    // The streaming route hands the zip to the browser's download manager.
    const anchor = document.createElement('a')
    anchor.href = `${TRANSFER_EXPORT_PATH}?${String(query)}`
    anchor.download = ''
    anchor.click()
  }
  return (
    <MenuItemButton separatorBefore icon={<IconDownloadOutlineRegular size={14} />} onSelect={exportProject}>
      {t('menuExportProject')}
    </MenuItemButton>
  )
}
