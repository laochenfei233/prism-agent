/**
 * The memory page: counts over the whole corpus, a keyword search, an operator
 * write, the review inbox, and the record list.
 *
 * Every read and write goes through the injected face, which reaches this
 * plugin's own browser routes; the page holds nothing but the view state it
 * renders, and reloads the overview after each write so the counts and the
 * inbox never disagree with the corpus.
 *
 * @module @prism/prism-memory/client/MemoryPanel
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { MEMORY_LAYERS, type MemoryLayer } from '../layers.ts'
import type { MemoryOverview, MemoryRow } from '../web-contract.ts'
import type { MemoryPanelFace } from './api.ts'
import type { Translate } from './locales.ts'
import { MEMORY_CSS } from './styles.ts'

/** Lifecycle of the page's first read. */
type Phase = 'loading' | 'ready' | 'failed'

/** Everything the page renders, composed by the main slot renderer. */
export type MemoryPanelProps = MemoryPanelFace & {
  /** Translator bound to this plugin's namespace. */
  readonly t: Translate
}

/** Operator-readable text for one thrown value. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The local calendar date of one ISO-8601 stamp. */
function dateOf(iso: string): string {
  return iso.slice(0, 10)
}

/** Render the memory page. */
export function MemoryPanel(props: MemoryPanelProps): ReactNode {
  const { load, search, remember, review, t } = props
  const [phase, setPhase] = useState<Phase>('loading')
  const [failure, setFailure] = useState('')
  const [overview, setOverview] = useState<MemoryOverview | null>(null)
  const [matches, setMatches] = useState<readonly MemoryRow[]>([])
  const [searched, setSearched] = useState(false)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [layer, setLayer] = useState<MemoryLayer>('fact')
  const [notice, setNotice] = useState('')
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setOverview(await load())
      setPhase('ready')
    } catch (error) {
      setFailure(reasonOf(error))
      setPhase('failed')
    }
  }, [load])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * Run one operation, report its outcome, and reload the corpus.
   * @param operation - the request to perform, answering the notice text.
   */
  const run = async (operation: () => Promise<string>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    try {
      setNotice(await operation())
      await refresh()
    } catch (error) {
      setNotice(reasonOf(error))
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const onSearch = (): void => {
    void run(async () => {
      const found = await search(query)
      setMatches(found)
      setSearched(true)
      return found.length === 0 ? t('noMatch') : ''
    })
  }

  const onClear = (): void => {
    setQuery('')
    setMatches([])
    setSearched(false)
    setNotice('')
    setFailed(false)
  }

  const onAdd = (): void => {
    const text = draft.trim()
    if (text === '') return
    void run(async () => {
      const stored = await remember(text, layer)
      setDraft('')
      return t(stored.outcome === 'existing' ? 'existing' : 'stored', { id: stored.row.id })
    })
  }

  const onReview = (row: MemoryRow, decision: 'approve' | 'reject'): void => {
    void run(async () => {
      const settled = await review(row.id, decision)
      return t(decision === 'approve' ? 'approved' : 'rejected', { id: settled.id })
    })
  }

  const counts = overview?.counts
  const shown = searched ? matches : overview?.recent ?? []
  const heading = searched ? t('searchHeading') : t('recentHeading')

  return (
    <div className="pm-page">
      <style>{MEMORY_CSS}</style>
      <header className="pm-head">
        <h1>{t('title')}</h1>
        <p className="pm-counts">
          {t('counts', {
            total: counts?.total ?? 0,
            pending: overview?.pending.length ?? 0,
            layers: Object.keys(counts?.byLayer ?? {}).length,
          })}
        </p>
      </header>

      <form
        className="pm-bar"
        onSubmit={(event) => {
          event.preventDefault()
          onSearch()
        }}
      >
        <Input
          className="pm-grow"
          value={query}
          placeholder={t('searchHint')}
          aria-label={t('searchHint')}
          onChange={event => { setQuery(event.currentTarget.value) }}
        />
        <Button type="submit" disabled={busy}>{t('searchAction')}</Button>
        <Button type="button" variant="ghost" disabled={busy || (!searched && query === '')} onClick={onClear}>
          {t('searchClear')}
        </Button>
      </form>

      <form
        className="pm-bar"
        onSubmit={(event) => {
          event.preventDefault()
          onAdd()
        }}
      >
        <Input
          className="pm-grow"
          value={draft}
          placeholder={t('addHint')}
          aria-label={t('addHint')}
          onChange={event => { setDraft(event.currentTarget.value) }}
        />
        <select
          className="pm-layer"
          value={layer}
          aria-label={t('layerLabel')}
          onChange={(event) => { setLayer(event.currentTarget.value as MemoryLayer) }}
        >
          {MEMORY_LAYERS.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        <Button type="submit" variant="primary" disabled={busy || draft.trim() === ''}>{t('addAction')}</Button>
      </form>

      <p className="pm-notice" data-tone={failed ? 'error' : undefined}>{notice}</p>

      {phase === 'loading' && <p className="pm-state">{t('loading')}</p>}
      {phase === 'failed' && (
        <p className="pm-state">
          {t('failed', { reason: failure })}
          {' '}
          <Button size="sm" onClick={() => { void refresh() }}>{t('retry')}</Button>
        </p>
      )}

      {phase === 'ready' && (
        <div className="pm-body">
          {(overview?.pending.length ?? 0) > 0 && (
            <section className="pm-section">
              <h2>{t('reviewHeading')}</h2>
              <ul className="pm-list">
                {(overview?.pending ?? []).map(row => (
                  <li key={row.id} className="pm-row">
                    <div className="pm-row-meta">
                      <span className="pm-badge" data-layer={row.layer}>{row.layer}</span>
                      <span>{row.kind}</span>
                      <span>{row.scope}</span>
                      <span>{dateOf(row.createdAt)}</span>
                    </div>
                    <p className="pm-row-text">{row.text}</p>
                    <div className="pm-actions">
                      <Button size="sm" variant="primary" disabled={busy} onClick={() => { onReview(row, 'approve') }}>
                        {t('reviewApprove')}
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => { onReview(row, 'reject') }}>
                        {t('reviewReject')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="pm-section">
            <h2>{heading}</h2>
            {shown.length === 0
              ? <p className="pm-state">{searched ? t('noMatch') : t('empty')}</p>
              : (
                <ul className="pm-list">
                  {shown.map(row => (
                    <li key={row.id} className="pm-row">
                      <div className="pm-row-meta">
                        <span className="pm-badge" data-layer={row.layer}>{row.layer}</span>
                        <span>{row.kind}</span>
                        <span title={t('scopeLabel')}>{row.scope}</span>
                        <span>{dateOf(row.createdAt)}</span>
                        <span>{row.id}</span>
                      </div>
                      <p className="pm-row-text">{row.text}</p>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </div>
      )}
    </div>
  )
}
