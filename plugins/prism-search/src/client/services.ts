/**
 * The browser half's service requirements, kept in a React-free module so the
 * list can be asserted without loading the settings component. `remote.settings`
 * and `remote.session` are separate Cordis services: `ctx.remote.settings`
 * resolves only when the fiber injects them.
 *
 * @module @prism/prism-search/client/services
 */

/** Services the browser half requires; activation waits for all of them. */
export const inject: string[] = ['slots', 'locale', 'remote', 'remote.settings', 'remote.session']
