/**
 * Browser half: registers the Import settings section and its dictionaries.
 * The section calls the Host import routes directly; it needs no Remote
 * namespace of its own.
 *
 * @module @prism/prism-session-import/client
 */

// Type-only: the ctx.locale Context merge and its namespace map.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the settings.section SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Context } from '@deepseek-ai/cordis'
import { ImportSection } from './ImportSection.tsx'
import { en, zh, type ImportLocaleKey } from './locales.ts'

export type { ImportSectionProps } from './ImportSection.tsx'
export type { ImportLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Cross-agent import page copy. */
    'settings.sessionImport': ImportLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.sessionImport'

/** Services required by the browser half. */
export const inject = ['slots', 'locale']

/**
 * Register the import page.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-import: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'import',
    order: 25,
    label: () => t('nav'),
    locale: NS,
  }, ImportSection))
}
