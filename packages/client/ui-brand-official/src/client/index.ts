/** Official Prism Agent occupants for the generic browser-brand slots. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { BrandKey } from './locales.ts'
import { OfficialBrandMark, OfficialBrandName } from './Brand.tsx'
import { en, zh } from './locales.ts'

/** Namespace owning the official wordmark's product name. */
export const BRAND_NS = 'brand'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The official brand wordmark's copy. */
    brand: BrandKey
  }
}

/** Required services: the UI slot registry and the dictionary registry. */
export const inject = ['slots', 'locale']

/**
 * Fill the sidebar brand slots as one declaration-aware registration set. The
 * conversation hero stays on its declaring package's Prism fallback, so the
 * official build registers nothing there.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return
  ctx.effect(() => ctx.locale.register(BRAND_NS, { zh, en }), 'ui-brand-official: brand dictionary')
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, OfficialBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', locale: BRAND_NS }, OfficialBrandName)
    }))
}
