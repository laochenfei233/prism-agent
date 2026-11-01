/**
 * Browser half: registers the Prism Search settings section and its
 * dictionaries. The model picker reads the Models catalog through the Remote
 * service, so no model name lives in this package.
 *
 * @module @prism/prism-search/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { createSettingsBridge, type RemoteLike, type SaveRequest } from './bridge.ts'
import { en, NS, zh } from './locales.ts'
import { SearchSection } from './SearchSection.tsx'

export { createSettingsBridge } from './bridge.ts'
export type {
  BridgeResult, ModelCatalog, ModelOption, RemoteLike, SaveRequest, SearchSettingsView,
  SettingsBridge, SettingsDescribeValue, SettingsNamespaceView,
} from './bridge.ts'
export { en, NS, zh } from './locales.ts'
export type { SearchLocaleKey } from './locales.ts'
export { SearchSection } from './SearchSection.tsx'
export type { SearchSectionProps } from './SearchSection.tsx'

/** Services required by the browser half. */
export const inject = ['slots', 'locale', 'remote']

/**
 * Register the Prism Search settings section.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prism-search: dictionaries')
  const t = ctx.locale.bind(NS)
  const bridge = createSettingsBridge(Reflect.get(ctx, 'remote') as RemoteLike)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'prism-search',
    order: 40,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({
      load: () => bridge.load(),
      save: (request: SaveRequest) => bridge.save(request),
    }),
  }, SearchSection))
}
