/**
 * Page-open notifications: in-page cards on a plugin-owned portal plus a
 * system Notification while the page is hidden.
 *
 * The triggers are the same answerer waterfalls the shipped approval and
 * question panels listen on; this module only observes (every handler
 * delegates through `next()`), so it can never claim a request. Fire-and-edit
 * failures stay silent — the host push channel covers delivery.
 *
 * @module @prism/prism-pocket/client/notify
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.remote Context merge and its waterfall subscriptions.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the 'approval/request' payload merge.
import type {} from '@deepseek-ai/dsh-user-approval'
// Type-only: the 'user-questions/request' payload merge.
import type {} from '@deepseek-ai/dsh-user-questions'
import type { PocketLocaleKey } from './locales.ts'

/** Bound translator for the card copy. */
export type Translate = (key: PocketLocaleKey) => string

/** Install the portal and the two waterfall observers; returns the disposer. */
export function installNotify(ctx: Context, t: Translate): () => void {
  const portal = document.createElement('div')
  portal.className = 'prism-cards'
  portal.setAttribute('role', 'status')
  document.body.append(portal)

  const system = (titleKey: PocketLocaleKey, detail: string): void => {
    if (!document.hidden || typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    try {
      const notification = new Notification(t(titleKey), {
        body: detail,
        tag: `prism-pocket:${titleKey}`,
      })
      notification.addEventListener('click', () => { window.focus(); notification.close() })
    } catch {
      // Notification construction can throw under restrictive settings; the
      // in-page card above is already showing the same fact.
    }
  }

  const card = (titleKey: PocketLocaleKey, detail: string): void => {
    const element = document.createElement('div')
    element.className = 'prism-card'
    const title = document.createElement('span')
    title.className = 'prism-card-title'
    title.textContent = t(titleKey)
    const text = document.createElement('span')
    text.className = 'prism-card-detail'
    text.textContent = detail
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.textContent = t('card.dismiss')
    dismiss.addEventListener('click', () => { element.remove() })
    element.append(title, text, dismiss)
    portal.append(element)
    window.setTimeout(() => { element.remove() }, 8000)
  }

  const announce = (titleKey: PocketLocaleKey, detail: string): void => {
    card(titleKey, detail)
    system(titleKey, detail)
  }

  const offApproval = ctx.remote.$on('approval/request', function (_request, next) {
    announce('card.approval', _request.toolName ?? '')
    return next()
  })
  const offQuestion = ctx.remote.$on('user-questions/request', function (request, next) {
    announce('card.question', request.questions[0]?.question ?? '')
    return next()
  })

  return () => {
    offApproval()
    offQuestion()
    portal.remove()
  }
}
