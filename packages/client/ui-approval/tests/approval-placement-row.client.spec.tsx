// @vitest-environment jsdom
// PRISM-DIVERGENCE: replay list in docs/compose/spec/approval-panel.md (S5).
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalPlacementRow, type ApprovalPlacementRowProps } from '../src/client/ApprovalPlacementRow.tsx'
import type { ApprovalPlacement } from '../src/client/placement.ts'

const messages: Record<string, string> = {
  'settings.title': 'Where approvals are answered',
  'settings.description': 'Reject and Allow once appear here.',
  'settings.progress': 'Progress panel',
  'settings.list': 'Session list',
}

function rowProps(placement: ApprovalPlacement, setPlacement = vi.fn()): ApprovalPlacementRowProps {
  return {
    usePlacement: selector => selector(placement),
    setPlacement,
    t: (key: string) => messages[key] ?? key,
  } as ApprovalPlacementRowProps
}

afterEach(() => { cleanup() })

describe('ApprovalPlacementRow', () => {
  it('shows the preference with its explanation and both places', () => {
    render(<ApprovalPlacementRow {...rowProps('progress')} />)

    expect(screen.getByText('Where approvals are answered')).toBeTruthy()
    expect(screen.getByText('Reject and Allow once appear here.')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Progress panel', selected: true })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Session list', selected: false })).toBeTruthy()
  })

  it('writes the chosen place and leaves the current one alone', () => {
    const setPlacement = vi.fn()
    render(<ApprovalPlacementRow {...rowProps('progress', setPlacement)} />)

    fireEvent.click(screen.getByRole('tab', { name: 'Session list' }))
    expect(setPlacement).toHaveBeenCalledWith('list')

    fireEvent.click(screen.getByRole('tab', { name: 'Progress panel' }))
    expect(setPlacement).toHaveBeenCalledTimes(1)
  })

  it('reflects a placement changed elsewhere in the window', () => {
    const props = rowProps('progress')
    const view = render(<ApprovalPlacementRow {...props} />)
    expect(screen.getByRole('tab', { name: 'Progress panel', selected: true })).toBeTruthy()

    view.rerender(<ApprovalPlacementRow {...rowProps('list')} />)
    expect(screen.getByRole('tab', { name: 'Session list', selected: true })).toBeTruthy()
  })
})
