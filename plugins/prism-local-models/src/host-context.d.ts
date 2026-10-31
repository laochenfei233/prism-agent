/**
 * Local widening of the Cordis context for the service claim: the runtime
 * proxy carries `ctx.provide`, but this package's pinned cordis declaration
 * omits it.
 */

declare module '@deepseek-ai/cordis' {
  export interface Context {
    /**
     * Claim one service property on this context's scope.
     * @param name - property name (e.g. the plugin's service claim).
     * @param value - the provided service instance.
     */
    provide(name: string, value: unknown): void
  }
}
