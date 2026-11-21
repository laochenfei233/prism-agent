// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { TurnUsagePanel } from '../src/client/chat/TurnUsagePanel.tsx'
import type { UnitPriceOverrides } from '../src/client/contract/usage.ts'
import type { TurnTokenUsage } from '../src/client/contract/chat-nodes.ts'
import { en } from '../src/client/locale.ts'

const t = makeTranslate(en, commonEn)

/** Off-peak Monday (UTC): the turn end time every unpriced case uses. */
const AT = Date.UTC(2026, 10, 2, 5, 0, 0)

afterEach(cleanup)

function renderPanel(usage: TurnTokenUsage, overrides: UnitPriceOverrides = {}) {
  return render(<TurnUsagePanel usage={usage} at={AT} overrides={overrides} t={t} />)
}

describe('TurnUsagePanel', () => {
  it('shows an icon-and-total pill and opens the usage dialog on click', () => {
    const usage: TurnTokenUsage = {
      uncachedInputTokens: 5_060,
      cacheReadTokens: 4_940,
      cacheWriteTokens: 0,
      outputTokens: 5_800,
      reasoningTokens: 42,
      totalTokens: 15_800,
      routes: [{ provider: 'deepseek', model: 'deepseek-chat' }],
    }
    const view = renderPanel(usage)

    const trigger = view.getByRole('button')
    expect(trigger.textContent).toBe('Usage 15.8K tok')
    expect(trigger.querySelector('svg')).not.toBeNull()
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByRole('dialog')).toBeNull()

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const dialog = view.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('Turn usage')
    // Portaled out of the trigger's row, with a heading row carrying the total.
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog.firstChild?.textContent).toBe('Turn usage15,800 tok')
    const details = dialog.querySelector('[data-turn-usage-details]') as HTMLElement
    expect(details).toBeTruthy()
    expect(details.textContent).toContain('Provider / modeldeepseek/deepseek-chat')
    expect(details.textContent).toContain('Cache hit49.4%')
    expect(details.textContent).toContain('Uncached input5,060 tok')
    expect(details.textContent).toContain('Cached input4,940 tok')
    expect(details.textContent).toContain('Cache write0 tok')
    expect(details.textContent).toContain('Output5,800 tok (42 tok reasoning)')
    expect(details.textContent).not.toContain('Total')
    // An unlisted model has no price, so the accounting stays token-only.
    expect(details.textContent).not.toContain('Cost')
  })

  it('prices a single-route Turn at its end-time tier', () => {
    const usage: TurnTokenUsage = {
      uncachedInputTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
    }
    const view = renderPanel(usage)
    const trigger = view.getByRole('button')
    expect(trigger.textContent).toBe('Usage 2M tok · ≈$0.75')
    fireEvent.click(trigger)
    const cost = view.getByRole('dialog').querySelector('[data-turn-usage-cost]') as HTMLElement
    expect(cost.textContent).toBe('≈$0.75')
  })

  it('uses a stored custom price in place of the built-in one', () => {
    const usage: TurnTokenUsage = {
      uncachedInputTokens: 1_000_000,
      outputTokens: 0,
      totalTokens: 1_000_000,
      routes: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
    }
    const view = renderPanel(usage, { 'deepseek-flash': { miss: 2, hit: 0, output: 0 } })
    expect(view.getByRole('button').textContent).toBe('Usage 1M tok · ≈$2.00')
  })

  it('omits unavailable optional facts instead of inventing values', () => {
    const usage: TurnTokenUsage = {
      uncachedInputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    }
    const view = renderPanel(usage)

    const trigger = view.getByRole('button')
    expect(trigger.textContent).toBe('Usage 150 tok')
    fireEvent.click(trigger)
    expect(view.queryByText('Provider / model')).toBeNull()
    expect(view.queryByText('Cache hit')).toBeNull()
    expect(view.queryByText('Cached input')).toBeNull()
    expect(view.queryByText('Cache write')).toBeNull()
    expect(view.queryByText(/reasoning/)).toBeNull()
  })

  it('keeps a partial cache hit below 100 in the dialog and closes on Escape or outside pointerdown', () => {
    const usage: TurnTokenUsage = {
      uncachedInputTokens: 1,
      cacheReadTokens: 999,
      outputTokens: 100,
      totalTokens: 1_100,
    }
    const view = renderPanel(usage)
    const trigger = view.getByRole('button')
    // The pill carries the compact total; cache-hit rate and exact token
    // counts stay in the dialog.
    expect(trigger.textContent).toBe('Usage 1.1K tok')

    fireEvent.click(trigger)
    const dialog = view.getByRole('dialog')
    expect(dialog.textContent).toContain('Cache hit99.9%')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    // A pointerdown inside the panel keeps it open; one outside closes it.
    fireEvent.pointerDown(view.getByRole('dialog'))
    expect(view.queryByRole('dialog')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('closes on an outside click without pointerdown, as keyboard activation elsewhere fires', () => {
    const view = renderPanel({ uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 })
    fireEvent.click(view.getByRole('button'))
    fireEvent.click(view.getByRole('dialog'))
    expect(view.queryByRole('dialog')).toBeTruthy()
    fireEvent.click(document.body)
    expect(view.queryByRole('dialog')).toBeNull()
  })
})
