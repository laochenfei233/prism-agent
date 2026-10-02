/**
 * Local stand-ins for the two baseline modules this bundle requires but does
 * not own. Types only: the browser resolves both through the shell's module
 * table at runtime, and this package ships no declaration for either.
 */

declare module '@deepseek-ai/cordis' {
  /** The plugin-context slice this bundle uses. */
  export interface Context {
    /**
     * Register a disposable contribution for the caller's lifetime.
     * @param callback - contribution body returning its disposer.
     * @param label - diagnostic label.
     */
    effect(callback: () => undefined | (() => void), label?: string): void
    slots: {
      /**
       * Wait for a slot declaration, then register into it.
       * @param name - slot name.
       * @param callback - registration body.
       */
      inject(name: string, callback: () => unknown): void
      /**
       * Register one entry.
       * @param options - entry identity, store, locale namespace, and inject face.
       * @param component - the entry component.
       * @returns the registration disposer.
       */
      register(options: SlotRegistrationOptions, component: unknown): () => void
    }
    locale: {
      /**
       * Register one namespace's dictionaries.
       * @param namespace - namespace key.
       * @param dictionaries - locale code to key/value dictionary.
       * @returns the unregister function.
       */
      register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
      /**
       * Bind a translator for one namespace.
       * @param namespace - namespace key.
       * @returns the bound translator.
       */
      bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
    }
    sessions: {
      /** Refresh the Host-authoritative session list. */
      refresh(): Promise<void>
    }
    uiWorkspace: {
      /**
       * Open a Session in the main view.
       * @param target - session identity.
       */
      openSession(target: string): void
    }
  }
}

/** Registration options this bundle writes. */
interface SlotRegistrationOptions {
  readonly name: string
  /** Identity for `list`/`single` slots, or the addressed key for a `keyed` slot. */
  readonly id?: string
  readonly key?: string
  readonly locale?: string
  readonly order?: number
  readonly label?: () => string
  readonly inject?: (actions: Record<string, (...args: never[]) => void>) => unknown
}

declare module '@deepseek-ai/dsh-client-store' {
  /** Selector hook over one snapshot source. */
  export type SnapshotSelectorHook<T> = <S>(selector: (snapshot: T) => S) => S
}
