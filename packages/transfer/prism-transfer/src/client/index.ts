/**
 * Browser half: registers the import/export page inside the 数据 settings
 * section and its dictionaries. The page calls the Host transfer routes
 * directly and needs no Remote namespace of its own.
 *
 * @module @prism/prism-transfer/client
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the 数据 section's `settings.data.page` SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.workspaces merge.
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: the ui-workspace project-row menu SlotMap row.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: the ctx.remote merge that carries remote.directoryPicker.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@prism/prism-data/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ProjectExportMenuItem } from './ProjectExportMenuItem.tsx'
import { TransferSection, type TransferFace } from './TransferSection.tsx'
import { zh, en, type TransferLocaleKey } from './locales.ts'

export type { TransferSectionProps } from './TransferSection.tsx'
export type { TransferFace } from './TransferSection.tsx'
export type { TransferLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Transfer settings page copy. */
    'settings.transfer': TransferLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.transfer'

/** Services required by the browser half. */
export const inject = ['slots', 'locale', 'workspaces', 'remote', 'remote.directoryPicker']

/**
 * Register the import/export page inside the 数据 settings section.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prism-transfer: dictionaries')
  const face: TransferFace = {
    workspaces: ctx.workspaces,
    // Wrapped: the face carries the structural surface and unwraps the wire
    // Result, so the section stays decoupled from the generated namespace.
    directoryPicker: {
      pick: async (signal) => {
        const result = await ctx.remote.directoryPicker.pick(signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
    },
  }
  ctx.slots.inject('settings.data.page', () => ctx.slots.register({
    name: 'settings.data.page',
    id: 'transfer',
    locale: NS,
    inject: () => face,
  }, TransferSection))
  // The project row's right-click menu gains the export action; the settings
  // page remains the place for multi-project and settings archives.
  ctx.slots.inject('sidebar.workspaces.project.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.project.menu.item',
    id: 'export-project',
    order: 900,
    locale: NS,
  }, ProjectExportMenuItem))
}
