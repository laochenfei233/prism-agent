// @vitest-environment jsdom
/** Meetings page: list, detail, the live recording session, and the actions they drive. */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MeetingMinutesPage, type MeetingMinutesPageProps, type MeetingPageFace,
} from '../src/client/MeetingMinutesPage.tsx'
import type { LiveCapture } from '../src/client/audio.ts'
import { en, type MeetingLocaleKey } from '../src/client/locales.ts'
import type { MeetingBeginBody, MeetingRecordingBody, MeetingReviseBody } from '../src/web-contract.ts'
import type { MeetingView } from '../src/view.ts'

afterEach(cleanup)

/** Samples one live slice covers, so the page's interval finds work to do. */
const TARGET_SAMPLES = 16_000

/** Substitute `{name}` placeholders in one dictionary line. */
const translate = (key: MeetingLocaleKey, params?: Record<string, string>): string =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    en[key],
  )

/** One stored meeting with the fields a case is about. */
function meeting(overrides: Partial<MeetingView> = {}): MeetingView {
  return {
    id: 'm1',
    title: 'Weekly sync',
    participants: ['Ada'],
    status: 'transcribed',
    summary: null,
    transcript: 'We shipped the page.',
    segments: [],
    transcriptChars: 20,
    audioSeconds: 65,
    createdAt: new Date(2026, 8, 26, 10, 30).toISOString(),
    updatedAt: new Date(2026, 8, 26, 10, 30).toISOString(),
    ...overrides,
  }
}

/** One capture double the page drives through its interval. */
interface CaptureDouble {
  readonly capture: () => Promise<LiveCapture>
  readonly blocks: Float32Array[]
  readonly stopped: boolean[]
}

/** Build one capture whose samples the case controls. */
function captureDouble(): CaptureDouble {
  const blocks: Float32Array[] = []
  const stopped: boolean[] = []
  return {
    blocks,
    stopped,
    capture: async () => ({
      snapshot: () => new Float32Array(blocks.flatMap(block => [...block])),
      pause: () => {},
      resume: () => {},
      stop: async () => {
        stopped.push(true)
        return new Float32Array(blocks.flatMap(block => [...block]))
      },
    }),
  }
}

/** The meeting face the page is rendered with; every operation is a spy unless a case overrides it. */
function face(overrides: Partial<MeetingPageFace> = {}): MeetingPageFace {
  return {
    list: vi.fn(async () => [meeting()]),
    read: vi.fn(async (id: string) => meeting({ id, transcript: 'Full transcript.' })),
    begin: vi.fn(async (body: MeetingBeginBody) => meeting({
      id: 'live', title: body.title, status: 'recording', transcript: '', transcriptChars: 0, audioSeconds: 0,
    })),
    update: vi.fn(async (body: MeetingRecordingBody) => meeting({
      id: body.id,
      status: 'recording',
      transcript: body.transcript,
      transcriptChars: body.transcript.length,
      audioSeconds: body.audioSeconds,
    })),
    finish: vi.fn(async (body: MeetingRecordingBody) => meeting({
      id: body.id,
      status: 'transcribed',
      transcript: body.transcript,
      transcriptChars: body.transcript.length,
      audioSeconds: body.audioSeconds,
    })),
    revise: vi.fn(async (body: MeetingReviseBody) => meeting({
      id: body.id,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.participants === undefined ? {} : { participants: [...body.participants] }),
    })),
    summarize: vi.fn(async (id: string) => meeting({ id, status: 'summarized', summary: 'Decisions.' })),
    remove: vi.fn(async () => true),
    transcribe: vi.fn(async () => ({ text: 'live words', audioSeconds: 8 })),
    speech: vi.fn(async () => ({ providers: [{ id: 'p', name: 'Provider', phase: 'ready' }], selected: 'p' })),
    prepare: vi.fn(async () => ({ providers: [{ id: 'p', name: 'Provider', phase: 'ready' }], selected: 'p' })),
    cancelPrepare: vi.fn(async () => ({ providers: [{ id: 'p', name: 'Provider', phase: 'ready' }], selected: 'p' })),
    ask: vi.fn(async (id: string, question: string) => ({
      id: 'a1', meetingId: id, question, answer: 'Ship Friday.', createdAt: new Date(2026, 10, 4, 9).toISOString(),
    })),
    answers: vi.fn(async () => []),
    uploadAudio: vi.fn(async () => meeting({ id: 'imported' })),
    push: vi.fn(async () => {}),
    capture: vi.fn(async () => captureDouble().capture()),
    ...overrides,
  }
}

