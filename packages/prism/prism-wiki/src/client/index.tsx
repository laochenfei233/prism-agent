/**
 * Browser half of `@prism/prism-wiki`: the Knowledge entry in the sidebar
 * panel rail, the keyed main panel it opens, and the frame-wide host for the
 * page's transient notices. Every operation reaches the host through this
 * plugin's own routes under `/api`, so the page reads and writes the same vault
 * the wiki tools maintain rather than a second copy of it.
 * @module @prism/prism-wiki/src/client
 */

import type { ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the root `main` keyed slot plus the `sidebar.panellist` list this
// package registers into, and the ctx.slots / ctx.locale merges.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createWikiApi } from './api.ts'
import { en, zh, type WikiLocaleKey } from './locales.ts'
import { WikiPage, type WikiNotice, type WikiPageFace } from './WikiPage.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Knowledge page copy. */
    wikiVault: WikiLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'wikiVault'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'wiki-vault' as MainPanelId

/** Services the three registrations need. */
export const inject = ['slots', 'locale']

/** Full-opacity hold for a notice that has a reason to read. */
const NOTICE_HOLD_MS = 6000

/** Registrant-private reactive fact: the notice the frame-wide host renders. */
interface NoticeSource extends HostObservable<WikiNotice | null> {
  /** Publish the next notice, or none. */
  set(notice: WikiNotice | null): void
}

/**
 * Create the notice source the page writes and the overlay host reads.
 * @returns a snapshot source carrying its own publisher.
 */
function createNoticeSource(): NoticeSource {
  let current: WikiNotice | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (notice) => {
      current = notice
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Notice capabilities the frame-wide host's inject face provides. */
interface WikiNoticeFace {
  hooks: { notice: HostObservable<WikiNotice | null> }
  /** Take the notice down. */
  dismissNotice: () => void
}

/** Props of the frame-wide notice host. */
type WikiNoticeHostProps = PropsRuntime<'shell.overlay'> & InjectFace<WikiNoticeFace>

/**
 * Render the Knowledge glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns the icon element.
 */
function WikiPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 4.4C7.15 3.7 6 3.4 3.6 3.4v8.6c2.4 0 3.55.3 4.4 1 .85-.7 2-1 4.4-1V3.4C10 3.4 8.85 3.7 8 4.4Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8 4.4v8.6" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/**
 * Render the notice on display in the frame-wide layer, which outlives the
 * page that reported it.
 * @param props - the notice source bound to a selector hook, and its dismissal.
 * @returns the banner on display, or null.
 */
function WikiNoticeHost({ useNotice, dismissNotice }: WikiNoticeHostProps): ReactNode {
  const notice = useNotice(current => current)
  if (notice === null) return null
  if (notice.tone === 'success') {
    return <Toast key={notice.seq} text={notice.text} tone="success" onDone={dismissNotice} />
  }
  return (
    <Toast
      key={notice.seq}
      text={notice.text}
      icon={<IconWarningOutlineRegular />}
      holdMs={NOTICE_HOLD_MS}
      onDone={dismissNotice}
    />
  )
}

/**
 * Contribute the Knowledge entry to the sidebar, the page it opens, and the
 * notice host the page reports through.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prism-wiki: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = createWikiApi()
  const notice = createNoticeSource()
  let noticeSeq = 0
  const face: WikiPageFace = {
    list: signal => api.list(signal),
    read: (path, signal) => api.read({ path }, signal),
    search: (request, signal) => api.search(request, signal),
    save: (request, signal) => api.save(request, signal),
    source: (request, signal) => api.source(request, signal),
    lint: signal => api.lint(signal),
    notify: (text, tone) => {
      noticeSeq += 1
      notice.set({ seq: noticeSeq, text, tone })
    },
  }
  const noticeFace = (): WikiNoticeFace => ({
    hooks: { notice },
    dismissNotice: () => { notice.set(null) },
  })
  // The sidebar owns the button, the label, and the selection; this entry
  // supplies the glyph only, and selecting the panel is the sidebar's own call.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: () => t('panel'),
    locale: NS,
  }, WikiPanelIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => face,
  }, WikiPage))
  // Notices ride the frame-wide layer: a save outcome must outlive the page
  // whose panel the reader may already have left.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'wiki-vault.notice',
    inject: noticeFace,
  }, WikiNoticeHost))
}
