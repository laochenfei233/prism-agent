/**
 * Browser half of `@prism/prism-memory`: the memory glyph in the sidebar's panel
 * rail and the page it opens.
 *
 * The page reads and writes only through this plugin's own routes, so it shows
 * the store the Host service owns rather than a second copy of it.
 *
 * @module @prism/prism-memory/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createMemoryApi } from './api.ts'
import { en, NS, zh } from './locales.ts'
import { MemoryPanel } from './MemoryPanel.tsx'
import { MemoryPanelIcon } from './MemoryPanelIcon.tsx'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'memory'

/** Services the two registrations need. */
export const inject = ['slots', 'locale']

/**
 * Contribute the memory entry to the sidebar and the page it opens.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prism-memory: dictionaries')
  const t = ctx.locale.bind(NS)
  const face = createMemoryApi()
  // The sidebar owns the button, the label, and the selection; this entry
  // supplies the glyph only, and selecting the panel is the sidebar's own call.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    locale: NS,
    label: () => t('panel'),
  }, MemoryPanelIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => face,
  }, MemoryPanel))
}
