/**
 * Built-in copy for the renderer's crash face. The top-level failure boundary
 * cannot consult the locale service: a render failure may be caused by that
 * service or by the plugin that provides it, and the surface must draw without
 * any plugin dependency. The boot kernel keeps its failure copy
 * self-contained for the same reason, so this dictionary is deliberately
 * English-only.
 * @module @deepseek-ai/dsh-client-ui-renderer/client/locales
 */

/** Copy rendered by the top-level render-failure surface. */
export interface RenderFailureCopy {
  /** Heading naming the failed surface. */
  readonly title: string
  /** One sentence explaining the recovery action. */
  readonly detail: string
  /** Reload action label. */
  readonly reload: string
  /** Disclosure label for the raw error text. */
  readonly details: string
}

/** Self-contained English copy; see the module note for why it is not localized. */
export const RENDER_FAILURE_COPY: RenderFailureCopy = {
  title: 'The interface failed to render',
  detail: 'An unexpected error interrupted the application. Reload to try again.',
  reload: 'Reload',
  details: 'Error details',
}
