/**
 * Cost dashboard body: the session estimate, its priced buckets, the built-in
 * rate table, and the custom unit-price editor.
 *
 * @module UsageDashboard
 */

import { useState, type ReactElement } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelUnitPrice, UnitPriceOverrides } from '../contract/usage.ts'
import type { UsageCost } from './usage-pricing.ts'
import { BUILTIN_UNIT_PRICES, formatUsd, resolveUnitPrice, tierMultiplier } from './usage-pricing.ts'
import { formatExactTokens } from './token-format.ts'
import css from './UsageDashboard.module.css'

/** Built-in rate rows, in table order. */
const RATE_MODELS = Object.keys(BUILTIN_UNIT_PRICES)

/** Translate seat for the dashboard copy. */
type Translate = PropsLocale<'chat'>['t']

/** Dashboard inputs: the estimate (absent while unpriced), the model, and the write face. */
export interface UsageDashboardProps {
  /** The session's priced estimate; absent when the route has no unit price yet. */
  cost: UsageCost | undefined
  /** The route the Session's requests used. */
  model: string
  overrides: UnitPriceOverrides
  /** Store or clear one model's custom price. */
  setUnitPrice: (model: string, price: ModelUnitPrice | null) => void
  /** Chat locale seat. */
  t: Translate
}

/**
 * Parse the editor's three draft prices.
 * @param draft - raw field values.
 * @returns the unit price, or undefined while a field is not a non-negative number.
 */
function parseDraft(draft: Record<keyof ModelUnitPrice, string>): ModelUnitPrice | undefined {
  const price = (value: string): number | undefined => {
    if (value.trim() === '') return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
  }
  const miss = price(draft.miss)
  const hit = price(draft.hit)
  const output = price(draft.output)
  if (miss === undefined || hit === undefined || output === undefined) return undefined
  return { miss, hit, output }
}

/**
 * Render one model's price editor over its current effective price.
 * @param props.model - model the editor prices.
 * @param props.overrides - stored overrides.
 * @param props.setUnitPrice - write face.
 * @param props.t - Chat locale seat.
 * @returns the three fields and their actions.
 */
function PriceEditor({ model, overrides, setUnitPrice, t }: {
  model: string
  overrides: UnitPriceOverrides
  setUnitPrice: UsageDashboardProps['setUnitPrice']
  t: Translate
}) {
  const stored = resolveUnitPrice(model, overrides)
  const [draft, setDraft] = useState<Record<keyof ModelUnitPrice, string>>({
    miss: stored === undefined ? '' : String(stored.miss),
    hit: stored === undefined ? '' : String(stored.hit),
    output: stored === undefined ? '' : String(stored.output),
  })
  const parsed = parseDraft(draft)
  const field = (key: keyof ModelUnitPrice): ReactElement => (
    <label className={css.field}>
      <span className={css.fieldLabel}>{t(`cost.custom.${key}`)}</span>
      <input
        className={css.input}
        inputMode="decimal"
        value={draft[key]}
        onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }) }}
      />
    </label>
  )
  return (
    <div className={css.editor} data-usage-price-editor={model}>
      <div className={css.editorTitle}>{t('cost.custom.model', { model })}</div>
      <div className={css.fields}>
        {field('miss')}
        {field('hit')}
        {field('output')}
      </div>
      <div className={css.editorActions}>
        <button
          type="button"
          className={css.action}
          disabled={parsed === undefined}
          onClick={() => { if (parsed !== undefined) setUnitPrice(model, parsed) }}
        >
          {t('cost.custom.save')}
        </button>
        <button
          type="button"
          className={css.action}
          disabled={!Object.hasOwn(overrides, model)}
          onClick={() => { setUnitPrice(model, null) }}
        >
          {t('cost.custom.remove')}
        </button>
        {parsed === undefined && <span className={css.hint} role="alert">{t('cost.custom.invalid')}</span>}
      </div>
    </div>
  )
}

/**
 * Render the session cost breakdown, the rate table, and the price editor.
 * @param props.cost - the priced estimate, absent while the route is unpriced.
 * @param props.model - the route the Session's requests used.
 * @param props.overrides - stored custom prices.
 * @param props.setUnitPrice - write face for the editor.
 * @param props.t - Chat locale seat.
 * @returns the dashboard content.
 */
export function UsageDashboard({ cost, model, overrides, setUnitPrice, t }: UsageDashboardProps) {
  const amount = (value: number): string => t('cost.usd', { amount: formatUsd(value) })
  const models = cost !== undefined && !RATE_MODELS.includes(cost.model) ? [...RATE_MODELS, cost.model] : RATE_MODELS
  const stored = resolveUnitPrice(model, overrides)
  return (
    <div className={css.root}>
      {cost === undefined
        ? (
          <div className={css.headline} data-usage-cost-unpriced>
            <span className={css.total}>{t('cost.unpriced')}</span>
          </div>
        )
        : (
          <>
            <div className={css.headline}>
              <span className={css.total} data-usage-cost-total>{amount(cost.totalUsd)}</span>
              <span className={css.tier} data-usage-cost-tier>
                {t(cost.tier === 'peak' ? 'cost.tier.peak' : 'cost.tier.offPeak')}
                {tierMultiplier(cost.tier) !== 1 && <span className={css.multiplier}>{`×${tierMultiplier(cost.tier)}`}</span>}
              </span>
            </div>
            <dl className={css.buckets} data-usage-cost-buckets>
              {cost.buckets.map(bucket => (
                <div key={bucket.id} className={css.bucket}>
                  <dt>{t(`cost.bucket.${bucket.id}`)}</dt>
                  <dd>
                    <span className={css.tokens}>{t('message.turnUsage.count', { count: formatExactTokens(bucket.tokens, t) })}</span>
                    <span className={css.usd}>{amount(bucket.usd)}</span>
                  </dd>
                </div>
              ))}
            </dl>
            <p className={css.note}>{t('cost.dialog.estimate')}</p>
          </>
        )}
      {cost === undefined && <p className={css.note}>{t('cost.unpricedHint', { model })}</p>}
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('cost.rates.title')}</h3>
        <table className={css.rates}>
          <thead>
            <tr>
              <th scope="col">{t('cost.rates.model')}</th>
              <th scope="col">{t('cost.rates.miss')}</th>
              <th scope="col">{t('cost.rates.hit')}</th>
              <th scope="col">{t('cost.rates.output')}</th>
            </tr>
          </thead>
          <tbody>
            {models.map((row) => {
              const price = resolveUnitPrice(row, overrides)
              if (price === undefined) return null
              return (
                <tr key={row} className={row === model ? css.rateCurrent : undefined}>
                  <th scope="row">
                    {row}
                    {row === model && <span className={css.current}>{t('cost.rates.current')}</span>}
                  </th>
                  <td>{amount(price.miss)}</td>
                  <td>{amount(price.hit)}</td>
                  <td>{amount(price.output)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className={css.note}>{t('cost.rates.peakNote')}</p>
      </section>
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('cost.custom.title')}</h3>
        <PriceEditor
          key={`${model}:${stored === undefined ? 'none' : `${stored.miss}/${stored.hit}/${stored.output}`}`}
          model={model}
          overrides={overrides}
          setUnitPrice={setUnitPrice}
          t={t}
        />
      </section>
    </div>
  )
}
