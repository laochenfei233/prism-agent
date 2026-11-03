/**
 * Browser half of Prism Pocket: the mobile adaptation, page-open
 * notifications, PWA install, and the settings section.
 *
 * Every visual surface is either a slot occupant (settings section) or a
 * plugin-owned portal (notification cards); the adaptations are classes and
 * CSS anchored on the app's `[data-slot]` seams, so the desktop experience is
 * untouched when the plugin is inactive.
 *
 * @module @prism/prism-pocket/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale Context merge and its namespace map.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the settings.section SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { watchActivation } from './activate.ts'
import { installAdapter, type LayoutLike } from './adapter.ts'
import { POCKET_CSS } from './css.ts'
import { en, NS, zh, type PocketLocaleKey } from './locales.ts'
import { installNotify } from './notify.tsx'
import { installPwa } from './pwa.ts'
import { PocketSection } from './PocketSection.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Pocket settings and card copy. */
    'pocket.settings': PocketLocaleKey
  }
}

/** Services required by the browser half (`layout` orders the drawer seam). */
export const inject = ['slots', 'locale', 'remote', 'layout']

/**
 * Register the pocket browser surfaces.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'pocket: dictionaries')
  const t = ctx.locale.bind(NS)

  // The page styles stay on every surface; the adaptation sheet is active-gated.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'prism-pocket'
    style.textContent = POCKET_CSS
    document.head.append(style)
    return () => { style.remove() }
  }, 'pocket: page stylesheet')

  installPwa()
  ctx.effect(() => installNotify(ctx, t), 'pocket: page notifications')

  const layout = Reflect.get(ctx, 'layout') as LayoutLike | undefined
  let uninstallAdapter: (() => void) | null = null
  const stopWatching = watchActivation(localStorage, (active) => {
    if (active) {
      if (uninstallAdapter === null && layout !== undefined) uninstallAdapter = installAdapter(layout)
      return
    }
    uninstallAdapter?.()
    uninstallAdapter = null
  })
  ctx.effect(() => () => {
    stopWatching()
    uninstallAdapter?.()
    uninstallAdapter = null
  }, 'pocket: activation')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'pocket',
    order: 30,
    label: () => t('nav'),
    locale: NS,
  }, PocketSection))
}
