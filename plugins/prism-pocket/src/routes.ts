/**
 * Pocket route paths. JSON routes register on the authenticated `/api` channel
 * through `connection.fetch.register`; the static PWA assets register on the
 * webserver directly because the service worker must live at the origin root.
 *
 * @module @prism/prism-pocket
 */

/** Server surface, tailscale facts, and pocket feature state. */
export const POCKET_REMOTE_PATH = '/api/pocket/remote'

/** Store one browser push subscription. */
export const POCKET_PUSH_SUBSCRIBE_PATH = '/api/pocket/push/subscribe'

/** Deliver one test notification through every configured channel. */
export const POCKET_PUSH_TEST_PATH = '/api/pocket/push/test'

/** The web app manifest. */
export const POCKET_MANIFEST_PATH = '/pocket.webmanifest'

/** The service worker, at the origin root so its default scope is `/`. */
export const POCKET_SW_PATH = '/pocket-sw.js'

/** The PWA icon. */
export const POCKET_ICON_PATH = '/pocket-icon.svg'
