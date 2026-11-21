/**
 * Local widening of the Cordis context for the service claim and optional
 * service reads: the runtime proxy carries `ctx.provide` and `ctx.get`, but
 * this package's pinned cordis declaration omits both.
 */

declare module '@deepseek-ai/cordis' {
  export interface Context {
    /**
     * Claim one service property on this context's scope.
     * @param name - property name (e.g. the plugin's service claim).
     * @param value - the provided service instance.
     */
    provide(name: string, value: unknown): void
    /**
     * Read a service from the store without the inject requirement.
     * @param name - the service name.
     * @returns the service value, or `undefined` when not (yet) provided.
     */
    get(name: string, strict?: boolean): any
  }
}
