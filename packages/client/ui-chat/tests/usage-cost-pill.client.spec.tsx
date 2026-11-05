// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { UsageCostPillProps } from '../src/client/chat/UsageCostPill.tsx'
import { UsageCostPill } from '../src/client/chat/UsageCostPill.tsx'
import type { UnitPriceOverrides } from '../src/client/contract/usage.ts'
import { en } from '../src/client/locale.ts'

const t = makeTranslate(en, commonEn)

/** Off-peak Monday (UTC) instant the pill prices at, via the logged settlement time. */
const OFF_PEAK = new Date('2026-11-02T05:00:00Z')
/** Peak Monday (UTC) instant inside the 01:00–04:00 window. */
const PEAK = new Date('2026-11-02T02:30:00Z')

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const USAGE: TokenUsageProjection = {
  uncachedInputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 1_000_000,
  lastSettledAt: OFF_PEAK.getTime(),
}

function props(
  usage: TokenUsageProjection | undefined,
  model: string | undefined,
  overrides: UnitPriceOverrides = {},
  setUnitPrice = vi.fn(),
): UsageCostPillProps {
  const selection = model === undefined ? null : { provider: 'deepseek-official', model }
  function useProjection(key: string): unknown {
    if (key === 'tokenUsage') return usage
    if (key === 'modelSelection') return { lastUsed: selection, next: selection }
    return undefined
  }
  function useUnitPrices<T>(select: (value: UnitPriceOverrides) => T): T {
    return select(overrides)
  }
  return { sessionId: 'session' as SessionId, useProjection, useUnitPrices, setUnitPrice, t } as UsageCostPillProps
}

describe('UsageCostPill', () => {
  it('renders nothing without billable usage, an unpriced pill while no price is recorded', () => {
    const empty = render(<UsageCostPill {...props(undefined, 'deepseek-flash')} />)
    expect(empty.container.innerHTML).toBe('')
    cleanup()
    const unpriced = render(<UsageCostPill {...props(USAGE, 'unlisted')} />)
    const trigger = unpriced.getByRole('button', { name: 'No unit price recorded for unlisted' })
    expect(trigger.textContent).toBe('No price yet')
    fireEvent.click(trigger)
    // The dashboard still offers the editor, so the model can be priced from here.
    expect(unpriced.getByRole('dialog').querySelector('[data-usage-price-editor="unlisted"]')).toBeTruthy()
  })

  it('shows the estimated session cost and opens the dashboard', () => {
    // The wall clock sits in a peak window; the estimate must price at the
    // logged off-peak settlement instant, not the render-time clock.
    vi.useFakeTimers()
    vi.setSystemTime(PEAK)
    const view = render(<UsageCostPill {...props(USAGE, 'deepseek-flash')} />)
    const trigger = view.getByRole('button', { name: 'Estimated cost for this session: $0.75' })
    expect(trigger.textContent).toBe('≈$0.75')
    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const dialog = view.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('Usage and cost')
    expect(dialog.textContent).toContain('$0.75')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('prices the tier at the logged settlement instant even when the clock disagrees', () => {
    vi.useFakeTimers()
    vi.setSystemTime(OFF_PEAK)
    const settledAtPeak = { ...USAGE, lastSettledAt: PEAK.getTime() }
    const view = render(<UsageCostPill {...props(settledAtPeak, 'deepseek-flash')} />)
    expect(view.getByRole('button', { name: 'Estimated cost for this session: $1.50' })).toBeDefined()
  })

  it('prices with a stored custom price and forwards the editor write', () => {
    vi.useFakeTimers()
    vi.setSystemTime(PEAK)
    const setUnitPrice = vi.fn()
    const view = render(<UsageCostPill {...props(USAGE, 'deepseek-flash', { 'deepseek-flash': { miss: 2, hit: 0, output: 0 } }, setUnitPrice)} />)
    expect(view.getByRole('button', { name: 'Estimated cost for this session: $2.00' })).toBeDefined()
    fireEvent.click(view.getByRole('button'))
    const dialog = view.getByRole('dialog')
    expect(dialog.querySelector('[data-usage-price-editor="deepseek-flash"]')).toBeTruthy()
    fireEvent.change(dialog.querySelectorAll('input')[0]!, { target: { value: '3' } })
    fireEvent.click(view.getByRole('button', { name: 'Save' }))
    expect(setUnitPrice).toHaveBeenCalledWith('deepseek-flash', { miss: 3, hit: 0, output: 0 })
  })
})