/** The global standard seats every root-scope component is handed; the fixture never drives them. */
function standardSeats() {
  const unused = (): never => { throw new Error('the page fixture provides no global state') }
  return {
    usePanelInfo: unused,
    useWorkspaces: unused,
    useSessions: unused,
    useSessionStatus: unused,
    useSessionRetainInfo: unused,
    useResource: unused,
  }
}

/** Render the page with the standard seats and the supplied meeting face. */
function renderPage(meetingFace: MeetingPageFace): ReturnType<typeof render> {
  const props: MeetingMinutesPageProps = { ...standardSeats(), t: translate, ...meetingFace }
  return render(<MeetingMinutesPage {...props} />)
}

/** Wait for the list to arrive and its first row to render. */
async function ready(meetingFace: MeetingPageFace): Promise<ReturnType<typeof render>> {
  const view = renderPage(meetingFace)
  await screen.findByText('Weekly sync')
  return view
}

/** Open one meeting's detail by clicking its row. */
async function openRow(): Promise<void> {
  fireEvent.click(screen.getByText('Weekly sync'))
  await waitFor(() => { expect(screen.getByRole('heading', { level: 2 })).toBeTruthy() })
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
afterEach(() => { vi.useRealTimers() })

describe('meetings page', () => {
  it('lists the stored meetings and opens one into the detail column', async () => {
    const meetingFace = face()
    await ready(meetingFace)
    expect(screen.getByText(/1:05/)).toBeTruthy()

    await openRow()
    expect(screen.getByText('Ada')).toBeTruthy()
    expect(meetingFace.read).toHaveBeenCalledWith('m1')

    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }))
    expect(screen.getByText('Full transcript.')).toBeTruthy()
  })

  it('shows the empty catalog state', async () => {
    renderPage(face({ list: vi.fn(async () => []) }))
    expect(await screen.findByText(/No meeting records yet/)).toBeTruthy()
  })

  it('warns when no speech provider can transcribe', async () => {
    renderPage(face({ speech: vi.fn(async () => ({ providers: [], selected: '' })) }))
    expect(await screen.findByText(/No speech provider is available/)).toBeTruthy()
  })

  it('warns when the selected provider is registered but not prepared', async () => {
    renderPage(face({
      speech: vi.fn(async () => ({
        providers: [{ id: 'p', name: 'SenseVoice', phase: 'unprepared' }],
        selected: 'p',
      })),
    }))
    expect(await screen.findByText(/is not ready \(unprepared\)/)).toBeTruthy()
  })

  it('prepares the selected provider from the page and follows the progress', async () => {
    let current = {
      providers: [{ id: 'p', name: 'SenseVoice', phase: 'unprepared' }],
      selected: 'p',
    }
    const downloading = {
      providers: [{
        id: 'p', name: 'SenseVoice', phase: 'downloading',
        preparation: { phase: 'downloading', resource: 'model', completedBytes: 1500, totalBytes: 3000 },
      }],
      selected: 'p',
    }
    renderPage(face({
      speech: vi.fn(async () => current),
      prepare: vi.fn(async () => {
        current = downloading
        return downloading
      }),
    }))
    await screen.findByText(/is not ready/)
    fireEvent.click(screen.getByRole('button', { name: 'Prepare speech model' }))
    await waitFor(() => { expect(screen.getByText(/Downloading model for/)).toBeTruthy() })
    expect(screen.getByText(/1\.5 KB \/ 3\.0 KB/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel preparation' })).toBeTruthy()
  })

  it('offers preparation again after a failed one', async () => {
    renderPage(face({
      speech: vi.fn(async () => ({
        providers: [{
          id: 'p', name: 'SenseVoice', phase: 'failed',
          preparation: { phase: 'failed', message: 'disk full' },
        }],
        selected: 'p',
      })),
    }))
    expect(await screen.findByText(/Speech model preparation failed/)).toBeTruthy()
    expect(screen.getByText(/disk full/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Prepare speech model' })).toBeTruthy()
  })

  it('asks the open meeting from the answers tab and files the answer on top', async () => {
    const meetingFace = face({
      answers: vi.fn(async () => []),
      ask: vi.fn(async () => ({
        id: 'a1', meetingId: 'm1', question: 'What did we decide?', answer: 'Ship Friday.',
        createdAt: new Date(2026, 10, 4, 9).toISOString(),
      })),
    })
    await ready(meetingFace)
    await openRow()
    fireEvent.click(screen.getByRole('tab', { name: 'Q&A' }))
    await waitFor(() => { expect(meetingFace.answers).toHaveBeenCalledWith('m1') })
    expect(await screen.findByText('No questions yet.')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Ask'), { target: { value: 'What did we decide?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(await screen.findByText('Ship Friday.')).toBeTruthy()
    expect(meetingFace.ask).toHaveBeenCalledWith('m1', 'What did we decide?')
    expect(screen.getByLabelText('Ask').closest('input')).toBeTruthy()
  })

  it('reports a failed ask', async () => {
    const meetingFace = face({
      answers: vi.fn(async () => []),
      ask: vi.fn(async () => { throw new Error('provider unavailable') }),
    })
    await ready(meetingFace)
    await openRow()
    fireEvent.click(screen.getByRole('tab', { name: 'Q&A' }))
    fireEvent.change(await screen.findByLabelText('Ask'), { target: { value: 'Why?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect((await screen.findByRole('alert')).textContent).toContain('provider unavailable')
  })

  it('stays quiet when the selected provider is ready', async () => {
    renderPage(face())
    await screen.findByText('Weekly sync')
    expect(screen.queryByText(/is not ready/)).toBeNull()
    expect(screen.queryByText(/No speech provider is available/)).toBeNull()
  })

  it('stays quiet when a prepared provider rests in standby', async () => {
    renderPage(face({
      speech: vi.fn(async () => ({
        providers: [{ id: 'p', name: 'SenseVoice', phase: 'standby' }],
        selected: 'p',
      })),
    }))
    await screen.findByText('Weekly sync')
    expect(screen.queryByText(/is not ready/)).toBeNull()
    expect(screen.queryByText(/Prepare speech model/)).toBeNull()
  })

  it('renders the speaker named by each stored span', async () => {
    const spoken = meeting({
      transcript: 'Hi\nBye',
      segments: [{ text: 'Hi', speaker: '1' }, { text: 'Bye' }],
    })
    renderPage(face({ list: vi.fn(async () => [spoken]), read: vi.fn(async () => spoken) }))
    fireEvent.click(await screen.findByText('Weekly sync'))
    await waitFor(() => { expect(screen.getByRole('heading', { level: 2 })).toBeTruthy() })
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }))
    expect(screen.getByText(/^Speaker 1: Hi\s*Bye$/)).toBeTruthy()
  })

  it('sends the recognized speaker spans with a live recording', async () => {
    const capture = captureDouble()
    capture.blocks.push(new Float32Array(TARGET_SAMPLES))
    const meetingFace = face({
      capture: vi.fn(async () => await capture.capture()),
      transcribe: vi.fn(async () => ({
        text: 'Hi',
        segments: [{ text: 'Hi', speaker: '1' }],
        audioSeconds: 8,
      })),
      update: vi.fn(async (body: MeetingRecordingBody) => meeting({
        id: body.id,
        status: 'recording',
        transcript: body.transcript,
        segments: body.segments === undefined ? [] : [...body.segments],
        transcriptChars: body.transcript.length,
        audioSeconds: body.audioSeconds,
      })),
    })
    await ready(meetingFace)
    fireEvent.click(screen.getByRole('button', { name: 'Start meeting' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy() })
    await act(async () => { vi.advanceTimersByTime(9_000) })
    await waitFor(() => {
      expect(meetingFace.update).toHaveBeenCalledWith({
        id: 'live',
        transcript: 'Hi',
        segments: [{ text: 'Hi', speaker: '1' }],
        audioSeconds: expect.any(Number) as number,
      })
    })
    expect(screen.getByText('Speaker 1: Hi')).toBeTruthy()
  })

  it('filters the list and reports a query that matches nothing', async () => {
    const meetingFace = face({ list: vi.fn(async () => [meeting(), meeting({ id: 'm2', title: 'Retro' })]) })
    await ready(meetingFace)
    fireEvent.change(screen.getByLabelText('Search meetings'), { target: { value: 'ret' } })
    expect(screen.queryByText('Weekly sync')).toBeNull()
    fireEvent.change(screen.getByLabelText('Search meetings'), { target: { value: 'quarterly' } })
    expect(screen.getByText('No meeting matches.')).toBeTruthy()
  })

  it('reports a failed list and lets the operator dismiss it', async () => {
    renderPage(face({ list: vi.fn(async () => { throw new Error('storage offline') }) }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('storage offline')
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('summarizes the open meeting and replaces its row', async () => {
    const meetingFace = face()
    await ready(meetingFace)
    await openRow()
    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }))
    expect(await screen.findByText('Decisions.')).toBeTruthy()
    expect(meetingFace.summarize).toHaveBeenCalledWith('m1')
  })

  it('reports a failed summary', async () => {
    const meetingFace = face({ summarize: vi.fn(async () => { throw new Error('provider unavailable') }) })
    await ready(meetingFace)
    await openRow()
    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }))
    expect((await screen.findByRole('alert')).textContent).toContain('provider unavailable')
  })

  it('deletes the open meeting after confirmation', async () => {
    const meetingFace = face()
    await ready(meetingFace)
    await openRow()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText(/Deleted "Weekly sync"/)).toBeTruthy()
    expect(meetingFace.remove).toHaveBeenCalledWith('m1')
  })

  it('pushes a question into a new Session from the detail column', async () => {
    const meetingFace = face()
    await ready(meetingFace)
    await openRow()
    fireEvent.click(screen.getByRole('button', { name: 'Ask in a session' }))
    const dialog = await screen.findByRole('dialog')
    const box = within(dialog).getByRole('textbox')
    fireEvent.change(box, { target: { value: 'What did we decide?' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send to a new session' }))
    expect(await screen.findByText('Asked in a new session')).toBeTruthy()
    expect(meetingFace.push).toHaveBeenCalledWith({
      meetingId: 'm1',
      title: 'Weekly sync',
      question: 'What did we decide?',
      template: en.pushPrompt,
    })
  })

  it('opens the row context menu and starts a question from it', async () => {
    await ready(face())
    fireEvent.contextMenu(screen.getByText('Weekly sync'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ask in a session' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })

  it('opens a durable record in the list and streams its transcript into the detail column', async () => {
    const capture = captureDouble()
    capture.blocks.push(new Float32Array(TARGET_SAMPLES))
    const meetingFace = face({ capture: vi.fn(async () => await capture.capture()) })
    await ready(meetingFace)

    fireEvent.click(screen.getByRole('button', { name: 'Start meeting' }))
    await waitFor(() => { expect(meetingFace.begin).toHaveBeenCalledTimes(1) })

    // The running meeting is a row beside the stored ones, with no dialog over the page.
    await waitFor(() => { expect(screen.getAllByRole('listitem')).toHaveLength(2) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()

    await act(async () => { vi.advanceTimersByTime(9_000) })
    await waitFor(() => { expect(screen.getByText('live words')).toBeTruthy() })
    expect(meetingFace.update).toHaveBeenCalledWith({
      id: 'live', transcript: 'live words', audioSeconds: expect.any(Number) as number,
    })
  })

  it('ends the meeting into the same record without a save step', async () => {
    const capture = captureDouble()
    capture.blocks.push(new Float32Array(TARGET_SAMPLES))
    const meetingFace = face({ capture: vi.fn(async () => await capture.capture()) })
    await ready(meetingFace)
    fireEvent.click(screen.getByRole('button', { name: 'Start meeting' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy() })
    await act(async () => { vi.advanceTimersByTime(9_000) })
    await waitFor(() => { expect(screen.getByText('live words')).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: 'End meeting' }))
    await waitFor(() => { expect(capture.stopped).toHaveLength(1) })
    await waitFor(() => {
      expect(meetingFace.finish).toHaveBeenCalledWith({
        id: 'live', transcript: 'live words', audioSeconds: 8,
      })
    })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'End meeting' })).toBeNull()
  })

  it('pauses and resumes the running recording from the detail column', async () => {
    const meetingFace = face()
    await ready(meetingFace)
    fireEvent.click(screen.getByRole('button', { name: 'Start meeting' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
  })

  it('names a running meeting the operator navigated away from and returns to it', async () => {
    const meetingFace = face()
    await ready(meetingFace)
    fireEvent.click(screen.getByRole('button', { name: 'Start meeting' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy() })

    fireEvent.click(screen.getByText('Weekly sync'))
    expect(await screen.findByText(/is recording\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Go to it' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy() })
  })

  it('discards a running meeting by offering its record for deletion', async () => {
    const meetingFace = face()
    await ready(meetingFace)
    fireEvent.click(screen.getByRole('button', { name: 'Start meeting' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => { expect(meetingFace.finish).toHaveBeenCalledTimes(1) })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => { expect(meetingFace.remove).toHaveBeenCalledWith('live') })
  })

  it('reports a refused microphone without creating a record', async () => {
    // jsdom exposes no mediaDevices, and the refusal message names the missing
    // device interface; provide one so the denial path is the one reported.
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: async () => { throw new DOMException('Permission denied', 'NotAllowedError') } },
      configurable: true,
    })
    const denied = new DOMException('Permission denied', 'NotAllowedError')
    const meetingFace = face({ capture: vi.fn(async () => { throw denied }) })
    await ready(meetingFace)
    fireEvent.click(screen.getByRole('button', { name: 'Start meeting' }))
    expect((await screen.findByRole('alert')).textContent).toContain(en.micDenied)
    expect(meetingFace.begin).not.toHaveBeenCalled()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('closes a record an earlier session left recording', async () => {
    const stale = meeting({ id: 'm2', title: 'Abandoned', status: 'recording', transcript: 'partial', audioSeconds: 0 })
    const meetingFace = face({ list: vi.fn(async () => [stale]), read: vi.fn(async () => stale) })
    renderPage(meetingFace)
    fireEvent.click(await screen.findByText('Abandoned'))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'End meeting' })).toBeTruthy() })
    expect(screen.getByText(en.unfinishedRecording)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'End meeting' }))
    await waitFor(() => {
      expect(meetingFace.finish).toHaveBeenCalledWith({
        id: 'm2', transcript: 'partial', audioSeconds: 0,
      })
    })
  })

  it('revises the open meeting title and participants', async () => {
    const meetingFace = face()
    await ready(meetingFace)
    await openRow()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Sprint retro' } })
    fireEvent.change(screen.getByLabelText('Participants'), { target: { value: 'Ada, Lin' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => {
      expect(meetingFace.revise).toHaveBeenCalledWith({
        id: 'm1', title: 'Sprint retro', participants: ['Ada', 'Lin'],
      })
    })
    expect(await screen.findAllByText('Sprint retro')).toHaveLength(2)
  })

  it('refuses an empty title in the revision form', async () => {
    const meetingFace = face()
    await ready(meetingFace)
    await openRow()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect((await screen.findByRole('alert')).textContent).toContain(en.missingTitle)
    expect(meetingFace.revise).not.toHaveBeenCalled()
  })

  it('reports a failed recording write without ending the meeting', async () => {
    const meetingFace = face({
      begin: vi.fn(async () => { throw new Error('storage offline') }),
    })
    await ready(meetingFace)
    fireEvent.click(screen.getByRole('button', { name: 'Start meeting' }))
    expect((await screen.findByRole('alert')).textContent).toContain('storage offline')
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
  })

  it('keeps the live text and reports a failed closing transcription', async () => {
    const capture = captureDouble()
    capture.blocks.push(new Float32Array(TARGET_SAMPLES))
    const meetingFace = face({
      capture: vi.fn(async () => await capture.capture()),
      transcribe: vi.fn(async () => ({ text: 'live words', audioSeconds: 8 }))
        .mockRejectedValueOnce(new Error('slice offline'))
        .mockRejectedValueOnce(new Error('final offline')),
    })
    await ready(meetingFace)
    fireEvent.click(screen.getByRole('button', { name: 'Start meeting' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'End meeting' })).toBeTruthy() })
    await act(async () => { vi.advanceTimersByTime(9_000) })
    await waitFor(() => {
      expect(screen.getByText(en.liveSliceFailed.replace('{reason}', 'slice offline'))).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'End meeting' }))
    await waitFor(() => {
      expect(meetingFace.finish).toHaveBeenCalledWith({
        id: 'live', transcript: '', audioSeconds: expect.any(Number) as number,
      })
    })
    expect(await screen.findByText(en.liveFinalFailed.replace('{reason}', 'final offline'))).toBeTruthy()
  })

  it('imports an audio file and stores the recognized meeting', async () => {
    const meetingFace = face()
    await ready(meetingFace)
    fireEvent.click(screen.getByRole('button', { name: 'Import meeting' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Standup' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save meeting' }))
    expect(within(dialog).getByRole('alert').textContent).toBe(en.missingAudio)

    const file = new File(['audio'], 'standup.wav', { type: 'audio/wav' })
    fireEvent.change(within(dialog).getByLabelText('Choose an audio file'), { target: { files: [file] } })
    expect(within(dialog).getByText(en.audioReady.replace('{name}', 'standup.wav'))).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save meeting' }))
    await waitFor(() => {
      expect(meetingFace.uploadAudio).toHaveBeenCalledWith(file, { title: 'Standup', participants: [] })
    })
  })

  it('ignores a file input change without a file', async () => {
    await ready(face())
    fireEvent.click(screen.getByRole('button', { name: 'Import meeting' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Choose an audio file'), { target: { files: [] } })
    expect(within(dialog).getByText(en.noAudioChosen)).toBeTruthy()
  })

  it('reloads the list on refresh', async () => {
    const meetingFace = face()
    await ready(meetingFace)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => { expect(meetingFace.list).toHaveBeenCalledTimes(2) })
  })
})

describe('meeting panel icon', () => {
  it('draws the glyph at the requested size', async () => {
    const { MeetingPanelIcon } = await import('../src/client/MeetingPanelIcon.tsx')
    render(<MeetingPanelIcon {...standardSeats()} size={18} active={false} />)
    expect(document.querySelector('svg')?.getAttribute('width')).toBe('18')
  })
})
