/**
 * Browser half: registers the About settings section and its dictionaries.
 *
 * The section reads the shell-injected update carrier; it needs no Host
 * service or RPC surface of its own.
 *
 * @module prism-about/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { IconInfoOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { AboutSection } from './AboutSection.tsx'
import { en, NS, zh } from './locales.ts'

export type { AboutSectionProps } from './AboutSection.tsx'
export { NS }
export { deriveButtonState, readCarrier } from './about-bridge.ts'
export type { AboutUpdateState, ButtonState, DesktopUpdateCarrier, UpdateFailureKind, UpdatePhase } from './about-bridge.ts'

/** Services required by the browser half. */
export const inject = ['slots', 'locale']

/** Nav glyph for the About section; the shell keeps its gear fallback without this seat. */
function AboutNavIcon({ size }: { size: number; active: boolean }) {
  return <IconInfoOutlineMedium size={size} />
}

/**
 * Register the About page.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prism-about: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'about',
    order: 95,
    label: () => t('nav'),
    locale: NS,
  }, AboutSection))
  ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
    name: 'settings.section.icon',
    id: 'about',
    locale: NS,
  }, AboutNavIcon))
}
