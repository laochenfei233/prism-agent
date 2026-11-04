/**
 * The Meetings page: the stored records, one meeting's summary and transcript,
 * the live recording session that owns a record while it runs, and an
 * audio-file import. Starting a meeting opens its durable record at once and
 * streams the recognized text into the detail column, so a running meeting is
 * read in the same list and pane as every stored one. The page reads and writes
 * only through the injected meeting face, so every model call runs on the
 * deployment's configured route.
 * @module @prism-ai/prism-meeting/src/client/MeetingMinutesPage
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Menu, Modal, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AnswerView, MeetingView } from '../view.ts'
import type { MeetingSpeechStatus } from '../types.ts'
import type {
  MeetingBeginBody, MeetingRecordingBody, MeetingReviseBody, MeetingSegmentBody,
} from '../web-contract.ts'
import { LIVE_SLICE_SECONDS, TARGET_SAMPLE_RATE, wavBlob, type LiveCapture } from './audio.ts'
import {
  durationText, filterMeetings, parseParticipants, rowMeta, selectedSpeechProvider, speechNotice,
  speechPhaseAction, statusLabel, timestampText, transcriptLines, type Translate,
} from './presentation.ts'
import type { MeetingQuestion } from './push.ts'
import css from './MeetingMinutesPage.module.css'

/** Lifecycle of the stored list. */
type LoadState = 'loading' | 'ready' | 'failed'

/** Which pane of one meeting the detail column shows. */
type DetailTab = 'summary' | 'transcript' | 'answers'

/** Step of one live recording the detail column reports. */
type LivePhase = 'recording' | 'paused' | 'finishing'

/** Recognized text of one recording, without a stored meeting. */
export interface MeetingTranscript {
  readonly text: string
  /** Speaker-attributed spans of `text`; absent when the provider reports no speakers. */
  readonly segments?: readonly MeetingSegmentBody[]
  readonly audioSeconds: number
}

/** Capabilities the page's apply closure provides. */
export interface MeetingPageFace {
  /** Read every stored meeting, newest first. */
  readonly list: () => Promise<MeetingView[]>
  /** Read one meeting including its transcript. */
  readonly read: (id: string) => Promise<MeetingView>
  /** Open one durable recording before any transcript exists. */
  readonly begin: (body: MeetingBeginBody) => Promise<MeetingView>
  /** Replace the transcript one open recording has produced so far. */
  readonly update: (body: MeetingRecordingBody) => Promise<MeetingView>
  /** Close one open recording with the transcript of its complete recording. */
  readonly finish: (body: MeetingRecordingBody) => Promise<MeetingView>
  /** Replace the operator-editable fields of one stored meeting. */
  readonly revise: (body: MeetingReviseBody) => Promise<MeetingView>
  /** Generate and persist the configured-model summary. */
  readonly summarize: (id: string) => Promise<MeetingView>
  /** Delete one meeting and its stored answers. */
  readonly remove: (id: string) => Promise<boolean>
  /** Recognize one recording without storing anything. */
  readonly transcribe: (audio: Blob, signal?: AbortSignal) => Promise<MeetingTranscript>
  /** Read the speech providers this deployment can transcribe with. */
  readonly speech: (signal?: AbortSignal) => Promise<MeetingSpeechStatus>
  /** Start or join one speech provider's preparation; omission targets the selection. */
  readonly prepare: (providerId: string | undefined) => Promise<MeetingSpeechStatus>
  /** Cancel one speech provider's preparation; omission targets the selection. */
  readonly cancelPrepare: (providerId: string | undefined) => Promise<MeetingSpeechStatus>
  /** Ask one meeting a question and store the exchange. */
  readonly ask: (id: string, question: string) => Promise<AnswerView>
  /** Read one meeting's persisted answers, newest first. */
  readonly answers: (id: string) => Promise<AnswerView[]>
  /** Recognize one complete recording and store the resulting meeting. */
  readonly uploadAudio: (
    audio: Blob,
    request: { readonly title: string; readonly participants: readonly string[] },
  ) => Promise<MeetingView>
  /** Send one question into a new Session and open it. */
  readonly push: (request: MeetingQuestion) => Promise<void>
  /** Start one microphone capture that can be read while it runs. */
  readonly capture: () => Promise<LiveCapture>
}

/** Full component props assembled by the main slot renderer. */
export type MeetingMinutesPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'meetingMinutes'>
  & InjectFace<MeetingPageFace>

/** Where one row's context menu is anchored. */
interface RowMenu {
  readonly meeting: MeetingView
  readonly rect: DOMRect
}

