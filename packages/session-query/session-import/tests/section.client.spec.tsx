// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportSection, type ImportSectionProps } from '../src/client/ImportSection.tsx'
import { en } from '../src/client/locales.ts'

const candidates = [
  {
    id: 'claude', label: 'Claude Code', root: 'C:\\fixtures\\claude', available: true,
    sessionCount: 2, bytes: 2048, latestAt: Date.parse('2026-01-02T00:00:00.000Z'),
  },
  {
    id: 'codex', label: 'Codex', root: 'C:\\fixtures\\codex', available: false,
    reason: 'not-found', sessionCount: 0, bytes: 0,
  },
]

const mergePlan = {
  source: 'claude',
  groups: [{
    path: 'C:\\work\\project',
    title: 'project',
    sessions: [
      { key: 'one', createdAt: 1, updatedAt: 2 },
      { key: 'two', createdAt: 3, updatedAt: 4 },
    ],
    existingWorkspace: { id: 'ws-1', title: 'project', sessionCount: 7 },
    merge: true,
  }],
  skipped: [],
}

const applied = {
  results: [
    { key: 'one', outcome: 'imported', sessionId: 'session-import-1' },
    { key: 'two', outcome: 'imported', sessionId: 'session-import-2' },
  ],
  workspaces: [{ path: 'C:\\work\\project', workspaceId: 'ws-1', created: false, imported: 2 }],
}

function translate(key: keyof typeof en, params?: Record<string, unknown>): string {
  return en[key].replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  })
}

function requestInput(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

const props = { close: () => {}, t: translate } as ImportSectionProps

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ImportSection', () => {
  it('lists sources, previews projects, and requires confirmation before merging', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestInput(input)
      if (url.endsWith('candidates')) return new Response(JSON.stringify(candidates))
      return new Response(JSON.stringify(mergePlan))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ImportSection {...props} />)
    expect(await screen.findByText('Claude Code')).toBeTruthy()
    expect(screen.getByText('Codex')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Claude Code/ }))
    expect(await screen.findByText(en.dryRun)).toBeTruthy()
    expect(screen.getByText('C:\\work\\project')).toBeTruthy()
    expect(screen.getByText(en.mergeBadge.replace('{count}', '7'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.importButton }))
    const dialog = await screen.findByRole('dialog', { name: en.mergeTitle })
    expect(dialog).toBeTruthy()
    const confirm = screen.getByRole('button', { name: en.confirmImport }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    fireEvent.click(screen.getByLabelText(en.mergeAck))
    expect(confirm.disabled).toBe(false)
  })

  it('imports without a dialog when no selected project exists yet', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : ''
      calls.push(body)
      if (body === '') return new Response(JSON.stringify(candidates))
      const request = JSON.parse(body) as { op: string }
      return new Response(JSON.stringify(request.op === 'plan'
        ? { ...mergePlan, groups: [{ ...mergePlan.groups[0], existingWorkspace: undefined, merge: false }] }
        : applied))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ImportSection {...props} />)
    await screen.findByText('Claude Code')
    fireEvent.click(screen.getByRole('button', { name: /Claude Code/ }))
    await screen.findByText(en.dryRun)
    fireEvent.click(screen.getByRole('button', { name: en.importButton }))
    await waitFor(() => { expect(screen.getByText(en.resultTitle)).toBeTruthy() })
    expect(screen.queryByRole('dialog', { name: en.mergeTitle })).toBeNull()
    expect(calls.at(-1)).not.toContain('"confirmMerge":true')
  })
})
