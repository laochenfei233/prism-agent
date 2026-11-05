// @vitest-environment jsdom
/** The 数据 section: its tabs, the storage card, and the change dialog. */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { DataSection, type DataSectionProps } from '../src/client/DataSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = makeTranslate(en)

/**
 * Answer data-route calls from one script.
 * @param replies - per-action response bodies and statuses.
 * @returns the fetch stub.
 */
function stubFetch(replies: {
  state?: { body: unknown; status?: number }
  relocate?: { body: unknown; status?: number }
  reset?: { body: unknown; status?: number }
}): ReturnType<typeof vi.fn> {
  const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
    const raw = typeof init.body === 'string' ? init.body : '{}'
    const body = JSON.parse(raw) as { action: keyof typeof replies }
    const reply = replies[body.action] ?? { body: {} }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchStub)
  return fetchStub
}

/**
 * Render the section with stub slots.
 * @param options - picker behavior and an already-installed fetch stub.
 * @returns the picker stub.
 */
function renderSection(options: {
  fetch?: ReturnType<typeof vi.fn>
  pick?: () => Promise<string | null>
} = {}): { pick: ReturnType<typeof vi.fn> } {
  if (options.fetch === undefined) {
    stubFetch({ state: { body: { ok: true, value: { root: '/data/home', pointerPath: '/home/.prism-data-home' } } } })
  }
  const pick = vi.fn(options.pick ?? (async () => null))
  const renderSlot = vi.fn<DataSectionProps['renderSlot']>((_name, _props, opts): ReactNode =>
    <div data-testid={`slot-${opts?.only ?? 'all'}`} />)
  const props = {
    t,
    renderSlot,
    pickDirectory: pick,
  } as DataSectionProps
  render(<DataSection {...props} />)
  return { pick }
}