/** One live recording the page drives against its own durable record. */
interface LiveSession {
  /** Durable meeting this session writes. */
  readonly meetingId: string
  readonly phase: LivePhase
  /** Elapsed recorded seconds, refreshed once per second. */
  readonly seconds: number
  /** One slice's recognition failure; recording continues. */
  readonly failure: string | null
}

/** Operator-readable text for one failed operation. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Format one recorded duration for a status line. */
function recordedText(seconds: number): string {
  return durationText(seconds) ?? ''
}

/**
 * Name the microphone failure the operator has to clear before retrying, so a
 * refusal points at the setting that grants it instead of a raw DOM message.
 * @param t - bound translator.
 * @param error - rejection from the capture runtime.
 * @returns the operator-facing sentence.
 */
function microphoneFailure(t: Translate, error: unknown): string {
  // Read dynamically: the DOM lib declares mediaDevices unconditionally, and an
  // insecure or restricted page is exactly the case this sentence explains.
  if (typeof Reflect.get(navigator, 'mediaDevices') !== 'object') return t('micUnsupported')
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return t('micDenied')
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return t('micMissing')
  }
  return t('liveFailed', { reason: reasonOf(error) })
}

/**
 * Render the Meetings page.
 * @param props - global standard seats, this namespace's translator, and the meeting face.
 * @returns the page element tree.
 */
