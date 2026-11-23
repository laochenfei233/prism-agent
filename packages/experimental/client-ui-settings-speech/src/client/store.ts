/**
 * Page store for the speech settings section: one config form over the speech
 * HTTP plugin's namespace, credential state per service key, and the optional
 * recognizer roster.
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SpeechRosterView, SpeechSettingsOperations } from './operations.ts'

/** Namespace the speech HTTP plugin's config document lives under. */
export const SPEECH_HTTP_NAMESPACE = 'speech-to-text-http'

/** One configured transcription service as the document stores it. */
export interface SpeechServiceConfig {
  readonly providerId?: string
  readonly name?: string
  readonly endpoint?: string
  readonly mode?: string
  readonly model?: string
  readonly apiKeyEnv?: string
  readonly maxAudioBytes?: number
  readonly maxDurationSeconds?: number
}

/** Field edits one service card submits; a `null` model clears the field. */
export interface SpeechServiceEdits {
  readonly name?: string
  readonly endpoint?: string
  readonly model?: string | null
  readonly apiKeyEnv?: string
}

/** Client-sync state of the page. */
export interface SpeechSettingsState {
  /** Whether the host serves the speech HTTP configuration namespace. */
  readonly available: boolean
  /** Configured services in document order. */
  readonly services: readonly SpeechServiceConfig[]
  /** Whether the namespace document accepts writes. */
  readonly writable: boolean
  /** Configured-ness of each service's credential reference. */
  readonly keyConfigured: Readonly<Record<string, boolean>>
  /** Live roster and selection; undefined when this deployment serves no speech remote. */
  readonly roster: SpeechRosterView | undefined
  /** A refusal message from the last write, when one failed. */
  readonly notice: string | undefined
}

/**
 * Store owning the page state; the section renders snapshots and dispatches
 * edits through it, never through a context.
 */
export class SpeechSettingsStore {
  private readonly form: ConfigForm<SpeechHttpSection>
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeForm: () => void
  private state: SpeechSettingsState
  /** One saved configuration value snapshot, to diff key references cheaply. */
  private knownRefs: readonly string[] = []

  /**
   * @param form - the config form over the speech HTTP namespace.
   * @param operations - bound Host callbacks.
   */
  constructor(form: ConfigForm<SpeechHttpSection>, private readonly operations: SpeechSettingsOperations) {
    this.form = form
    this.unsubscribeForm = this.form.subscribe(() => { this.sync(); void this.refreshKeys() })
    this.state = this.collect()
  }

  /** Stop following the config form; pending roster reads keep their last state. */
  dispose(): void {
    this.unsubscribeForm()
    this.listeners.clear()
  }

  /**
   * Read the current page state.
   * @returns the page state, stable between writes.
   */
  getSnapshot(): SpeechSettingsState {
    return this.state
  }

  /**
   * Observe page-state replacements.
   * @param listener - invalidation callback.
   * @returns the disposer removing the listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Reload credential state and the roster from the Host faces. */
  async refresh(): Promise<void> {
    await this.refreshKeys()
    await this.refreshRoster()
  }

  /**
   * Save one service card's edited fields back into the document.
   * @param index - service position in the document list.
   * @param edits - field edits; a `null` model clears the field from the entry.
   */
  async saveService(index: number, edits: SpeechServiceEdits): Promise<void> {
    const services = [...this.state.services]
    const current = services[index]
    if (current === undefined) return
    const { model, ...rest } = edits
    const merged: Record<string, unknown> = { ...current, ...rest }
    if (model === null || model === '') delete merged.model
    services[index] = merged as SpeechServiceConfig
    await this.write(services)
  }

  /** Append one draft service with placeholder fields the card edits next. */
  async addService(): Promise<void> {
    const base = this.state.services
    const suffix = base.some(service => service.providerId === 'new-service')
      ? `-${String(base.length)}`
      : ''
    await this.write([...base, {
      providerId: `new-service${suffix}`,
      name: '',
      endpoint: 'https://',
      mode: 'transcriptions',
      apiKeyEnv: 'NEW_ASR_API_KEY',
    }])
  }

  /**
   * Remove one service from the document; its stored key stays in the
   * credential store until removed explicitly.
   * @param index - service position in the document list.
   */
  async removeService(index: number): Promise<void> {
    const services = [...this.state.services]
    const removed = services.splice(index, 1)[0]
    if (removed === undefined) return
    await this.write(services)
  }

  /**
   * Store one API key under the reference its service names.
   * @param ref - the credential reference the service names.
   * @param value - the API key value.
   * @returns the refusal message, or undefined on success.
   */
  async storeKey(ref: string, value: string): Promise<string | undefined> {
    const refusal = await this.operations.storeKey(ref, value)
    await this.refreshKeys()
    return refusal
  }

  /**
   * Remove one stored API key.
   * @param ref - the credential reference to clear.
   * @returns the refusal message, or undefined on success.
   */
  async removeKey(ref: string): Promise<string | undefined> {
    const refusal = await this.operations.removeKey(ref)
    await this.refreshKeys()
    return refusal
  }

  /**
   * Switch the default recognizer to one roster entry.
   * @param providerId - the roster id to select.
   * @returns the refusal message, or undefined on success.
   */
  async selectProvider(providerId: string): Promise<string | undefined> {
    return await this.operations.configure(providerId)
  }

  private collect(): SpeechSettingsState {
    const snapshot = this.form.getSnapshot()
    const services = Array.isArray(snapshot.value?.services) ? snapshot.value.services : []
    this.knownRefs = services.map(service => service.apiKeyEnv).filter((ref): ref is string => ref !== undefined && ref.length > 0)
    return {
      available: snapshot.status === 'ready',
      services,
      writable: snapshot.writable,
      keyConfigured: {},
      roster: undefined,
      notice: undefined,
    }
  }

  private sync(): void {
    this.state = this.collect()
    this.changed()
  }

  private async write(services: readonly SpeechServiceConfig[]): Promise<void> {
    // The service list is one plain JSON array on the settings wire.
    const accepted = await this.form.mutate([{ op: 'set', path: ['services'], value: [...services] as JsonValue }])
    this.state = { ...this.state, notice: accepted ? undefined : 'refused' }
    this.changed()
  }

  private async refreshKeys(): Promise<void> {
    const refs = this.knownRefs
    if (refs.length === 0) {
      if (Object.keys(this.state.keyConfigured).length > 0) this.state = { ...this.state, keyConfigured: {} }
      return
    }
    const configured = await this.operations.describeKeys(refs)
    this.state = { ...this.state, keyConfigured: configured }
    this.changed()
  }

  private async refreshRoster(): Promise<void> {
    const roster = await this.operations.roster()
    this.state = { ...this.state, roster }
    this.changed()
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

/** The speech HTTP plugin's configuration document shape. */
export interface SpeechHttpSection {
  readonly services?: readonly SpeechServiceConfig[]
}
