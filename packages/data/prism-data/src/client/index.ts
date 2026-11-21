/**
 * Data settings, browser half: the 数据 navigation entry, its three tabs, and
 * the storage tab that moves the harness home. This package owns the page
 * chrome and the placement slots only — the backup, archive transfer, and
 * cross-agent import pages stay with their features and register into
 * `settings.data.page`.
 *
 * @module @prism/prism-data/client
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots merge and the settings.section SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.remote merge and the namespace type carrying the picker.
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { DataSection, type DataSectionInjected } from './DataSection.tsx'
import { en, zh, type DataLocaleKey } from './locales.ts'

export type { DataSectionInjected, DataSectionProps } from './DataSection.tsx'
export type { StoragePageProps } from './StoragePage.tsx'
export type { DataLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Data settings page copy. */
    'settings.data': DataLocaleKey
  }
  interface SlotMap {
    /**
     * One page inside the 数据 settings section. The section owner renders the
     * three tabs and mounts each contribution inside the tab that names it;
     * options carry only `id`, so a page cannot rename or reorder its tab.
     */
    'settings.data.page': { kind: 'list'; scope: 'root'; owner: SettingsDataPageOwnerProps }
  }
}

/** Owner share of a data page (the section supplies nothing). */
export interface SettingsDataPageOwnerProps {
  /** Marker field: page owner props are intentionally empty. */
  children?: never
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.data'

/** Services required by the browser half. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Register the data section once the shell's settings slot is declared.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prism-data: dictionaries')
  const t = ctx.locale.bind(NS)
  const face: DataSectionInjected = {
    // Wrapped: the face unwraps the wire Result so the section stays decoupled
    // from the generated namespace. The picker is optional — a deployment that
    // serves none keeps the typed-path field and shows the unavailable hint.
    pickDirectory: async (signal) => {
      // The picker is optional here, so it is read through the service store:
      // the declared injection would otherwise hold the whole section pending.
      const picker = ctx.get('remote.directoryPicker') as ClientRemote['directoryPicker'] | undefined
      if (picker === undefined) throw new Error('this deployment serves no directory picker')
      const result = await picker.pick(signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'data',
    order: 25,
    label: () => t('nav'),
    locale: NS,
    inject: () => face,
    children: { 'settings.data.page': { kind: 'list', scope: 'root' } },
  }, DataSection))
}
