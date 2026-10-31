// @vitest-environment jsdom
/** The transfer page as the settings shell renders it: export card, import card, progress, and outcome. */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TransferSection, type TransferFace, type TransferSectionProps } from '../src/client/TransferSection.tsx'
import { TRANSFER_EXPORT_PATH } from '../src/routes.ts'
import { en } from '../src/client/locales.ts'
import type { TransferJobSnapshot } from '../src/types.ts'

afterEach(cleanup)

const t = (key: keyof typeof en, params?: Record<string, unknown>): string => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

/** One registered project in the workspace snapshot. */
function project(id: string, title: string, sessions: number) {
  return {
    workspaceId: id,
    path: `/p/${id}`,
    title,
    sessionIds: Array.from({ length: sessions }, (_, index) => `s${String(index)}`),
    createdAt: '',
    updatedAt: '',
  }
}

/** Fake workspaces store serving the given rows. */
function fakeWorkspaces(items: ReturnType<typeof project>[]): TransferFace['workspaces'] {
  return {
    list: {
      getSnapshot: () => ({ items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle' as const, error: null }),
      subscribe: vi.fn(() => () => {}),
    },
  } as unknown as TransferFace['workspaces']
}

/** Fake picker resolving or failing. */
function fakePicker(result: string | null = null, fail = false): TransferFace['directoryPicker'] {
  return {
    pick: vi.fn(async () => {
      if (fail) throw new Error('picker is gone')
      return result
    }),
  }
}

/** Render the page over fakes. */
function renderPage(options: {
  items?: ReturnType<typeof project>[]
  picker?: TransferFace['directoryPicker']
} = {}): void {
  const props = {
    close: vi.fn(),
    t,
    workspaces: fakeWorkspaces(options.items ?? [project('w1', 'Alpha', 2), project('w2', 'Beta', 0)]),
    directoryPicker: options.picker ?? fakePicker(),
  } as TransferSectionProps
  render(<TransferSection {...props} />)
}

/** A FileList-shaped view over plain files, matching what a real input provides. */
function fileList(files: File[]): FileList {
  const list = { length: files.length, item: (index: number): File | null => files[index] ?? null }
  files.forEach((file, index) => {
    Object.defineProperty(list, index, { value: file, enumerable: true })
  })
  return list as unknown as FileList
}

/** One mocked route's answer: a ready Response, a JSON descriptor, or a rejection. */
type FetchReply =
  | Response
  | { status?: number; body?: unknown; headers?: Record<string, string> }

/** Install a fetch mock answering per URL substring; handlers may reject with any value. */
function mockFetch(routes: Record<string, (url: string) => FetchReply | Promise<never>>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const text = String(url)
    for (const [needle, handler] of Object.entries(routes)) {
      if (text.includes(needle)) {
        const reply = await handler(text)
        if (reply instanceof Response) return reply
        return new Response(reply.body === undefined ? '{}' : JSON.stringify(reply.body), {
          status: reply.status ?? 200,
          ...(reply.headers === undefined ? {} : { headers: reply.headers }),
        })
      }
    }
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Stub the download plumbing and return the click spy. */
function stubDownload(): ReturnType<typeof vi.fn> {
  const click = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
  return click
}

/** Stub the download plumbing and record every requested download name. */
function stubDownloadNames(): string[] {
  const names: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function spy(this: HTMLAnchorElement) {
    names.push(this.href)
  })
  return names
}

/** Pick one file through the hidden input. */
function chooseFile(name: string): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', {
    value: fileList([new File([new Uint8Array(2048)], name, { type: 'application/zip' })]),
  })
  fireEvent.change(input)
}

