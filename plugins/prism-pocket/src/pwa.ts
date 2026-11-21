/**
 * PWA static assets: manifest, service worker, and icon.
 *
 * These register directly on the webserver — not on the authenticated `/api`
 * channel — because the service worker must live at the origin root and the
 * manifest carries no secrets. The bodies ship as literals so the published
 * package needs no extra asset files.
 *
 * @module @prism/prism-pocket/pwa
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { POCKET_ICON_PATH, POCKET_MANIFEST_PATH, POCKET_SW_PATH } from './routes.ts'

/** Structural shape of the webserver service this plugin registers into. */
export interface WebServerLike {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

/** The web app manifest. */
export const POCKET_MANIFEST = JSON.stringify({
  name: 'Prism',
  short_name: 'Prism',
  description: 'Prism agent, in your pocket',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0b0e14',
  theme_color: '#0b0e14',
  icons: [{ src: POCKET_ICON_PATH, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
})

/** The service worker: push → notification, click → focus or open. */
export const POCKET_SW_SOURCE = `
self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()) })
self.addEventListener('push', event => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = {} }
  const zh = ((self.navigator && self.navigator.language) || 'en').toLowerCase().startsWith('zh')
  const titles = {
    approval: zh ? '需要批准' : 'Approval needed',
    question: zh ? 'Prism 提问' : 'Question',
    'turn-end': zh ? '回合完成' : 'Turn complete',
    error: zh ? '运行失败' : 'Run failed',
  }
  const bodies = {
    approval: zh ? 'Prism 在等待一个决定' : 'Prism is waiting for a decision',
    question: zh ? 'Prism 提出了一个问题' : 'Prism asked a question',
    'turn-end': zh ? '一个 Prism 回合已结束' : 'A Prism turn finished',
    error: zh ? '一个 Prism 回合失败了' : 'A Prism turn failed',
  }
  const kind = titles[data.kind] !== undefined ? data.kind : 'turn-end'
  const title = titles[kind]
  const body = [data.detail, data.sessionTitle].filter(Boolean).join(' · ') || bodies[kind]
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: ['prism', kind, data.sessionId || ''].join(':'),
    data,
  }))
})
self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if ('focus' in client) return client.focus()
    }
    return self.clients.openWindow('/')
  }))
})
`

/** The PWA icon: a beam refracting through a prism. */
export const POCKET_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0b0e14"/>
  <path d="M32 12 L52 46 H12 Z" fill="none" stroke="#7aa2f7" stroke-width="3" stroke-linejoin="round"/>
  <path d="M8 24 H26" stroke="#e0af68" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M38 24 H56" stroke="#f7768e" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M38 33 H50" stroke="#9ece6a" stroke-width="2.5" stroke-linecap="round"/>
</svg>
`

/**
 * Register the three static asset routes.
 * @param ctx - host context; registration rides `ctx.effect`.
 * @param webserver - the webserver service.
 */
export function registerPwaAssets(ctx: Context, webserver: WebServerLike): void {
  ctx.effect(() => webserver.register(exact(POCKET_MANIFEST_PATH, POCKET_MANIFEST, 'application/manifest+json')), 'pocket: manifest')
  ctx.effect(() => webserver.register(exact(POCKET_SW_PATH, POCKET_SW_SOURCE, 'text/javascript')), 'pocket: service worker')
  ctx.effect(() => webserver.register(exact(POCKET_ICON_PATH, POCKET_ICON_SVG, 'image/svg+xml')), 'pocket: icon')
}

/** One exact-path static handler with no-cache semantics. */
function exact(path: string, body: string, contentType: string): { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void } {
  return {
    kind: 'exact',
    path,
    handler: (_req, res) => {
      res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8`, 'Cache-Control': 'no-cache' })
      res.end(body)
    },
  }
}
