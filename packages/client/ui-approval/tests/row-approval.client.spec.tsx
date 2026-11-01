// @vitest-environment jsdom
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPendingInteraction, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RowApproval, type RowApprovalProps } from '../src/client/RowApproval.tsx'
import { PendingApproval } from '../src/client/contract/slots.ts'

const id = (value: string): SessionId => value as SessionId

const messages: Record<string, string> = {
  waiting: 'Waiting',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requests privileged execution',
  reject: 'Reject',
  allowOnce: 'Allow once',
  'rejectFor': 'Reject for {title}',
  'allowOnceFor': 'Allow once for {title}',
}

function rowProps(
  pending: SessionPendingInteraction | undefined,
  overrides: Partial<RowApprovalProps> = {},
): RowApprovalProps {
  const sessionId = id('s1')
  const snapshot: SessionStatusSnapshot = new Map([[sessionId, {
    running: false, pendingInteraction: pending, completionUnread: false,
  }]])
  return {
    sessionId,
    displayTitle: 'Notes session',
    useSessionStatus: selector => selector(snapshot),
    resolveReason: (reason: NonNullable<PendingApproval['displayReason']>) => reason.en,
    t: (key: string, params?: Record<string, string>) => {
      const template = messages[key] ?? key
      return Object.entries(params ?? {}).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, value),
        template,
      )
    },
    ...overrides,
  } as RowApprovalProps
}

afterEach(() => { cleanup() })

describe('RowApproval', () => {
  it('renders the requester summary and both decisions for the waiting Session', () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'write', reason: 'Write notes.txt' })
    render(<RowApproval {...rowProps(pending)} />)

    expect(screen.getByText('Write notes.txt')).toBeTruthy()
    expect(document.querySelector('[data-row-approval="write"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Reject for Notes session' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow once for Notes session' })).toBeTruthy()
  })

  it('prefers requester-owned presentation copy and falls back to the tool copy', () => {
    const localized = new PendingApproval(id('s1'), {
      toolName: 'bash',
      reason: 'audit reason',
      displayReason: { en: 'English explanation', zh: '中文说明' },
    })
    const view = render(<RowApproval {...rowProps(localized)} />)
    expect(screen.getByText('English explanation')).toBeTruthy()
    expect(screen.queryByText('audit reason')).toBeNull()
    view.rerender(<RowApproval {...rowProps(localized, { resolveReason: reason => reason['zh']! })} />)
    expect(screen.getByText('中文说明')).toBeTruthy()

    const bare = new PendingApproval(id('s1'), { toolName: 'read' })
    view.rerender(<RowApproval {...rowProps(bare)} />)
    expect(screen.getByText('Tool read requests privileged execution')).toBeTruthy()
  })

  it('renders nothing for a Session waiting on another interaction or on none', () => {
    const question = { key: 'question:1', kind: 'question', sessionId: id('s1') } as SessionPendingInteraction
    const view = render(<RowApproval {...rowProps(question)} />)
    expect(view.container.innerHTML).toBe('')
    view.rerender(<RowApproval {...rowProps(undefined)} />)
    expect(view.container.innerHTML).toBe('')
  })

  it('keeps a decision click out of the row that contains it', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'write', reason: 'Write notes.txt' })
    const openRow = vi.fn()
    render(<div onClick={openRow}><RowApproval {...rowProps(pending)} /></div>)

    fireEvent.click(screen.getByRole('button', { name: 'Allow once for Notes session' }))

    expect(openRow).not.toHaveBeenCalled()
    await expect(pending.result).resolves.toBe('allowed-once')
  })

  it('answers the pending request from the row and locks both decisions', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'write', reason: 'Write notes.txt' })
    render(<RowApproval {...rowProps(pending)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow once for Notes session' }))

    expect(document.querySelector('[data-row-approval="write"]')?.getAttribute('aria-busy')).toBe('true')
    await expect(pending.result).resolves.toBe('allowed-once')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reject for Notes session' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once for Notes session' }).disabled).toBe(true)
  })

  it('returns rejection and refuses a second decision from the same line', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'write' })
    const answer = vi.spyOn(pending, 'answer')
    render(<RowApproval {...rowProps(pending)} />)

    const reject = screen.getByRole('button', { name: 'Reject for Notes session' })
    fireEvent.click(reject)
    fireEvent.click(reject)

    expect(answer).toHaveBeenCalledExactlyOnceWith('rejected')
    await expect(pending.result).resolves.toBe('rejected')
  })

  it('re-enables both decisions when the settlement fails', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'write' })
    vi.spyOn(pending, 'answer').mockRejectedValue(new Error('transport closed'))
    render(<RowApproval {...rowProps(pending)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Allow once for Notes session' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once for Notes session' }).disabled).toBe(true)
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once for Notes session' }).disabled).toBe(false)
    })
    expect(document.querySelector('[data-row-approval="write"]')?.getAttribute('aria-busy')).toBe('false')
    pending.abort(new Error('test cleanup'))
    await pending.result.catch(() => {})
  })

  it('ignores a settlement failure that arrives after the line unmounted', async () => {
    const pending = new PendingApproval(id('s1'), { toolName: 'write' })
    const gate = Promise.withResolvers<undefined>()
    vi.spyOn(pending, 'answer').mockImplementation(() => gate.promise)
    const view = render(<RowApproval {...rowProps(pending)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once for Notes session' }))
    view.unmount()

    await act(async () => {
      gate.reject(new Error('late transport failure'))
      await gate.promise.catch(() => {})
    })

    pending.abort(new Error('test cleanup'))
    await pending.result.catch(() => {})
  })

  it('remounts for a replacement request so the previous answer never leaks', async () => {
    const first = new PendingApproval(id('s1'), { toolName: 'write', reason: 'First request' })
    const view = render(<RowApproval {...rowProps(first)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once for Notes session' }))
    await expect(first.result).resolves.toBe('allowed-once')

    const second = new PendingApproval(id('s1'), { toolName: 'edit', reason: 'Second request' })
    view.rerender(<RowApproval {...rowProps(second)} />)

    expect(screen.getByText('Second request')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once for Notes session' }).disabled).toBe(false)
    second.abort(new Error('test cleanup'))
    await second.result.catch(() => {})
  })
})