export function MeetingMinutesPage(props: MeetingMinutesPageProps): ReactNode {
  const {
    t, list, read, begin, update, finish, revise, summarize, remove,
    transcribe, speech, prepare, cancelPrepare, ask, answers, uploadAudio, push, capture,
  } = props
  const [meetings, setMeetings] = useState<readonly MeetingView[]>([])
  const [load, setLoad] = useState<LoadState>('loading')
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<MeetingView | null>(null)
  const [tab, setTab] = useState<DetailTab>('summary')
  const [busy, setBusy] = useState(false)
  const [starting, setStarting] = useState(false)
  const [live, setLive] = useState<LiveSession | null>(null)
  const [importing, setImporting] = useState(false)
  const [speechStatus, setSpeechStatus] = useState<MeetingSpeechStatus | null>(null)
  const [speechBusy, setSpeechBusy] = useState(false)
  const [storedAnswers, setStoredAnswers] = useState<readonly AnswerView[]>([])
  const [asking, setAsking] = useState(false)
  const [draftQuestion, setDraftQuestion] = useState('')
  const [deleting, setDeleting] = useState<MeetingView | null>(null)
  const [question, setQuestion] = useState<{ readonly meeting: MeetingView; readonly text: string } | null>(null)
  const [menu, setMenu] = useState<RowMenu | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftParticipants, setDraftParticipants] = useState('')

  const recording = useRef<LiveCapture | null>(null)
  /** Samples already sent to the speech provider. */
  const cursor = useRef(0)
  /** Start of the running recording span; zero while paused. */
  const spanStart = useRef(0)
  /** Closed spans, in milliseconds. */
  const closedSpans = useRef(0)
  /** Complete recognized spans of the live session; their texts form its transcript. */
  const liveSegments = useRef<MeetingSegmentBody[]>([])
  /** Whether any slice named a speaker, which decides if the record stores spans. */
  const liveSpeakers = useRef(false)
  /** Live durable writes, so ending the meeting waits for the last slice. */
  const liveWrites = useRef<Promise<void>>(Promise.resolve())
  /** Durable meeting the live session writes; null when no session runs. */
  const liveId = useRef<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setMeetings(await list())
      setLoad('ready')
      setFailure(null)
    } catch (error) {
      setLoad('failed')
      setFailure(t('loadFailed', { reason: reasonOf(error) }))
    }
  }, [list, t])

  useEffect(() => { void refresh() }, [refresh])

  /** Re-read speech availability; a failed read keeps the last known status. */
  const refreshSpeech = useCallback(async (): Promise<void> => {
    try {
      setSpeechStatus(await speech())
    } catch {
      // The host read failed; the next poll retries and the last status still stands.
    }
  }, [speech])

  // Recording is still allowed without a usable provider, so the notice is advice
  // rather than a block: the operator learns why no transcript appears, and can
  // start the model preparation from here. A provider that is registered but
  // unprepared is the common case, and silence there would let a meeting record
  // produce an empty transcript with no explanation.
  useEffect(() => { void refreshSpeech() }, [refreshSpeech])

  // Preparation moves only on the Host, so the page polls until the selected
  // provider reaches a state that transcribes.
  useEffect(() => {
    const selected = speechStatus === null ? null : selectedSpeechProvider(speechStatus)
    if (selected === null || selected.phase === 'ready' || selected.phase === 'standby') return undefined
    const timer = window.setInterval(() => { void refreshSpeech() }, 1500)
    return () => { window.clearInterval(timer) }
  }, [speechStatus, refreshSpeech])

  // A page that unmounts mid-meeting must release the microphone it still holds.
  useEffect(() => () => { void recording.current?.stop() }, [])

  /** Seconds recorded so far: the closed spans plus the running one. */
  const readSeconds = useCallback((): number => {
    const running = spanStart.current === 0 ? 0 : Date.now() - spanStart.current
    return Math.round((closedSpans.current + running) / 1000)
  }, [])

  /** Close the running span, so a pause or an end stops the clock. */
  const closeSpan = useCallback((): void => {
    if (spanStart.current === 0) return
    closedSpans.current += Date.now() - spanStart.current
    spanStart.current = 0
  }, [])

  /** The live transcript text: the accumulated spans joined the way the service joins them. */
  const liveText = useCallback((): string => {
    return liveSegments.current.map(segment => segment.text).join('\n')
  }, [])

  /** The live write body: spans travel only when recognition named a speaker. */
  const liveBody = useCallback((id: string): MeetingRecordingBody => ({
    id,
    transcript: liveText(),
    ...(liveSpeakers.current ? { segments: liveSegments.current } : {}),
    audioSeconds: readSeconds(),
  }), [liveText, readSeconds])

  /** Read one meeting's transcript, or report why it could not be read. */
  const open = useCallback(async (meeting: MeetingView): Promise<void> => {
    setSelected(meeting)
    setTab('summary')
    setEditing(false)
    try {
      setSelected(await read(meeting.id))
    } catch (error) {
      setFailure(t('loadFailed', { reason: reasonOf(error) }))
    }
  }, [read, t])

  /** Replace one list row with the record an operation returned. */
  const replaceRow = useCallback((updated: MeetingView): void => {
    setMeetings(rows => rows.map(row => (row.id === updated.id ? updated : row)))
    setSelected(current => (current?.id === updated.id ? updated : current))
  }, [])

  /**
   * Transcribe the audio captured since the previous answer and store it, in the
   * order the slices were captured so no answer arrives out of order.
   */
  const slice = useCallback((): void => {
    const active = recording.current
    const id = liveId.current
    if (active === null || id === null) return
    const samples = active.snapshot()
    const fresh = samples.subarray(cursor.current)
    // A slice shorter than one second is not worth a recognition round trip.
    if (fresh.length < TARGET_SAMPLE_RATE) return
    cursor.current = samples.length
    const write = async (): Promise<void> => {
      try {
        const recognized = await transcribe(wavBlob(fresh))
        const spans = recognized.segments ?? [{ text: recognized.text }]
        if (recognized.segments !== undefined) liveSpeakers.current = true
        liveSegments.current.push(...spans)
        replaceRow(await update(liveBody(id)))
      } catch (error) {
        setLive(current => (current === null
          ? current
          : { ...current, failure: t('liveSliceFailed', { reason: reasonOf(error) }) }))
      }
    }
    liveWrites.current = liveWrites.current.then(write, write)
  }, [liveBody, replaceRow, t, transcribe])

  const livePhase: LivePhase | null = live?.phase ?? null

  useEffect(() => {
    if (livePhase !== 'recording') return undefined
    const timer = window.setInterval(() => { slice() }, LIVE_SLICE_SECONDS * 1000)
    return () => { window.clearInterval(timer) }
  }, [livePhase, slice])

  useEffect(() => {
    if (livePhase === null) return undefined
    const timer = window.setInterval(() => {
      setLive(current => (current === null ? current : { ...current, seconds: readSeconds() }))
    }, 1000)
    return () => { window.clearInterval(timer) }
  }, [livePhase, readSeconds])

  /** Open the microphone, then the durable record the page streams into. */
  const onStart = useCallback(async (): Promise<void> => {
    if (starting) return
    setStarting(true)
    setFailure(null)
    let opened: LiveCapture
    try {
      opened = await capture()
    } catch (error) {
      setFailure(microphoneFailure(t, error))
      setStarting(false)
      return
    }
    try {
      const stored = await begin({
        title: t('defaultTitle', { time: timestampText(new Date().toISOString()) }),
        participants: [],
      })
      recording.current = opened
      cursor.current = 0
      liveSegments.current = []
      liveSpeakers.current = false
      closedSpans.current = 0
      spanStart.current = Date.now()
      liveWrites.current = Promise.resolve()
      liveId.current = stored.id
      setMeetings(rows => [stored, ...rows])
      setSelected(stored)
      setTab('transcript')
      setEditing(false)
      setLive({ meetingId: stored.id, phase: 'recording', seconds: 0, failure: null })
    } catch (error) {
      await opened.stop()
      setFailure(t('createFailed', { reason: reasonOf(error) }))
    } finally {
      setStarting(false)
    }
  }, [begin, capture, starting, t])

  /** Stop appending audio without closing the microphone. */
  const onPause = useCallback((): void => {
    recording.current?.pause()
    closeSpan()
    setLive(current => (current === null
      ? current
      : { ...current, phase: 'paused', seconds: readSeconds() }))
  }, [closeSpan, readSeconds])

  /** Continue appending audio after a pause. */
  const onResume = useCallback((): void => {
    recording.current?.resume()
    spanStart.current = Date.now()
    setLive(current => (current === null ? current : { ...current, phase: 'recording' }))
  }, [])

  /** Release the microphone and store the transcript of the complete recording. */
  const onFinish = useCallback(async (): Promise<void> => {
    const active = recording.current
    const id = liveId.current
    if (active === null || id === null) return
    recording.current = null
    closeSpan()
    setLive(current => (current === null
      ? current
      : { ...current, phase: 'finishing', seconds: readSeconds() }))
    await liveWrites.current
    const samples = await active.stop()
    let body = liveBody(id)
    let degraded: string | null = null
    try {
      const recognized = await transcribe(wavBlob(samples))
      body = {
        id,
        transcript: recognized.text,
        ...(recognized.segments === undefined ? {} : { segments: recognized.segments }),
        audioSeconds: Math.round(recognized.audioSeconds),
      }
    } catch (error) {
      degraded = t('liveFinalFailed', { reason: reasonOf(error) })
    }
    try {
      replaceRow(await finish(body))
      setFailure(degraded)
    } catch (error) {
      setFailure(t('finishFailed', { reason: reasonOf(error) }))
    }
    liveId.current = null
    setLive(null)
  }, [closeSpan, finish, liveBody, readSeconds, replaceRow, t, transcribe])

  /** Abandon the running meeting: release the microphone, then offer its record for deletion. */
  const onDiscard = useCallback(async (): Promise<void> => {
    const active = recording.current
    const id = liveId.current
    if (active === null || id === null) return
    recording.current = null
    closeSpan()
    await liveWrites.current
    await active.stop()
    liveId.current = null
    setLive(null)
    try {
      const stored = await finish(liveBody(id))
      replaceRow(stored)
      setDeleting(stored)
    } catch (error) {
      setFailure(t('finishFailed', { reason: reasonOf(error) }))
    }
  }, [closeSpan, finish, liveBody, replaceRow, t])

  /** Close a record the page found still recording, so it becomes readable again. */
  const onCloseRecording = useCallback(async (meeting: MeetingView): Promise<void> => {
    setBusy(true)
    try {
      replaceRow(await finish({
        id: meeting.id,
        transcript: meeting.transcript,
        ...(meeting.segments.length === 0 ? {} : { segments: meeting.segments }),
        audioSeconds: meeting.audioSeconds,
      }))
      setFailure(null)
    } catch (error) {
      setFailure(t('finishFailed', { reason: reasonOf(error) }))
    } finally {
      setBusy(false)
    }
  }, [finish, replaceRow, t])

  const onSummarize = useCallback(async (meeting: MeetingView): Promise<void> => {
    setBusy(true)
    try {
      replaceRow(await summarize(meeting.id))
      setFailure(null)
    } catch (error) {
      setFailure(t('summarizeFailed', { reason: reasonOf(error) }))
    } finally {
      setBusy(false)
    }
  }, [replaceRow, summarize, t])

  const onSaveEdit = useCallback(async (meeting: MeetingView): Promise<void> => {
    const title = draftTitle.trim()
    if (title.length === 0) {
      setFailure(t('missingTitle'))
      return
    }
    setBusy(true)
    try {
      replaceRow(await revise({
        id: meeting.id,
        title,
        participants: parseParticipants(draftParticipants),
      }))
      setEditing(false)
      setFailure(null)
    } catch (error) {
      setFailure(t('reviseFailed', { reason: reasonOf(error) }))
    } finally {
      setBusy(false)
    }
  }, [draftParticipants, draftTitle, replaceRow, revise, t])

  const onDelete = useCallback(async (meeting: MeetingView): Promise<void> => {
    setBusy(true)
    try {
      await remove(meeting.id)
      setMeetings(rows => rows.filter(row => row.id !== meeting.id))
      setSelected(current => (current?.id === meeting.id ? null : current))
      setNotice(t('deleted', { title: meeting.title }))
    } catch (error) {
      setFailure(t('deleteFailed', { reason: reasonOf(error) }))
    } finally {
      setDeleting(null)
      setBusy(false)
    }
  }, [remove, t])

  const onPush = useCallback(async (meeting: MeetingView, text: string): Promise<void> => {
    setBusy(true)
    try {
      await push({ meetingId: meeting.id, title: meeting.title, question: text, template: t('pushPrompt') })
      setQuestion(null)
      setNotice(t('pushSent'))
    } catch (error) {
      setFailure(t('pushFailed', { reason: reasonOf(error) }))
    } finally {
      setBusy(false)
    }
  }, [push, t])

  /** Start or join the selected provider's preparation and adopt the fresh status. */
  const onPrepare = useCallback(async (): Promise<void> => {
    setSpeechBusy(true)
    try {
      setSpeechStatus(await prepare(undefined))
    } catch (error) {
      setFailure(t('speechPrepareRequestFailed', { reason: reasonOf(error) }))
    } finally {
      setSpeechBusy(false)
    }
  }, [prepare, t])

  /** Cancel the selected provider's preparation and adopt the fresh status. */
  const onCancelPrepare = useCallback(async (): Promise<void> => {
    setSpeechBusy(true)
    try {
      setSpeechStatus(await cancelPrepare(undefined))
    } catch (error) {
      setFailure(t('speechCancelRequestFailed', { reason: reasonOf(error) }))
    } finally {
      setSpeechBusy(false)
    }
  }, [cancelPrepare, t])

  const selectedId = selected?.id

  // Reading the answers tab follows the meeting the page shows, so a slower
  // response for an earlier selection never overwrites a newer one.
  useEffect(() => {
    if (tab !== 'answers' || selectedId === undefined) return
    let current = true
    void answers(selectedId).then(
      (loaded) => {
        if (current) setStoredAnswers(loaded)
      },
      (error: unknown) => {
        if (current) setFailure(t('answersLoadFailed', { reason: reasonOf(error) }))
      },
    )
    return () => { current = false }
  }, [answers, selectedId, t, tab])

  /** Ask one meeting the drafted question and file its answer on top. */
  const onAsk = useCallback(async (meeting: MeetingView): Promise<void> => {
    const text = draftQuestion.trim()
    if (text.length === 0) return
    setAsking(true)
    try {
      const answer = await ask(meeting.id, text)
      setStoredAnswers(current => [answer, ...current])
      setDraftQuestion('')
    } catch (error) {
      setFailure(t('askFailed', { reason: reasonOf(error) }))
    } finally {
      setAsking(false)
    }
  }, [ask, draftQuestion, t])

  /** Insert a newly recognized meeting, select it, and close its dialog. */
  const adopt = useCallback((stored: MeetingView): void => {
    setMeetings(rows => [stored, ...rows])
    setSelected(stored)
    setImporting(false)
  }, [])

  const visible = useMemo(() => filterMeetings(meetings, query), [meetings, query])
  const translate: Translate = t
  const liveMeeting = live === null ? null : meetings.find(row => row.id === live.meetingId) ?? null
  const liveHere = live !== null && selected !== null && selected.id === live.meetingId
  const speechWarning = speechStatus === null ? null : speechNotice(speechStatus, t)
  const selectedSpeech = speechStatus === null ? null : selectedSpeechProvider(speechStatus)
  const speechAction = selectedSpeech === null ? null : speechPhaseAction(selectedSpeech)

  return (
    <section className={css.page} aria-busy={load === 'loading'}>
      <header className={css.head}>
        <div className={css.headText}>
          <h1 className={css.title}>{t('title')}</h1>
          <p className={css.intro}>{t('intro')}</p>
        </div>
        <div className={css.toolbar}>
          <Input
            type="search"
            className={css.search as string}
            placeholder={t('search')}
            aria-label={t('search')}
            value={query}
            onChange={(event) => { setQuery(event.target.value) }}
          />
          <Button variant="outline" onClick={() => { void refresh() }}>{t('refresh')}</Button>
          <Button variant="outline" onClick={() => { setImporting(true) }}>{t('createImport')}</Button>
          <Button
            variant="primary"
            disabled={starting || live !== null}
            onClick={() => { void onStart() }}
          >
            {starting ? t('liveStarting') : t('createLive')}
          </Button>
        </div>
      </header>

      {failure !== null && (
        <p className={css.failure} role="alert">
          <span>{failure}</span>
          <button type="button" className={css.dismiss} onClick={() => { setFailure(null) }}>{t('dismiss')}</button>
        </p>
      )}
      {notice !== null && (
        <p className={css.notice} role="status">
          <span>{notice}</span>
          <button type="button" className={css.dismiss} onClick={() => { setNotice(null) }}>{t('dismiss')}</button>
        </p>
      )}
      {speechWarning !== null && (
        <div className={css.speechBar} role="status">
          <span className={css.barText}>{speechWarning}</span>
          <span className={css.barActions}>
            {speechAction === 'prepare' && (
              <Button variant="outline" disabled={speechBusy} onClick={() => { void onPrepare() }}>
                {t('speechPrepare')}
              </Button>
            )}
            {speechAction === 'cancel' && (
              <Button variant="ghost" disabled={speechBusy} onClick={() => { void onCancelPrepare() }}>
                {t('speechCancelPrepare')}
              </Button>
            )}
            <button type="button" className={css.dismiss} onClick={() => { setSpeechStatus(null) }}>
              {t('dismiss')}
            </button>
          </span>
        </div>
      )}
      {live !== null && !liveHere && (
        <p className={css.warning} role="status">
          <span>{t('liveElsewhere', { title: liveMeeting?.title ?? '' })}</span>
          <button
            type="button"
            className={css.dismiss}
            onClick={() => { if (liveMeeting !== null) setSelected(liveMeeting) }}
          >
            {t('liveReturn')}
          </button>
        </p>
      )}

      <div className={css.body}>
        <ul className={css.list} aria-label={t('title')}>
          {visible.map(meeting => (
            <li key={meeting.id}>
              <button
                type="button"
                className={css.row}
                data-selected={selected?.id === meeting.id || undefined}
                aria-current={selected?.id === meeting.id ? 'true' : undefined}
                onClick={() => { void open(meeting) }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({ meeting, rect: event.currentTarget.getBoundingClientRect() })
                }}
              >
                <span className={css.rowTitle}>{meeting.title}</span>
                <span className={css.rowMeta}>{rowMeta(meeting, translate).join(' · ')}</span>
                <span className={css.rowTime}>{timestampText(meeting.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className={css.detail}>
          {load === 'loading' && (
            <p className={css.placeholder}><StateDot state="ongoing" /> {t('loading')}</p>
          )}
          {load !== 'loading' && visible.length === 0 && (
            <p className={css.placeholder}>
              {meetings.length === 0 ? `${t('empty')}. ${t('emptyHint')}` : t('listEmpty')}
            </p>
          )}
          {load !== 'loading' && visible.length > 0 && selected === null && (
            <p className={css.placeholder}>{t('detailPlaceholder')}</p>
          )}
          {selected !== null && (
            <article className={css.meeting}>
              <div className={css.meetingHead}>
                <h2 className={css.meetingTitle}>{selected.title}</h2>
                <Tag tone={selected.status === 'recording'
                  ? 'warning'
                  : selected.status === 'summarized' ? 'success' : 'info'}>
                  {statusLabel(selected.status, translate)}
                </Tag>
                {!liveHere && !editing && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditing(true)
                      setDraftTitle(selected.title)
                      setDraftParticipants(selected.participants.join(', '))
                    }}
                  >
                    {t('edit')}
                  </Button>
                )}
              </div>

              {live !== null && liveHere && (
                <div className={css.liveBar} role="status">
                  <div className={css.liveText}>
                    <span className={css.liveStatus}>
                      {live.phase !== 'paused' && <StateDot state="ongoing" />}
                      {live.phase === 'recording'
                        ? `${t('recording')} ${recordedText(live.seconds)}`
                        : live.phase === 'paused'
                          ? `${t('paused')} ${recordedText(live.seconds)}`
                          : t('transcribingLive')}
                    </span>
                    <span className={css.liveHint}>
                      {t('liveHint', { seconds: String(LIVE_SLICE_SECONDS) })}
                    </span>
                  </div>
                  <div className={css.liveActions}>
                    {live.phase === 'recording' && (
                      <Button variant="outline" onClick={onPause}>{t('pauseRecording')}</Button>
                    )}
                    {live.phase === 'paused' && (
                      <Button variant="outline" onClick={onResume}>{t('resumeRecording')}</Button>
                    )}
                    {live.phase !== 'finishing' && (
                      <>
                        <Button variant="primary" onClick={() => { void onFinish() }}>{t('stopRecording')}</Button>
                        <Button variant="ghost" onClick={() => { void onDiscard() }}>{t('discard')}</Button>
                      </>
                    )}
                  </div>
                </div>
              )}
              {live !== null && liveHere && live.failure !== null && (
                <p className={css.dialogFailure} role="alert">{live.failure}</p>
              )}

              {editing ? (
                <div className={css.editForm}>
                  <label className={css.field}>
                    <span>{t('fieldTitle')}</span>
                    <Input
                      value={draftTitle}
                      placeholder={t('fieldTitlePlaceholder')}
                      onChange={(event) => { setDraftTitle(event.target.value) }}
                    />
                  </label>
                  <label className={css.field}>
                    <span>{t('fieldParticipants')}</span>
                    <Input
                      value={draftParticipants}
                      placeholder={t('fieldParticipantsPlaceholder')}
                      onChange={(event) => { setDraftParticipants(event.target.value) }}
                    />
                  </label>
                  <div className={css.meetingActions}>
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => { void onSaveEdit(selected) }}
                    >
                      {t('saveChanges')}
                    </Button>
                    <Button variant="ghost" onClick={() => { setEditing(false) }}>{t('cancel')}</Button>
                  </div>
                </div>
              ) : (
                <dl className={css.meta}>
                  <div><dt>{t('createdAt')}</dt><dd>{timestampText(selected.createdAt)}</dd></div>
                  <div><dt>{t('updatedAt')}</dt><dd>{timestampText(selected.updatedAt)}</dd></div>
                  <div><dt>{t('duration')}</dt><dd>{durationText(selected.audioSeconds) ?? t('noAudio')}</dd></div>
                  <div>
                    <dt>{t('transcriptChars')}</dt>
                    <dd>{t('transcriptCharsValue', { count: String(selected.transcriptChars) })}</dd>
                  </div>
                  <div className={css.metaWide}>
                    <dt>{t('participants')}</dt>
                    <dd>
                      {selected.participants.length === 0
                        ? t('noParticipants')
                        : selected.participants.join(', ')}
                    </dd>
                  </div>
                </dl>
              )}

              {!liveHere && selected.status === 'recording' && (
                <p className={css.warning} role="status">
                  <span>{t('unfinishedRecording')}</span>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => { void onCloseRecording(selected) }}
                  >
                    {t('stopRecording')}
                  </Button>
                </p>
              )}

              <div className={css.meetingActions}>
                {selected.status !== 'recording' && (
                  <>
                    <Button variant="outline" disabled={busy} onClick={() => { void onSummarize(selected) }}>
                      {busy ? t('summarizing') : t('summarize')}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => { setQuestion({ meeting: selected, text: t('pushDefaultQuestion') }) }}
                    >
                      {t('push')}
                    </Button>
                  </>
                )}
                <Button variant="ghost" onClick={() => { setDeleting(selected) }}>{t('delete')}</Button>
              </div>

              {selected.status === 'recording' ? (
                <pre className={css.text}>
                  {selected.transcript.length === 0
                    ? t('liveWaiting')
                    : transcriptLines(selected.transcript, selected.segments, translate)}
                </pre>
              ) : (
                <>
                  <div className={css.tabs} role="tablist" aria-label={t('detailActions')}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === 'summary'}
                      data-active={tab === 'summary' || undefined}
                      onClick={() => { setTab('summary') }}
                    >
                      {t('summaryTab')}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === 'transcript'}
                      data-active={tab === 'transcript' || undefined}
                      onClick={() => { setTab('transcript') }}
                    >
                      {t('transcriptTab')}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === 'answers'}
                      data-active={tab === 'answers' || undefined}
                      onClick={() => { setTab('answers') }}
                    >
                      {t('answersTab')}
                    </button>
                  </div>
                  {tab === 'answers' ? (
                    <div className={css.answers}>
                      <div className={css.askRow}>
                        <Input
                          value={draftQuestion}
                          placeholder={t('askPlaceholder')}
                          aria-label={t('ask')}
                          onChange={(event) => { setDraftQuestion(event.target.value) }}
                        />
                        <Button
                          variant="primary"
                          disabled={busy || asking || draftQuestion.trim().length === 0}
                          onClick={() => { void onAsk(selected) }}
                        >
                          {asking ? t('asking') : t('ask')}
                        </Button>
                      </div>
                      {storedAnswers.length === 0
                        ? <p className={css.placeholder}>{t('answersEmpty')}</p>
                        : (
                          <ul className={css.answerList}>
                            {storedAnswers.map(answer => (
                              <li key={answer.id} className={css.answer}>
                                <p className={css.answerQuestion}>{answer.question}</p>
                                <p className={css.answerText}>{answer.answer}</p>
                                <p className={css.answerTime}>{timestampText(answer.createdAt)}</p>
                              </li>
                            ))}
                          </ul>
                        )}
                    </div>
                  ) : (
                    <pre className={css.text}>
                      {tab === 'summary'
                        ? (selected.summary ?? t('summaryEmpty'))
                        : transcriptLines(selected.transcript, selected.segments, translate)}
                    </pre>
                  )}
                </>
              )}
            </article>
          )}
        </div>
      </div>

      {importing && (
        <ImportDialog
          t={translate}
          onClose={() => { setImporting(false) }}
          onSave={async (file, request) => { adopt(await uploadAudio(file, request)) }}
        />
      )}

      <Modal
        open={deleting !== null}
        onClose={() => { setDeleting(null) }}
        title={t('deleteTitle')}
        closeLabel={t('close')}
        {...(deleting === null ? {} : { description: t('deleteBody', { title: deleting.title }) })}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setDeleting(null) }}>{t('cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => { if (deleting !== null) void onDelete(deleting) }}
            >
              {t('confirmDelete')}
            </Button>
          </>
        )}
      />

      <Modal
        open={question !== null}
        onClose={() => { setQuestion(null) }}
        title={t('pushTitle')}
        closeLabel={t('close')}
        {...(question === null ? {} : { description: t('pushBody', { title: question.meeting.title }) })}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setQuestion(null) }}>{t('cancel')}</Button>
            <Button
              variant="primary"
              disabled={busy || question === null || question.text.trim().length === 0}
              onClick={() => { if (question !== null) void onPush(question.meeting, question.text.trim()) }}
            >
              {t('pushSend')}
            </Button>
          </>
        )}
      >
        <textarea
          className={css.question}
          aria-label={t('pushPlaceholder')}
          placeholder={t('pushPlaceholder')}
          value={question?.text ?? ''}
          onChange={(event) => {
            const text = event.target.value
            setQuestion(current => (current === null ? current : { ...current, text }))
          }}
        />
      </Modal>

      <Menu
        open={menu !== null}
        portal
        anchor={<span className={css.menuAnchor} aria-hidden="true" />}
        getAnchorRect={() => menu?.rect ?? null}
        onClose={() => { setMenu(null) }}
        items={[{ id: 'push', label: t('push') }]}
        onSelect={() => {
          if (menu !== null) setQuestion({ meeting: menu.meeting, text: t('pushDefaultQuestion') })
          setMenu(null)
        }}
      />
    </section>
  )
}