describe('DataSection', () => {
  it('opens on the storage tab and shows the running data directory', async () => {
    renderSection()
    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByRole('tab', { name: en.tabStorage }).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByText('/data/home')).toBeTruthy()
    expect(screen.getByText(en.locationHint)).toBeTruthy()
  })

  it('switches tabs and keeps a visited page mounted while hidden', async () => {
    renderSection()
    await screen.findByText('/data/home')
    expect(screen.queryByTestId('slot-backup')).toBeNull()
    const storagePanel = screen.getByText('/data/home').closest('[role="tabpanel"]')
    expect(storagePanel?.hasAttribute('hidden')).toBe(false)

    fireEvent.click(screen.getByRole('tab', { name: en.tabBackup }))
    expect(screen.getByTestId('slot-backup')).toBeTruthy()
    expect(screen.queryByTestId('slot-transfer')).toBeNull()
    expect(storagePanel?.hasAttribute('hidden')).toBe(true)
    expect(screen.getByTestId('slot-backup').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(false)

    fireEvent.click(screen.getByRole('tab', { name: en.tabTransfer }))
    expect(screen.getByTestId('slot-transfer')).toBeTruthy()
    expect(screen.getByTestId('slot-cross-agent')).toBeTruthy()
    // A visited tab stays mounted while hidden, so staged work survives.
    expect(screen.getByTestId('slot-backup')).toBeTruthy()
    expect(screen.getByTestId('slot-backup').closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(true)
  })

  it('copies the data to a typed destination and reports the restart', async () => {
    const fetchStub = stubFetch({
      state: { body: { ok: true, value: { root: '/data/home', pointerPath: '/home/.prism-data-home' } } },
      relocate: { body: { ok: true, value: { target: '/moved/data', previousRoot: '/data/home', files: 12, bytes: 2_048, skippedLinks: [] } } },
    })
    const { pick } = renderSection({ fetch: fetchStub })
    await screen.findByText('/data/home')

    fireEvent.click(screen.getByRole('button', { name: en.change }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.targetLabel), { target: { value: '/moved/data' } })
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))

    await screen.findByText(en.doneTitle)
    expect(screen.getByText(en.restartHint)).toBeTruthy()
    expect(fetchStub).toHaveBeenCalledWith('/api/prism.data', expect.objectContaining({ method: 'POST' }))
    expect(pick).not.toHaveBeenCalled()
  })

  it('takes the destination from the folder picker and reports a picker that is absent', async () => {
    const { pick } = renderSection({ pick: async () => '/picked/data' })
    await screen.findByText('/data/home')
    fireEvent.click(screen.getByRole('button', { name: en.change }))
    fireEvent.click(screen.getByRole('button', { name: en.chooseFolder }))
    await waitFor(() => { expect(screen.getByLabelText(en.targetLabel)).toHaveProperty('value', '/picked/data') })
    expect(pick).toHaveBeenCalledOnce()
  })

  it('keeps the field usable when the picker throws', async () => {
    renderSection({ pick: async () => { throw new Error('no picker') } })
    await screen.findByText('/data/home')
    fireEvent.click(screen.getByRole('button', { name: en.change }))
    fireEvent.click(screen.getByRole('button', { name: en.chooseFolder }))
    await screen.findByText(en.pickerUnavailable)
  })

  it('renders the typed refusal as copy and keeps the dialog open', async () => {
    const fetchStub = stubFetch({
      state: { body: { ok: true, value: { root: '/data/home', pointerPath: '/home/.prism-data-home' } } },
      relocate: { body: { ok: false, error: { code: 'prism-data/target-not-empty', message: 'not empty' } }, status: 409 },
    })
    renderSection({ fetch: fetchStub })
    await screen.findByText('/data/home')
    fireEvent.click(screen.getByRole('button', { name: en.change }))
    fireEvent.change(screen.getByLabelText(en.targetLabel), { target: { value: '/moved/data' } })
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    expect(await screen.findByText(en.codeTargetNotEmpty)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('reports a pending launch and clears a stored location on request', async () => {
    const fetchStub = stubFetch({
      state: {
        body: {
          ok: true,
          value: {
            root: '/data/home',
            pointerPath: '/home/.prism-data-home',
            storedRoot: '/moved/data',
            pendingRoot: '/moved/data',
          },
        },
      },
      reset: { body: { ok: true, value: { root: '/data/home', pointerPath: '/home/.prism-data-home' } } },
    })
    renderSection({ fetch: fetchStub })
    expect(await screen.findByText(/\/moved\/data/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.reset }))
    await waitFor(() => {
      expect(fetchStub).toHaveBeenCalledWith('/api/prism.data', expect.objectContaining({ body: JSON.stringify({ action: 'reset' }) }))
    })
    await waitFor(() => { expect(screen.queryByRole('button', { name: en.reset })).toBeNull() })
  })

  it('shows a transport failure instead of the location', async () => {
    const fetchStub = stubFetch({ state: { body: { ok: false, error: { code: 'unknown', message: 'host down' } }, status: 500 } })
    renderSection({ fetch: fetchStub })
    expect(await screen.findByText('host down')).toBeTruthy()
  })

  it('shows a network failure as its own sentence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    renderSection({ fetch: vi.mocked(globalThis.fetch) as ReturnType<typeof vi.fn> })
    expect(await screen.findByText('offline')).toBeTruthy()
  })

  it('keeps the field empty when the picker is cancelled', async () => {
    renderSection({ pick: async () => null })
    await screen.findByText('/data/home')
    fireEvent.click(screen.getByRole('button', { name: en.change }))
    fireEvent.click(screen.getByRole('button', { name: en.chooseFolder }))
    await waitFor(() => { expect(screen.getByLabelText(en.targetLabel)).toHaveProperty('value', '') })
    expect(screen.queryByText(en.pickerUnavailable)).toBeNull()
  })

  it('localizes a copy failure that carries the Host sentence', async () => {
    const fetchStub = stubFetch({
      state: { body: { ok: true, value: { root: '/data/home', pointerPath: '/home/.prism-data-home' } } },
      relocate: { body: { ok: false, error: { code: 'prism-data/copy-failed', message: 'disk full' } }, status: 500 },
    })
    renderSection({ fetch: fetchStub })
    await screen.findByText('/data/home')
    fireEvent.click(screen.getByRole('button', { name: en.change }))
    fireEvent.change(screen.getByLabelText(en.targetLabel), { target: { value: '/moved/data' } })
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    expect(await screen.findByText(en.codeCopyFailed.replace('{message}', 'disk full'))).toBeTruthy()
  })

  it('reports a skipped link and the kept previous directory after a copy', async () => {
    const fetchStub = stubFetch({
      state: { body: { ok: true, value: { root: '/data/home', pointerPath: '/home/.prism-data-home' } } },
      relocate: {
        body: {
          ok: true,
          value: {
            target: '/moved/data',
            previousRoot: '/data/home',
            files: 2,
            bytes: 1_024,
            skippedLinks: ['/data/home/node_modules'],
          },
        },
      },
    })
    renderSection({ fetch: fetchStub })
    await screen.findByText('/data/home')
    fireEvent.click(screen.getByRole('button', { name: en.change }))
    fireEvent.change(screen.getByLabelText(en.targetLabel), { target: { value: '/moved/data' } })
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    await screen.findByText(en.doneTitle)
    expect(screen.getByText(/\/data\/home\/node_modules/)).toBeTruthy()
    expect(screen.getByText(en.donePrevious.replace('{previous}', '/data/home'))).toBeTruthy()
  })

  it('reports a failed reset in the card while the dialog stays closed', async () => {
    const fetchStub = stubFetch({
      state: {
        body: {
          ok: true,
          value: { root: '/data/home', pointerPath: '/home/.prism-data-home', storedRoot: '/moved/data' },
        },
      },
      reset: { body: { ok: false, error: { code: 'prism-data/busy', message: 'still copying' } }, status: 409 },
    })
    renderSection({ fetch: fetchStub })
    await screen.findByText('/data/home')
    fireEvent.click(await screen.findByRole('button', { name: en.reset }))
    expect(await screen.findByText(en.codeBusy)).toBeTruthy()
  })

  it('drops a location answer that arrives after unmount', async () => {
    const reply = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn(() => reply.promise))
    renderSection({ fetch: vi.mocked(globalThis.fetch) as ReturnType<typeof vi.fn> })
    cleanup()
    reply.resolve(new Response(JSON.stringify({ ok: true, value: { root: '/late', pointerPath: '/p' } }), { status: 200 }))
    await Promise.resolve()
    expect(screen.queryByText('/late')).toBeNull()
  })

  it('drops a load failure that arrives after unmount', async () => {
    const reply = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn(() => reply.promise))
    renderSection({ fetch: vi.mocked(globalThis.fetch) as ReturnType<typeof vi.fn> })
    cleanup()
    reply.reject(new Error('late failure'))
    await Promise.resolve()
    expect(screen.queryByText('late failure')).toBeNull()
  })

  it.each([
    ['prism-data/target-invalid', en.codeTargetInvalid],
    ['prism-data/pointer-failed', en.codePointerFailed.replace('{message}', 'denied')],
    ['prism-data/bad-request', en.codeBadRequest],
  ])('localizes the %s refusal', async (code, expected) => {
    const fetchStub = stubFetch({
      state: { body: { ok: true, value: { root: '/data/home', pointerPath: '/home/.prism-data-home' } } },
      relocate: { body: { ok: false, error: { code, message: 'denied' } }, status: 400 },
    })
    renderSection({ fetch: fetchStub })
    await screen.findByText('/data/home')
    fireEvent.click(screen.getByRole('button', { name: en.change }))
    fireEvent.change(screen.getByLabelText(en.targetLabel), { target: { value: '/moved/data' } })
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    expect(await screen.findByText(expected)).toBeTruthy()
  })

  it('closes the dialog from its own control and from the cancel button', async () => {
    renderSection()
    await screen.findByText('/data/home')
    fireEvent.click(screen.getByRole('button', { name: en.change }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    // The dialog's close control comes first; the footer button carries the same label.
    fireEvent.click(screen.getAllByRole('button', { name: en.cancel })[0] as HTMLElement)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })

    fireEvent.click(screen.getByRole('button', { name: en.change }))
    fireEvent.click(screen.getAllByRole('button', { name: en.cancel }).at(-1) as HTMLElement)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('refuses to close the dialog while a copy runs', async () => {
    const reply = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { action: string }
      if (body.action === 'relocate') return reply.promise
      return Promise.resolve(new Response(JSON.stringify({
        ok: true, value: { root: '/data/home', pointerPath: '/home/.prism-data-home' },
      }), { status: 200 }))
    }))
    renderSection({ fetch: vi.mocked(globalThis.fetch) as ReturnType<typeof vi.fn> })
    await screen.findByText('/data/home')
    fireEvent.click(screen.getByRole('button', { name: en.change }))
    fireEvent.change(screen.getByLabelText(en.targetLabel), { target: { value: '/moved/data' } })
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    await screen.findByRole('button', { name: en.copying })
    fireEvent.click(screen.getAllByRole('button', { name: en.cancel })[0] as HTMLElement)
    expect(screen.getByRole('dialog')).toBeTruthy()
    reply.resolve(new Response(JSON.stringify({
      ok: true,
      value: { target: '/moved/data', previousRoot: '/data/home', files: 1, bytes: 10, skippedLinks: [] },
    }), { status: 200 }))
    await screen.findByText(en.doneTitle)
  })

  it('keeps the dialog open while a copy runs', async () => {
    const reply = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { action: string }
      if (body.action === 'relocate') return reply.promise
      return Promise.resolve(new Response(JSON.stringify({
        ok: true, value: { root: '/data/home', pointerPath: '/home/.prism-data-home' },
      }), { status: 200 }))
    }))
    renderSection({ fetch: vi.mocked(globalThis.fetch) as ReturnType<typeof vi.fn> })
    await screen.findByText('/data/home')
    fireEvent.click(screen.getByRole('button', { name: en.change }))
    fireEvent.change(screen.getByLabelText(en.targetLabel), { target: { value: '/moved/data' } })
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    expect(await screen.findByRole('button', { name: en.copying })).toHaveProperty('disabled', true)
    reply.resolve(new Response(JSON.stringify({
      ok: true,
      value: { target: '/moved/data', previousRoot: '/data/home', files: 1, bytes: 10, skippedLinks: [] },
    }), { status: 200 }))
    await screen.findByText(en.doneTitle)
  })

  it('answers an unrecognized success body as a response failure', async () => {
    const fetchStub = vi.fn(async () => new Response('null', { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    renderSection({ fetch: fetchStub })
    expect(await screen.findByText(en.unexpectedResponse)).toBeTruthy()
  })
})
