/** Named transcription providers with disposable registration and explicit routing. */
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: the `settings` service that persists `configure()` into this plugin's profile entry, and the Loader's
// entry and `loader/volatile-update` merges.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { SpeechPreparationOptions, SpeechProvider, SpeechProviderId, SpeechProviderInfo, SpeechSnapshot, SpeechSelectionPatch, SpeechRequest, SpeechSpec, SpeechStream, SpeechStreamRequest, SpeechStreamSpec, Transcript } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experimental speech recognition provider registry. */
    speechToText: SpeechToText
  }
}

/** Live selection read before a transcription starts; `configure()` writes it through the profile. */
export interface Config {
  /** Registered provider selected when the caller omits an id. */
  defaultProvider: Volatile<string>
  /** Provider language hint selected when the caller omits one. */
  language: Volatile<string>
  /** Model the selection runs; the empty string leaves the selected recognizer's own default. */
  model: Volatile<string>
}

interface Registration {
  readonly provider: SpeechProvider
  readonly lifetime: AbortController
  readonly pending: Set<Promise<Transcript>>
  readonly sessions: Set<SpeechStream>
  readonly unsubscribe: () => void
}

/** Registry shared by all transcription consumers in one Host composition. */
export default class SpeechToText extends Service {
  static Config = z.object({
    defaultProvider: z.string().min(1).required().volatile(),
    language: z.string().min(1).default('auto').volatile(),
    model: z.string().default('').volatile(),
  })

