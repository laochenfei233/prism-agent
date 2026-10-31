/**
 * Browser half: registers the Models-page footer card and its dictionaries.
 *
 * The card rides the models page's declared `settings.models.footer`
 * extension seat; the section itself is never edited.
 *
 * @module @prism/prism-local-models/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { LocalModelsCard } from './LocalModelsCard.tsx'
import { en, NS, zh } from './locales.ts'

export { NS }
export { fetchCatalog, postCancel, postInstall, postProbe, postRemove, type RouteError } from './api.ts'
export { LocalModelsCard, type LocalModelsCardProps } from './LocalModelsCard.tsx'
export { en, zh, type LocalModelsLocaleKey } from './locales.ts'

/** Services required by the browser half. */
export const inject = ['slots', 'locale']

/**
 * Register the local-models browser surfaces.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'local-models: dictionaries')
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'local-models-card',
    order: 10,
    locale: NS,
  }, LocalModelsCard))
}
