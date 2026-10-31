/**
 * Browser half: registers the transfer settings section and its dictionaries.
 * The section calls the Host transfer routes directly and needs no Remote
 * namespace of its own.
 *
 * @module @prism/prism-transfer/client
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the settings.section SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.workspaces merge.
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: the ctx.remote merge that carries remote.directoryPicker.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
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
 * Register the transfer section once the shell's settings slot is declared.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prism-transfer: dictionaries')
  const t = ctx.locale.bind(NS)
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
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'transfer',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: () => face,
  }, TransferSection))
}
