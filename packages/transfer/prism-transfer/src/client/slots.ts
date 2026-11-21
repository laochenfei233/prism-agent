/**
 * Props of the project-row export entry. The transfer page's own props live
 * beside its component; this type exists because the entry renders inside
 * ui-workspace's `sidebar.workspaces.project.menu.item` list.
 * @module @prism/prism-transfer/client/slots
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the ui-workspace SlotMap row this entry registers into.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: this package's `settings.transfer` LocaleNamespaceMap merge.
import type {} from './index.ts'

/** Full props of the project-row export entry. */
export type ProjectExportMenuProps =
  PropsRuntime<'sidebar.workspaces.project.menu.item'>
  & PropsLocale<'settings.transfer'>
