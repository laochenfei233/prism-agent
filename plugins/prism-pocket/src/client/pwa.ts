/**
 * PWA install: manifest link, theme color, icon, service worker, and the
 * push subscription flow for this device.
 *
 * All tags are injected at runtime — the plugin never edits the served HTML.
 * The service worker registers on every surface (it is inert until a push
 * arrives); the subscription flow asks for notification permission first.
 *
 * @module @prism/prism-pocket/client/pwa
 */

import { applicationServerKeyBytes } from './pure.ts'

/** Install the manifest/theme/icon tags and register the service worker. */
export function installPwa(): void {
  if (document.querySelector('link[rel="manifest"][data-plugin="prism-pocket"]') !== null) return
  const manifest = document.createElement('link')
  manifest.rel = 'manifest'
  manifest.dataset.plugin = 'prism-pocket'
  manifest.href = '/pocket.webmanifest'
  document.head.append(manifest)

  const theme = document.createElement('meta')
  theme.name = 'theme-color'
  theme.dataset.plugin = 'prism-pocket'
  theme.content = '#0b0e14'
  document.head.append(theme)

  const icon = document.createElement('link')
  icon.rel = 'apple-touch-icon'
  icon.dataset.plugin = 'prism-pocket'
  icon.href = '/pocket-icon.svg'
  document.head.append(icon)

  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/pocket-sw.js').catch(() => {
      // Registration fails on insecure origins; the status page explains the
      // Tailscale paths that provide HTTPS.
    })
  }
}

/** Where the subscription flow ended. */
export type SubscribeOutcome = 'subscribed' | 'denied' | 'unsupported'

/**
 * Ask this device to subscribe to push.
 * @param vapidPublicKey - the application server key from the status route.
 * @param postSubscribe - the authenticated subscribe call.
 */
export async function subscribeThisDevice(
  vapidPublicKey: string,
  postSubscribe: (subscription: unknown) => Promise<void>,
): Promise<SubscribeOutcome> {
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'unsupported'
  }
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'
  const registration = await navigator.serviceWorker.ready
  const existing = await registration.pushManager.getSubscription()
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKeyBytes(vapidPublicKey),
  })
  await postSubscribe(subscription.toJSON())
  return 'subscribed'
}

/** Run the browser's own install prompt when it has offered one. */
export async function promptInstall(event: Event): Promise<boolean> {
  const prompt = event as Event & { prompt?: () => Promise<void> }
  if (typeof prompt.prompt !== 'function') return false
  await prompt.prompt()
  return true
}