  private readonly providers = new Map<SpeechProviderId, Registration>()
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  /** Profile-local entry id used by Settings; absent when the plugin was mounted without Loader. */
  private readonly entryId: string | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'speechToText')
    this.entryId = ctx.fiber.entry?.options.id
    ctx.on('loader/volatile-update', () => { this.changed() })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Speech service disposed'))
      await Promise.all([...this.providers.values()].map(registration => this.remove(registration)))
      this.listeners.clear()
    })
  }

  /**
   * Register one recognizer; duplicate ids fail without replacing the original.
   * @param provider - recognizer owned by the contributing fiber.
   * @returns idempotent disposer which rejects admission, cancels, and joins accepted work.
   */
  register(provider: SpeechProvider): () => Promise<void> {
    this.lifetime.signal.throwIfAborted()
    if (this.providers.has(provider.info.id)) throw new Error(`Speech provider already registered: ${provider.info.id}`)
    const registration: Registration = { provider, lifetime: new AbortController(), pending: new Set(), sessions: new Set(),
      unsubscribe: provider.preparation?.subscribe(() => { this.changed() }) ?? (() => {}) }
    this.providers.set(provider.info.id, registration)
    this.changed()
    return async () => { await this.remove(registration) }
  }

  private async remove(registration: Registration): Promise<void> {
    if (this.providers.get(registration.provider.info.id) !== registration) return
    this.providers.delete(registration.provider.info.id)
    registration.unsubscribe()
    this.changed()
    registration.lifetime.abort(new Error('Speech provider unloaded'))
    await Promise.allSettled([...registration.sessions].map(session => session.cancel()))
    registration.sessions.clear()
    await Promise.allSettled(registration.pending)
  }

  /**
   * Read the current recognizer roster.
   * @returns available provider facts in registration order.
   */
  listProviders(): readonly SpeechProviderInfo[] {
    return [...this.providers.values()].map(({ provider }) => provider.info)
  }

  private changed(): void { for (const listener of this.listeners) listener() }

  /**
   * Observe complete readiness snapshots; a slow reader coalesces intermediate progress.
   * @param caller - observer lifetime, independent of any preparation task.
   * @returns an initial snapshot followed by the latest provider states.
   */
  async *follow(caller: AbortSignal): AsyncIterable<SpeechSnapshot> {
    const signal = AbortSignal.any([caller, this.lifetime.signal])
    signal.throwIfAborted()
    let wake = Promise.withResolvers<undefined>()
    let changed = true
    const aborted = (): boolean => signal.aborted
    const notify = (): void => { changed = true; wake.resolve(undefined) }
    this.listeners.add(notify)
    signal.addEventListener('abort', notify, { once: true })
    try {
      while (!aborted()) {
        if (!changed) await wake.promise
        if (aborted()) break
        wake = Promise.withResolvers<undefined>(); changed = false
        yield this.snapshot()
      }
    } finally {
      this.listeners.delete(notify)
      signal.removeEventListener('abort', notify)
    }
  }

  /**
   * Read provider readiness and current user preferences together.
   * @returns one detached complete observation.
   */
  snapshot(): SpeechSnapshot {
    const model = this.config.model.get()
    return { providers: [...this.providers.values()].map(({ provider }) => ({ ...provider.info,
      preparation: provider.preparation?.snapshot() ?? { phase: 'ready' },
      ...provider.streaming === undefined ? {} : { streaming: provider.streaming.mode },
    })), selection: { providerId: this.config.defaultProvider.get() as SpeechProviderId,
      language: this.config.language.get(), ...model === '' ? {} : { model } } }
  }

  /**
   * Persist changed selection fields into this plugin's profile entry; the resulting language must be accepted by the selected provider.
   * @param patch - explicit provider or language changes.
   * @returns after the profile write and the live update it applies.
   */
  async configure(patch: SpeechSelectionPatch): Promise<void> {
    const settings = this.ctx.get('settings')
    const entry = this.entryId
    if (settings === undefined || entry === undefined) throw new Error('Speech selection requires the settings service and a profile entry')
    const previous = this.config.defaultProvider.get()
    const id = patch.providerId ?? previous as SpeechProviderId
    // Naming a different recognizer without a model selects that recognizer's own
    // default, because the previous model belongs to the recognizer being left.
    const switching = patch.providerId !== undefined && patch.providerId !== previous
    const model = patch.model ?? (switching ? '' : this.config.model.get())
    this.selectedProvider(id, patch.language ?? this.config.language.get(), model)
    await settings.update(entry, { ...patch.providerId === undefined ? {} : { defaultProvider: patch.providerId },
      ...patch.language === undefined ? {} : { language: patch.language },
      // A stored model the resulting selection cannot run is replaced, never left behind.
      ...model === this.config.model.get() ? {} : { model } })
  }

  private selectedProvider(id: SpeechProviderId, language: string, model: string): SpeechProvider {
    const registration = this.providers.get(id)
    if (!registration) throw new Error(`Speech provider is unavailable: ${id}`)
    if (!registration.provider.info.languages.includes(language)) {
      throw new Error(`Speech provider ${id} does not support language: ${language}`)
    }
    if (model !== '' && registration.provider.info.models?.includes(model) !== true) {
      throw new Error(`Speech provider ${id} does not offer model: ${model}`)
    }
    return registration.provider
  }

  /**
   * Start or join provider-owned preparation.
   * @param id - exact registered provider identity.
   * @param options - task-local source selection validated by the provider.
   */
  prepare(id: SpeechProviderId, options?: SpeechPreparationOptions): void {
    const registration = this.providers.get(id)
    if (!registration) throw new Error(`Speech provider is unavailable: ${id}`)
    registration.provider.preparation?.prepare(options)
  }

  /**
   * Explicitly cancel provider preparation without tying it to a browser connection.
   * @param id - exact registered provider identity.
   * @returns after the preparation task settles.
   */
  async cancelPreparation(id: SpeechProviderId): Promise<void> {
    const registration = this.providers.get(id)
    if (!registration) throw new Error(`Speech provider is unavailable: ${id}`)
    await registration.provider.preparation?.cancel()
  }

  /**
   * Apply composition defaults and capture the selected provider. Missing providers and unsupported languages fail explicitly.
   * @param request - complete recording and optional selection.
   * @returns provider-pinned input for transcribe().
   */
  resolve(request: SpeechRequest): SpeechSpec {
    const id = request.providerId ?? this.config.defaultProvider.get() as SpeechProviderId
    const language = request.language ?? this.config.language.get()
    const model = request.model ?? this.config.model.get()
    return { provider: this.selectedProvider(id, language, model), audio: request.audio, language,
      ...model === '' ? {} : { model } }
  }

  /**
   * Execute exactly the resolved provider; no fallback sends audio elsewhere.
   * @param spec - resolved input; a withdrawn or replaced registration is rejected.
   * @param signal - caller cancellation.
   * @returns final transcript after provider settlement.
   */
  async transcribe(spec: SpeechSpec, signal: AbortSignal): Promise<Transcript> {
    signal.throwIfAborted()
    const registration = this.providers.get(spec.provider.info.id)
    if (registration?.provider !== spec.provider) throw new Error('Resolved speech provider is no longer registered')
    const combined = AbortSignal.any([signal, registration.lifetime.signal])
    const pending = Promise.resolve().then(() => {
      combined.throwIfAborted()
      return spec.provider.transcribe({ audio: spec.audio, language: spec.language,
        ...spec.model === undefined ? {} : { model: spec.model } }, combined)
    })
    registration.pending.add(pending)
    try {
      const result = await pending
      combined.throwIfAborted()
      return result
    } finally {
      registration.pending.delete(pending)
    }
  }

  /**
   * Apply composition defaults and capture the selected provider's live capability.
   * @param request - optional provider and language selection.
   * @returns provider-pinned input for openStream().
   * @throws {Error} The selected provider offers no live session.
   */
  resolveStream(request: SpeechStreamRequest): SpeechStreamSpec {
    const id = request.providerId ?? this.config.defaultProvider.get() as SpeechProviderId
    const language = request.language ?? this.config.language.get()
    const model = request.model ?? this.config.model.get()
    const provider = this.selectedProvider(id, language, model)
    if (provider.streaming === undefined) throw new Error(`Speech provider offers no live session: ${id}`)
    return { provider, streaming: provider.streaming, language, ...model === '' ? {} : { model } }
  }

  /**
   * Open one live session on exactly the resolved provider; withdrawing the registration cancels it.
   * @param spec - resolved selection; a withdrawn or replaced registration is rejected.
   * @param signal - caller cancellation.
   * @returns the open session, tracked until it closes, cancels, or the registration withdraws.
   */
  async openStream(spec: SpeechStreamSpec, signal: AbortSignal): Promise<SpeechStream> {
    signal.throwIfAborted()
    const registration = this.providers.get(spec.provider.info.id)
    if (registration?.provider !== spec.provider) throw new Error('Resolved speech provider is no longer registered')
    const combined = AbortSignal.any([signal, registration.lifetime.signal])
    const session = await spec.streaming.open({ language: spec.language,
      ...spec.model === undefined ? {} : { model: spec.model } }, combined)
    registration.sessions.add(session)
    const settled = async (end: () => Promise<void>): Promise<void> => {
      registration.sessions.delete(session)
      await end()
    }
    return {
      push: chunk => session.push(chunk),
      close: () => settled(() => session.close()),
      cancel: () => settled(() => session.cancel()),
      events: observer => session.events(observer),
    }
  }
}
