/**
 * Host operations of the speech settings page: credential reads and writes,
 * and the optional speech remote face for the recognizer roster and the
 * default-selection write.
 */

// Type-only: pulls the ctx.remote merge and the speech namespace into it.
import type {} from '@deepseek-ai/dsh-experimental-api-speech-to-text/remote'
// Type-only: the ctx.remote merge carrying the speech namespace type.
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** One recognizer of the live roster, as the page renders it. */
export interface SpeechRosterEntry {
  readonly id: string
  readonly name: string
  readonly phase: string
  readonly languages: readonly string[]
}

/** One roster observation with the persisted selection. */
export interface SpeechRosterView {
  readonly providers: readonly SpeechRosterEntry[]
  readonly selected: string
  readonly language: string
}

/** Host callbacks the store and cards receive; errors are operator-readable strings. */
export interface SpeechSettingsOperations {
  /** @returns configured-ness of every named credential reference. */
  readonly describeKeys: (refs: readonly string[]) => Promise<Record<string, boolean>>
  /** Store one key under its reference. @returns the refusal message, or undefined on success. */
  readonly storeKey: (ref: string, value: string) => Promise<string | undefined>
  /** Remove one stored key. @returns the refusal message, or undefined on success. */
  readonly removeKey: (ref: string) => Promise<string | undefined>
  /** @returns the roster and selection; undefined when this deployment serves no speech remote. */
  readonly roster: () => Promise<SpeechRosterView | undefined>
  /** Switch the default recognizer. @returns the refusal message, or undefined on success. */
  readonly configure: (providerId: string) => Promise<string | undefined>
}

/**
 * Bind the page's Host operations to the Remote namespaces this plugin's
 * inject declares; the optional speech remote is read through the service
 * store, so a deployment without the voice bundle keeps the page usable.
 * @param ctx - the page plugin's context.
 * @returns the callbacks the section and its cards are injected with.
 */
export function createSpeechOperations(ctx: ClientContext): SpeechSettingsOperations {
  const speech = (): ClientRemote['speech'] | undefined => ctx.get('remote.speech') as ClientRemote['speech'] | undefined
  return {
    describeKeys: async refs => {
      if (refs.length === 0) return {}
      const response = await ctx.remote.credentials.describe([...refs])
      if (!response.ok) return {}
      return Object.fromEntries(Object.entries(response.value).map(([ref, info]) => [ref, info.configured]))
    },
    storeKey: async (ref, value) => {
      const response = await ctx.remote.credentials.set(ref, value)
      return response.ok ? undefined : response.error.message
    },
    removeKey: async ref => {
      const response = await ctx.remote.credentials.unset(ref)
      return response.ok ? undefined : response.error.message
    },
    roster: async () => {
      const remote = speech()
      if (remote === undefined) return undefined
      const response = await remote.catalog()
      if (!response.ok) return undefined
      const catalog = response.value
      return {
        providers: catalog.providers.map(provider => ({
          id: provider.id, name: provider.name, phase: provider.preparation.phase, languages: provider.languages,
        })),
        selected: catalog.selection.providerId,
        language: catalog.selection.language,
      }
    },
    configure: async providerId => {
      const remote = speech()
      if (remote === undefined) return 'speech registry unavailable'
      const response = await remote.configure({ providerId: brandString<SpeechProviderId>(providerId) })
      return response.ok ? undefined : response.error.message
    },
  }
}