describe('TransferSection export card', () => {
  it('lists projects with session counts and toggles select-all', () => {
    renderPage()
    expect(screen.getByText('Alpha')).toBeDefined()
    expect(screen.getByText('2 sessions')).toBeDefined()
    const selectAll = screen.getByLabelText('Select all') as HTMLInputElement
    expect(selectAll.checked).toBe(false)
    fireEvent.click(selectAll)
    expect((screen.getByLabelText('Alpha') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('Beta') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(selectAll)
    expect((screen.getByLabelText('Alpha') as HTMLInputElement).checked).toBe(false)
  })

  it('drops a project from the selection when it is unchecked', () => {
    renderPage()
    fireEvent.click(screen.getByLabelText('Alpha'))
    expect((screen.getByLabelText('Alpha') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByLabelText('Alpha'))
    expect((screen.getByLabelText('Alpha') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByText('Export selected') as HTMLButtonElement).disabled).toBe(true)
  })

  it('exports selected projects as a zip download and shows the empty state without projects', async () => {
    const click = stubDownload()
    mockFetch({
      '/api/prism.transfer/export': () => ({ body: { ok: true } }),
    })
    renderPage()
    fireEvent.click(screen.getByLabelText('Alpha'))
    fireEvent.click(screen.getByText('Export selected'))
    await waitFor(() => {
      expect(click).toHaveBeenCalled()
    })
    cleanup()
    renderPage({ items: [] })
    expect(screen.getByText('No registered projects yet')).toBeDefined()
    expect((screen.getByText('Export selected') as HTMLButtonElement).disabled).toBe(true)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('surfaces a typed export failure', async () => {
    mockFetch({
      '/api/prism.transfer/export': () => ({ status: 409, body: { code: 'busy', message: 'ignored' } }),
    })
    renderPage()
    fireEvent.click(screen.getByLabelText('Alpha'))
    fireEvent.click(screen.getByText('Export selected'))
    await waitFor(() => {
      expect(screen.getByText('Another import is already running; try again later.')).toBeDefined()
    })
    vi.unstubAllGlobals()
  })

  it('reports skip counts from the validation pass and the secrets header', async () => {
    mockFetch({
      '/api/prism.transfer/export': (url) => {
        if (url.includes('validate=1')) {
          return { body: { skippedLinks: 2, skippedUnreadable: 1, skippedSecrets: 3 } }
        }
        return { body: { ok: true } }
      },
    })
    renderPage()
    fireEvent.click(screen.getByLabelText('Alpha'))
    fireEvent.click(screen.getByText('Export selected'))
    await waitFor(() => {
      expect(screen.getByText('Skipped 2 links and 1 unreadable files. 3 secret fields were not exported.')).toBeDefined()
    })
    vi.unstubAllGlobals()

    mockFetch({
      '/api/prism.transfer/export': () => ({
        body: { format: 'prism-settings' },
        headers: { 'x-prism-transfer-skipped-secrets': '4' },
      }),
    })
    cleanup()
    renderPage()
    fireEvent.click(screen.getByText('Export settings only'))
    await waitFor(() => {
      expect(screen.getByText('4 secret fields were not exported.')).toBeDefined()
    })
    vi.unstubAllGlobals()
  })

  it('exports settings only and includes the secrets flag', async () => {
    const click = stubDownload()
    mockFetch({
      '/api/prism.transfer/export': (url) => {
        expect(url).toContain('settings=1')
        expect(url).toContain('secrets=1')
        return { body: { format: 'prism-settings' } }
      },
    })
    renderPage()
    fireEvent.click(screen.getByLabelText('Include settings'))
    fireEvent.click(screen.getByLabelText('Include secrets (written in plain text)'))
    fireEvent.click(screen.getByText('Export settings only'))
    await waitFor(() => {
      expect(click).toHaveBeenCalled()
    })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('sends the settings and secrets flags on project exports and names the file via RFC 5987', async () => {
    const click = stubDownload()
    const fetchMock = mockFetch({
      '/api/prism.transfer/export': (url) => {
        expect(url).toContain('projects=w1')
        expect(url).toContain('settings=1')
        expect(url).toContain('secrets=1')
        return {
          body: { format: 'prism-project' },
          headers: { 'content-disposition': 'attachment; filename="My_Project.zip"; filename*=UTF-8\'\'My%20Project.zip' },
        }
      },
    })
    renderPage()
    fireEvent.click(screen.getByLabelText('Alpha'))
    fireEvent.click(screen.getByLabelText('Include settings'))
    fireEvent.click(screen.getByLabelText('Include secrets (written in plain text)'))
    fireEvent.click(screen.getByText('Export selected'))
    await waitFor(() => {
      expect(click).toHaveBeenCalled()
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('projects=w1')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('hands the streaming route URL to the browser download manager', async () => {
    const hrefs = stubDownloadNames()
    mockFetch({
      '/api/prism.transfer/export': () => ({ body: { skippedLinks: 0, skippedUnreadable: 0, skippedSecrets: 0 } }),
    })
    renderPage()
    fireEvent.click(screen.getByLabelText('Alpha'))
    fireEvent.click(screen.getByText('Export selected'))
    await waitFor(() => {
      expect(hrefs.some(href => href.includes(TRANSFER_EXPORT_PATH) && href.includes('projects=w1'))).toBe(true)
    })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reports a non-Error export rejection and a failing settings-only export', async () => {
    mockFetch({
      '/api/prism.transfer/export': () => Promise.reject('offline'),
    })
    renderPage()
    fireEvent.click(screen.getByLabelText('Alpha'))
    fireEvent.click(screen.getByText('Export selected'))
    await waitFor(() => {
      expect(screen.getByText('offline')).toBeDefined()
    })
    vi.unstubAllGlobals()

    mockFetch({
      '/api/prism.transfer/export': () => ({ status: 500, body: { code: 'settings-format', message: 'unreadable document' } }),
    })
    cleanup()
    renderPage()
    fireEvent.click(screen.getByText('Export settings only'))
    await waitFor(() => {
      expect(screen.getByText('The settings file format is not supported.')).toBeDefined()
    })
    vi.unstubAllGlobals()

    mockFetch({
      '/api/prism.transfer/export': () => Promise.reject('offline'),
    })
    cleanup()
    renderPage()
    fireEvent.click(screen.getByText('Export settings only'))
    await waitFor(() => {
      expect(screen.getByText('offline')).toBeDefined()
    })
    vi.unstubAllGlobals()
  })
})

describe('TransferSection import card', () => {
  it('picks a destination through the native picker and reports picker failure', async () => {
    const picker = fakePicker('/chosen/root')
    renderPage({ picker })
    fireEvent.click(screen.getByText('Change…'))
    await waitFor(() => {
      expect(screen.getByText('/chosen/root')).toBeDefined()
    })
    cleanup()
    renderPage({ picker: fakePicker(null, true) })
    fireEvent.click(screen.getByText('Change…'))
    await waitFor(() => {
      expect(screen.getByText('No system directory picker on this deployment; keeping the default.')).toBeDefined()
    })
    // The unavailable capability hides the control entirely.
    expect(screen.queryByText('Change…')).toBeNull()
  })

  it('uploads a chosen file and renders the done outcome with duplicates and settings', async () => {
    mockFetch({
      '/api/prism.transfer/import': () => ({ body: { jobId: 'j9' } }),
      '/api/prism.transfer/job': () => ({
        body: {
          jobId: 'j9', kind: 'project', state: 'done', phase: 'done', name: 'round.zip',
          archiveBytes: 10, files: 1, bytes: 20, sessionsDone: 2, sessionsTotal: 2,
          projectsDone: 1, projectsTotal: 1, duplicates: 1, startedAt: 1, finishedAt: 2,
          result: {
            projects: [{ name: 'Alpha', path: '/p/Alpha', sessions: 2, duplicates: 1 }],
            settings: [{ ns: 'web', outcome: 'applied' }, { ns: 'gone', outcome: 'skipped' }],
          },
        },
      }),
    })
    renderPage()
    chooseFile('round.zip')
    expect(screen.getByText('Selected: round.zip (2.0 KiB)')).toBeDefined()
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(screen.getByText('Import finished')).toBeDefined()
    }, { timeout: 5000 })
    expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0)
    expect(screen.getAllByText('1 existing sessions skipped', { exact: false }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('Import another'))
    expect(screen.queryByText('Import finished')).toBeNull()
    vi.unstubAllGlobals()
  })

  it('follows a running job through the progress line and reports a typed failure', async () => {
    let polls = 0
    const running: TransferJobSnapshot = {
      jobId: 'jf', kind: 'combined', state: 'running', phase: 'restoring', name: 'fail.zip',
      archiveBytes: 10, files: 0, bytes: 5, sessionsDone: 1, sessionsTotal: 4,
      projectsDone: 0, projectsTotal: 2,      skippedSecrets: 0, startedAt: 1,
    }
    mockFetch({
      '/api/prism.transfer/import': () => ({ body: { jobId: 'jf' } }),
      '/api/prism.transfer/job': () => {
        polls += 1
        if (polls >= 2) {
          return {
            status: 200,
            body: { ...running, state: 'failed', error: { code: 'crc-mismatch', detail: 'entry "x" failed its checksum' } },
          }
        }
        return { status: 200, body: running }
      },
    })
    renderPage()
    chooseFile('fail.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(screen.getByText('Restoring sessions and media…')).toBeDefined()
    }, { timeout: 5000 })
    await waitFor(() => {
      expect(screen.getByText('The archive is damaged: an entry failed its checksum.')).toBeDefined()
    }, { timeout: 5000 })
    vi.unstubAllGlobals()
  })

  it('maps a busy refusal to its copy and reports an HTTP failure body without a code', async () => {
    mockFetch({
      '/api/prism.transfer/import': () => ({ status: 409, body: { code: 'busy', message: 'ignored' } }),
    })
    renderPage()
    chooseFile('busy.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(screen.getByText('Another import is already running; try again later.')).toBeDefined()
    })
    vi.unstubAllGlobals()

    mockFetch({
      '/api/prism.transfer/import': () => ({ status: 500, body: {} }),
    })
    cleanup()
    renderPage()
    chooseFile('busy.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(screen.getByText('Request failed (HTTP 500)')).toBeDefined()
    })
    vi.unstubAllGlobals()
  })

  it('opens the file dialog from the choose button and clears a change with no files', () => {
    renderPage()
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByText('Choose archive…'))
    expect(click).toHaveBeenCalled()
    vi.restoreAllMocks()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: null })
    fireEvent.change(input)
    expect(screen.queryByText(/Selected:/)).toBeNull()
  })

  it('shows an indeterminate progress line and names the failed job without an error block', async () => {
    let polls = 0
    mockFetch({
      '/api/prism.transfer/import': () => ({ body: { jobId: 'jn' } }),
      '/api/prism.transfer/job': () => {
        polls += 1
        if (polls >= 2) {
          return {
            status: 200,
            body: {
              jobId: 'jn', kind: 'project', state: 'failed', phase: 'restoring', name: 'noerror.zip',
              archiveBytes: 10, files: 0, bytes: 0, sessionsDone: 0, sessionsTotal: 0,
              projectsDone: 0, projectsTotal: 0,              skippedSecrets: 0, startedAt: 1,
            },
          }
        }
        return {
          status: 200,
          body: {
            jobId: 'jn', kind: 'project', state: 'running', phase: 'validating', name: 'noerror.zip',
            archiveBytes: 10, files: 0, bytes: 0, sessionsDone: 0, sessionsTotal: 0,
            projectsDone: 0, projectsTotal: 0,            skippedSecrets: 0, startedAt: 1,
          },
        }
      },
    })
    renderPage()
    chooseFile('noerror.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(screen.getByText('Validating the archive…')).toBeDefined()
    }, { timeout: 5000 })
    await waitFor(() => {
      expect(screen.getByText('noerror.zip')).toBeDefined()
    }, { timeout: 5000 })
    vi.unstubAllGlobals()
  })

  it('reports an unexpected poll response and a non-Error poll rejection', async () => {
    mockFetch({
      '/api/prism.transfer/import': () => ({ body: { jobId: 'ju' } }),
      '/api/prism.transfer/job': () => ({ body: { nope: true } }),
    })
    renderPage()
    chooseFile('unexpected.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(screen.getByText('The service returned an unrecognized response.')).toBeDefined()
    }, { timeout: 5000 })
    vi.unstubAllGlobals()

    mockFetch({
      '/api/prism.transfer/import': () => ({ body: { jobId: 'jr' } }),
      '/api/prism.transfer/job': () => Promise.reject('poll offline'),
    })
    cleanup()
    renderPage()
    chooseFile('unexpected.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(screen.getByText('poll offline')).toBeDefined()
    }, { timeout: 5000 })
    vi.unstubAllGlobals()

    mockFetch({
      '/api/prism.transfer/import': () => ({ body: { jobId: 'jr' } }),
      '/api/prism.transfer/job': () => new Response('not json at all', { status: 200 }),
    })
    cleanup()
    renderPage()
    chooseFile('unexpected.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(screen.getByText('The service returned an unrecognized response.')).toBeDefined()
    }, { timeout: 5000 })
    vi.unstubAllGlobals()
  })

  it('stops a poll loop whose job was superseded by unmounting', async () => {
    let jobCalls = 0
    mockFetch({
      '/api/prism.transfer/import': () => ({ body: { jobId: 'js' } }),
      '/api/prism.transfer/job': () => {
        jobCalls += 1
        // The first poll keeps the loop alive; the one after unmount rejects.
        return jobCalls === 1
          ? { body: { jobId: 'js', state: 'running', phase: 'validating' } }
          : Promise.reject('poll offline')
      },
    })
    renderPage()
    chooseFile('superseded.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(jobCalls).toBeGreaterThanOrEqual(1)
    }, { timeout: 5000 })
    cleanup()
    // The rejected tick lands after the seq bump and stops silently.
    await waitFor(() => {
      expect(jobCalls).toBeGreaterThanOrEqual(2)
    }, { timeout: 5000 })
    await new Promise(resolve => setTimeout(resolve, 50))
    vi.unstubAllGlobals()
  })

  it('keeps the default destination when the picker cancels, and sends a picked destination', async () => {
    mockFetch({
      '/api/prism.transfer/import': (url) => {
        expect(url).toContain(`dest=${encodeURIComponent('/chosen/root')}`)
        return { body: { jobId: 'jd' } }
      },
      '/api/prism.transfer/job': () => ({ body: { jobId: 'jd', state: 'running', phase: 'validating' } }),
    })
    renderPage({ picker: fakePicker('/chosen/root') })
    fireEvent.click(screen.getByText('Change…'))
    await waitFor(() => {
      expect(screen.getByText('/chosen/root')).toBeDefined()
    })
    chooseFile('destined.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(screen.getByText('Validating the archive…')).toBeDefined()
    }, { timeout: 5000 })
    vi.unstubAllGlobals()

    mockFetch({
      '/api/prism.transfer/import': () => ({ body: { jobId: 'jd2' } }),
    })
    cleanup()
    renderPage({ picker: fakePicker(null) })
    fireEvent.click(screen.getByText('Change…'))
    expect(screen.getByText('Default ~/.prism/projects')).toBeDefined()
    vi.unstubAllGlobals()
  })

  it('reports an unexpected import response and a non-Error import rejection', async () => {
    mockFetch({
      '/api/prism.transfer/import': () => ({ body: { unexpected: true } }),
    })
    renderPage()
    chooseFile('weird.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(screen.getByText('The service returned an unrecognized response.')).toBeDefined()
    })
    vi.unstubAllGlobals()

    mockFetch({
      '/api/prism.transfer/import': () => Promise.reject('upload offline'),
    })
    cleanup()
    renderPage()
    chooseFile('weird.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(screen.getByText('upload offline')).toBeDefined()
    })
    vi.unstubAllGlobals()

    mockFetch({
      '/api/prism.transfer/import': () => new Response('not json either', { status: 200 }),
    })
    cleanup()
    renderPage()
    chooseFile('weird.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(screen.getByText('The service returned an unrecognized response.')).toBeDefined()
    })
    vi.unstubAllGlobals()
  })

  it('renders done outcomes only from the fields they carry', async () => {
    mockFetch({
      '/api/prism.transfer/import': () => ({ body: { jobId: 'jr1' } }),
      '/api/prism.transfer/job': () => ({
        status: 200,
        body: {
          jobId: 'jr1', kind: 'project', state: 'done', phase: 'done', name: 'plain.zip',
          archiveBytes: 10, files: 1, bytes: 5, sessionsDone: 2, sessionsTotal: 2,
          projectsDone: 1, projectsTotal: 1,          skippedSecrets: 0, startedAt: 1,
          result: {
            projects: [{ name: 'Alpha', path: '/p/Alpha', sessions: 2, duplicates: 0 }],
            settings: [{ ns: 'web', outcome: 'applied' }],
          },
        },
      }),
    })
    renderPage()
    chooseFile('plain.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(screen.getByText('Import finished')).toBeDefined()
    }, { timeout: 5000 })
    expect(screen.getByText('2 sessions restored')).toBeDefined()
    // Only the summary line reports duplicates; the per-project line hides at zero.
    expect(screen.getAllByText('0 existing sessions skipped')).toHaveLength(1)
    expect(screen.getByText('Settings: 1 applied')).toBeDefined()
    expect(screen.queryByText(/, 0 skipped/)).toBeNull()
    vi.unstubAllGlobals()

    mockFetch({
      '/api/prism.transfer/import': () => ({ body: { jobId: 'jr2' } }),
      '/api/prism.transfer/job': () => ({
        status: 200,
        body: {
          jobId: 'jr2', kind: 'project', state: 'done', phase: 'done', name: 'warn.zip',
          archiveBytes: 10, files: 0, bytes: 0, sessionsDone: 0, sessionsTotal: 0,
          projectsDone: 0, projectsTotal: 0,          skippedSecrets: 0, startedAt: 1,
          result: {
            projects: [{ name: 'Alpha', path: '/p/Alpha', sessions: 1, duplicates: 0, registerError: 'registry is read-only' }],
          },
        },
      }),
    })
    cleanup()
    renderPage()
    chooseFile('warn.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      expect(screen.getByText('Files restored, but registration failed: registry is read-only')).toBeDefined()
    }, { timeout: 5000 })
    vi.unstubAllGlobals()

    const noResultMock = mockFetch({
      '/api/prism.transfer/import': () => ({ body: { jobId: 'jr3' } }),
      '/api/prism.transfer/job': () => ({
        status: 200,
        body: {
          jobId: 'jr3', kind: 'project', state: 'done', phase: 'done', name: 'noresult.zip',
          archiveBytes: 10, files: 0, bytes: 0, sessionsDone: 0, sessionsTotal: 0,
          projectsDone: 0, projectsTotal: 0,          skippedSecrets: 0, startedAt: 1,
        },
      }),
    })
    cleanup()
    renderPage()
    chooseFile('noresult.zip')
    fireEvent.click(screen.getByText('Start import'))
    await waitFor(() => {
      // The done state itself renders nothing until a result block arrives.
      expect(noResultMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    }, { timeout: 5000 })
    expect(screen.queryByText('Import finished')).toBeNull()
    expect(screen.queryByText(/Selected:/)).toBeNull()
    vi.unstubAllGlobals()
  })
})
