/**
 * Browser half of `@prism/prism-meeting`: the Meetings icon in the sidebar
 * panel rail and the full central page it opens. Every operation reaches the
 * host through this plugin's own routes under `/api`, so the page runs the
 * deployment's configured meeting model rather than a second route.
 * @module @prism/prism-meeting/src/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the root `main` keyed slot plus the `sidebar.panellist` list this
// package registers into, and the ctx.slots / ctx.locale merges.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createMeetingApi } from './api.ts'
import { MAX_AUDIO_SECONDS, startCapture, toWavBlob } from './audio.ts'
import { en, zh, type MeetingLocaleKey } from './locales.ts'
import { MeetingMinutesPage, type MeetingPageFace } from './MeetingMinutesPage.tsx'
import { MeetingPanelIcon } from './MeetingPanelIcon.tsx'
import { pushMeetingQuestion } from './push.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Meeting page copy. */
    meetingMinutes: MeetingLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'meetingMinutes'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'meeting-minutes' as MainPanelId

/** Services the two registrations need. */
export const inject = ['slots', 'locale']

/**
 * Contribute the Meetings entry to the sidebar and the page it opens.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prism-meeting: dictionaries')
  const t = ctx.locale.bind(NS)
  const api = createMeetingApi()
  const face: MeetingPageFace = {
    list: () => api.list(),
    read: id => api.get(id),
    begin: body => api.begin(body),
    update: body => api.update(body),
    finish: body => api.finish(body),
    revise: body => api.revise(body),
    summarize: id => api.summarize(id),
    remove: id => api.remove(id),
    transcribe: (audio, signal) => api.transcribe(audio, signal),
    speech: signal => api.speech(signal),
    prepare: providerId => api.prepare(providerId),
    cancelPrepare: providerId => api.cancelPrepare(providerId),
    selectSpeech: (providerId, language) => api.select(providerId, language),
    ask: (id, question) => api.ask(id, question),
    answers: id => api.answers(id),
    uploadAudio: async (audio, request) =>
      await api.uploadAudio(await toWavBlob(audio, MAX_AUDIO_SECONDS), request),
    push: request => pushMeetingQuestion(ctx, request),
    capture: () => startCapture(),
  }
  // The sidebar owns the button, the label, and the selection; this entry
  // supplies the glyph only, and selecting the panel is the sidebar's own call.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 10,
    label: () => t('panel'),
    locale: NS,
  }, MeetingPanelIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => face,
  }, MeetingMinutesPage))
}