/** Props of the audio-import dialog. */
interface ImportDialogProps {
  readonly t: Translate
  readonly onClose: () => void
  readonly onSave: (
    file: File,
    request: { readonly title: string; readonly participants: readonly string[] },
  ) => Promise<void>
}

/**
 * The Import-meeting dialog: one audio file, recognized and stored as a meeting.
 * @param props - translator, close callback, and the upload operation.
 * @returns the dialog element tree.
 */
function ImportDialog(props: ImportDialogProps): ReactNode {
  const { t, onClose, onSave } = props
  const [title, setTitle] = useState('')
  const [participants, setParticipants] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  /** Validate the draft and store the recognized meeting. */
  const save = async (): Promise<void> => {
    const name = title.trim()
    if (name.length === 0) {
      setFailure(t('missingTitle'))
      return
    }
    if (file === null) {
      setFailure(t('missingAudio'))
      return
    }
    setSaving(true)
    setFailure(null)
    try {
      await onSave(file, { title: name, participants: parseParticipants(participants) })
      onClose()
    } catch (error) {
      setFailure(t('createFailed', { reason: reasonOf(error) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('importTitle')}
      closeLabel={t('close')}
      description={t('importIntro')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={saving} onClick={() => { void save() }}>
            {saving ? t('saving') : t('save')}
          </Button>
        </>
      )}
    >
      {failure !== null && <p className={css.dialogFailure} role="alert">{failure}</p>}
      <label className={css.field}>
        <span>{t('fieldTitle')}</span>
        <Input
          value={title}
          placeholder={t('fieldTitlePlaceholder')}
          onChange={(event) => { setTitle(event.target.value) }}
        />
      </label>
      <label className={css.field}>
        <span>{t('fieldParticipants')}</span>
        <Input
          value={participants}
          placeholder={t('fieldParticipantsPlaceholder')}
          onChange={(event) => { setParticipants(event.target.value) }}
        />
      </label>
      <div className={css.field}>
        <span>{t('fieldAudio')}</span>
        <input
          type="file"
          accept="audio/*"
          aria-label={t('chooseAudio')}
          onChange={(event) => {
            const chosen = event.target.files?.[0]
            if (chosen === undefined) return
            setFile(chosen)
          }}
        />
        <p className={css.audioState}>
          {file === null ? t('noAudioChosen') : t('audioReady', { name: file.name })}
        </p>
      </div>
    </Modal>
  )
}
