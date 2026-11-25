// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { UsageDashboard } from '../src/client/chat/UsageDashboard.tsx'
import type { UsageCost } from '../src/client/chat/usage-pricing.ts'
import type { UnitPriceOverrides } from '../src/client/contract/usage.ts'
import { en } from '../src/client/locale.ts'

const t = makeTranslate(en, commonEn)

/** Off-peak estimate for one cheap session. */
const COST: UsageCost = {
  model: 'deepseek-flash',
  tier: 'offPeak',
  buckets: [
    { id: 'miss', tokens: 1_000_000, usd: 0.15 },
    { id: 'hit', tokens: 2_000_000, usd: 0.006 },
    { id: 'write', tokens: 0, usd: 0 },
    { id: 'output', tokens: 1_000_000, usd: 0.6 },
  ],
  totalUsd: 0.756,
}

afterEach(cleanup)

function renderDashboard(
  cost: UsageCost | undefined = COST,
  overrides: UnitPriceOverrides = {},
  model = COST.model,
  setUnitPrice = vi.fn(),
) {
  const view = render(<UsageDashboard cost={cost} model={model} overrides={overrides} setUnitPrice={setUnitPrice} t={t} />)
  return { view, setUnitPrice }
}

describe('UsageDashboard', () => {
  it('shows the estimate, its tier, every priced bucket, and both built-in rates', () => {
    const { view } = renderDashboard()
    expect(view.getByText('$0.76')).toBeDefined()
    expect(view.getByText('Off-peak hours')).toBeDefined()
    const buckets = view.container.querySelector('[data-usage-cost-buckets]') as HTMLElement
    expect(buckets.textContent).toContain('Uncached input1,000,000 tok$0.15')
    expect(buckets.textContent).toContain('Cached input2,000,000 tok$0.0060')
    expect(buckets.textContent).toContain('Cache write0 tok$0.00')
    expect(buckets.textContent).toContain('Output1,000,000 tok$0.60')
    expect(view.getByRole('rowheader', { name: /deepseek-flash/ })).toBeDefined()
    expect(view.getByRole('rowheader', { name: 'deepseek-v4-pro' })).toBeDefined()
    expect(view.getByText('(current)')).toBeDefined()
    expect(view.getByText('Peak hours bill at twice these rates.')).toBeDefined()
    expect(view.container.textContent).toContain('Custom unit prices (USD per million tok)')
  })

  it('marks the peak multiplier beside the tier', () => {
    const view = render(<UsageDashboard cost={{ ...COST, tier: 'peak' }} model={COST.model} overrides={{}} setUnitPrice={vi.fn()} t={t} />)
    expect(view.getByText('Peak hours')).toBeDefined()
    expect(view.getByText('×2')).toBeDefined()
  })

  it('prefills the editor with the current price and saves the parsed numbers', () => {
    const { view, setUnitPrice } = renderDashboard()
    const editor = view.container.querySelector('[data-usage-price-editor="deepseek-flash"]') as HTMLElement
    const inputs = [...editor.querySelectorAll('input')]
    expect(inputs.map(input => input.value)).toEqual(['0.15', '0.003', '0.6'])
    fireEvent.change(inputs[0]!, { target: { value: '0.2' } })
    fireEvent.click(view.getByRole('button', { name: 'Save' }))
    expect(setUnitPrice).toHaveBeenCalledWith('deepseek-flash', { miss: 0.2, hit: 0.003, output: 0.6 })
  })

  it('blocks saving while a field is not a non-negative number and explains why', () => {
    const { view, setUnitPrice } = renderDashboard()
    const editor = view.container.querySelector('[data-usage-price-editor="deepseek-flash"]') as HTMLElement
    const input = editor.querySelectorAll('input')[0]!
    fireEvent.change(input, { target: { value: '-1' } })
    const save = view.getByRole('button', { name: 'Save' })
    expect(save.hasAttribute('disabled')).toBe(true)
    expect(view.getByRole('alert').textContent).toBe('Enter non-negative numbers')
    fireEvent.click(save)
    expect(setUnitPrice).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '' } })
    expect(view.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })

  it('offers removal only while a custom price exists', () => {
    const { view } = renderDashboard()
    const remove = view.getByRole('button', { name: 'Use built-in price' })
    expect(remove.hasAttribute('disabled')).toBe(true)
    cleanup()

    const custom = renderDashboard(COST, { 'deepseek-flash': { miss: 1, hit: 1, output: 1 } })
    fireEvent.click(custom.view.getByRole('button', { name: 'Use built-in price' }))
    expect(custom.setUnitPrice).toHaveBeenCalledWith('deepseek-flash', null)
  })

  it('offers the editor for an unpriced model instead of a total', () => {
    const setUnitPrice = vi.fn()
    const view = render(<UsageDashboard cost={undefined} model="unlisted" overrides={{}} setUnitPrice={setUnitPrice} t={t} />)
    expect(view.getByText('No price yet')).toBeDefined()
    expect(view.container.querySelector('[data-usage-cost-buckets]')).toBeNull()
    expect(view.getByText(/Set a unit price for unlisted/)).toBeDefined()
    const editor = view.container.querySelector('[data-usage-price-editor="unlisted"]') as HTMLElement
    const inputs = [...editor.querySelectorAll('input')]
    expect(inputs.map(input => input.value)).toEqual(['', '', ''])
    fireEvent.change(inputs[0]!, { target: { value: '4' } })
    fireEvent.change(inputs[1]!, { target: { value: '0.5' } })
    fireEvent.change(inputs[2]!, { target: { value: '8' } })
    fireEvent.click(view.getByRole('button', { name: 'Save' }))
    expect(setUnitPrice).toHaveBeenCalledWith('unlisted', { miss: 4, hit: 0.5, output: 8 })
  })
})
