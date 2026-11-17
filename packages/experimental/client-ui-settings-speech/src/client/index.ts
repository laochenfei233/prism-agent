/**
 * Speech recognition settings, browser half: the 语音识别 navigation entry with
 * the default-recognizer switcher and one editable card per configured HTTP
 * transcription service. The service document belongs to the speech-to-text-http
 * plugin's settings namespace; keys ride the credential store.
 *
 * @module @deepseek-ai/dsh-experimental-client-ui-settings-speech/client
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ctx.remote speech namespace merge into this program.
import type {} from '@deepseek-ai/dsh-experimental-api-speech-to-text/remote'
// Type-only: pulls the ctx.configForms merge and the settings.section SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.slots merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { SpeechSection } from './SpeechSection.tsx'
import { createSpeechOperations } from './operations.ts'
import { SpeechSettingsStore, SPEECH_HTTP_NAMESPACE, type SpeechHttpSection } from './store.ts'
import { en, zh, type SpeechLocaleKey } from './locales.ts'

export type { SpeechSectionInjected, SpeechSectionProps } from './SpeechSection.tsx'
export type { SpeechLocaleKey } from './locales.ts'
export type { SpeechRosterEntry, SpeechRosterView, SpeechSettingsOperations } from './operations.ts'
export { SPEECH_HTTP_NAMESPACE, SpeechSettingsStore, type SpeechServiceConfig, type SpeechSettingsState } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Speech settings page copy. */
    'settings.speech': SpeechLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.speech'

/** Services required by the browser half; the speech remote stays optional. */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'remote.settings', 'configForms']

/**
 * Register the speech section while the Host serves the speech HTTP plugin's
 * namespace, and keep credential and settings invalidations fresh.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-speech: dictionaries')
  const t = ctx.locale.bind(NS)
  const operations = createSpeechOperations(ctx)
  const store = new SpeechSettingsStore(ctx.configForms.get<SpeechHttpSection>(SPEECH_HTTP_NAMESPACE), operations)
  ctx.effect(() => ctx.configForms.whileServed([SPEECH_HTTP_NAMESPACE], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'speech',
    order: 11,
    locale: NS,
    label: () => t('nav'),
    inject: () => ({ store }),
  }, SpeechSection))), 'ui-settings-speech: section while served')
  ctx.effect(() => {
    const refresh = (): void => { void store.refresh() }
    const disposers = [
      ctx.remote.$on('settings/document-updated', refresh),
      ctx.remote.$on('credentials/record-updated', refresh),
      ctx.remote.$on('credentials/reference-updated', refresh),
      ctx.on('connection/reset', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-settings-speech: pushed invalidations')
}
