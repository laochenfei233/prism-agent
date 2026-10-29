/**
 * Settings section that imports conversation history from other coding agents.
 *
 * The page scans the ten supported stores, previews the sessions grouped by
 * working folder, and requires one explicit confirmation before adding
 * sessions to projects that already exist. It calls the Host routes with
 * plain JSON and never reads a foreign store itself.
 *
 * @module @deepseek-ai/dsh-session-import/client/ImportSection
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SESSION_IMPORT_CANDIDATES_ROUTE, SESSION_IMPORT_ROUTE } from '../routes.ts'
import { isImportSourceId } from '../source-ids.ts'
import type {
  ImportApplyResult,
  ImportOutcome,
  ImportPlan,
  ImportPlanRequest,
  ImportSourceId,
  ImportUnavailableReason,
  PlanGroup,
  SourceCandidate,
} from '../types.ts'
import {
  formatBytes,
  formatDay,
  groupId,
  groupIds,
  mergeGroupsFor,
  outcomeCounts,
  selectedSessionIds,
} from './state.ts'
import css from './ImportSection.module.css'

/** Props bound by the settings renderer. */
export type ImportSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'settings.sessionImport'>

type Phase = 'sources' | 'planning' | 'preview' | 'importing' | 'done'

/** Read a JSON object from an untrusted response. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

function unavailableReasonOf(value: unknown): ImportUnavailableReason | undefined {
  return value === 'not-found' || value === 'current-home' || value === 'scan-failed' ? value : undefined
}

function candidateOf(value: unknown): SourceCandidate | undefined {
  const record = objectOf(value)
  if (record === undefined) return undefined
  const id = record['id']
  const label = record['label']
  const root = record['root']
  if (typeof id !== 'string' || !isImportSourceId(id)) return undefined
  if (typeof label !== 'string' || typeof root !== 'string') return undefined
  if (typeof record['available'] !== 'boolean') return undefined
  if (typeof record['sessionCount'] !== 'number' || typeof record['bytes'] !== 'number') return undefined
  const reason = unavailableReasonOf(record['reason'])
  return {
    id,
    label,
    root,
    available: record['available'],
    ...(reason === undefined ? {} : { reason }),
    sessionCount: record['sessionCount'],
    bytes: record['bytes'],
    ...(typeof record['latestAt'] === 'number' ? { latestAt: record['latestAt'] } : {}),
  }
}

function planSessionOf(value: unknown): PlanGroup['sessions'][number] | undefined {
  const record = objectOf(value)
  if (record === undefined) return undefined
  if (typeof record['key'] !== 'string' || typeof record['createdAt'] !== 'number'
    || typeof record['updatedAt'] !== 'number') return undefined
  return {
    key: record['key'],
    ...(typeof record['title'] === 'string' ? { title: record['title'] } : {}),
    createdAt: record['createdAt'],
    updatedAt: record['updatedAt'],
    ...(typeof record['messageCount'] === 'number' ? { messageCount: record['messageCount'] } : {}),
  }
}

function groupOf(value: unknown): PlanGroup | undefined {
  const record = objectOf(value)
  if (record === undefined || !Array.isArray(record['sessions'])) return undefined
  if (typeof record['merge'] !== 'boolean') return undefined
  const sessions = record['sessions'].flatMap((entry) => {
    const session = planSessionOf(entry)
    return session === undefined ? [] : [session]
  })
  const existing = objectOf(record['existingWorkspace'])
  return {
    ...(typeof record['path'] === 'string' ? { path: record['path'] } : {}),
    ...(typeof record['title'] === 'string' ? { title: record['title'] } : {}),
    sessions,
    ...(existing === undefined ? {} : {
      existingWorkspace: {
        id: typeof existing['id'] === 'string' ? existing['id'] : '',
        title: typeof existing['title'] === 'string' ? existing['title'] : '',
        sessionCount: typeof existing['sessionCount'] === 'number' ? existing['sessionCount'] : 0,
      },
    }),
    merge: record['merge'],
  }
}

function planOf(value: unknown): ImportPlan | undefined {
  const record = objectOf(value)
  if (record === undefined || typeof record['source'] !== 'string'
    || !isImportSourceId(record['source']) || !Array.isArray(record['groups'])) return undefined
  const groups = record['groups'].flatMap((entry) => {
    const group = groupOf(entry)
    return group === undefined ? [] : [group]
  })
  const skipped = Array.isArray(record['skipped'])
    ? record['skipped'].flatMap((entry) => {
      const item = objectOf(entry)
      return typeof item?.['key'] === 'string' && typeof item['reason'] === 'string'
        ? [{ key: item['key'], reason: item['reason'] }]
        : []
    })
    : []
  return { source: record['source'], groups, skipped }
}

function outcomeOf(value: unknown): ImportOutcome | undefined {
  return value === 'imported' || value === 'duplicate' || value === 'skipped' || value === 'failed'
    ? value
    : undefined
}

function resultOf(value: unknown): ImportApplyResult | undefined {
  const record = objectOf(value)
  if (record === undefined || !Array.isArray(record['results']) || !Array.isArray(record['workspaces'])) {
    return undefined
  }
  const results = record['results'].flatMap((entry) => {
    const item = objectOf(entry)
    const outcome = outcomeOf(item?.['outcome'])
    if (typeof item?.['key'] !== 'string' || outcome === undefined) return []
    return [{
      key: item['key'],
      outcome,
      ...(typeof item['sessionId'] === 'string' ? { sessionId: item['sessionId'] } : {}),
      ...(typeof item['reason'] === 'string' ? { reason: item['reason'] } : {}),
    }]
  })
  const workspaces = record['workspaces'].flatMap((entry) => {
    const item = objectOf(entry)
    if (typeof item?.['path'] !== 'string' || typeof item['workspaceId'] !== 'string') return []
    return [{
      path: item['path'],
      workspaceId: item['workspaceId'],
      created: item['created'] === true,
      imported: typeof item['imported'] === 'number' ? item['imported'] : 0,
    }]
  })
  return { results, workspaces }
}

/** Read `message` from a failure body. */
function failureMessage(body: unknown): string | undefined {
  const record = objectOf(body)
  const message = record?.['message']
  return typeof message === 'string' ? message : undefined
}

type Translate = ImportSectionProps['t']

async function requestJson<T>(
  url: string,
  init: RequestInit,
  guard: (value: unknown) => T | undefined,
  t: Translate,
): Promise<T> {
  const response = await fetch(url, init)
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(failureMessage(body) ?? t('requestFailed', { status: response.status }))
  const parsed = guard(body)
  if (parsed === undefined) throw new Error(t('unexpectedResponse'))
  return parsed
}

const EMPTY_RESULT: ImportApplyResult = { results: [], workspaces: [] }

/** Render the import page.
 * @param props - localized copy and the settings section runtime.
 * @returns the source shelf, project preview, confirmation dialog, and result.
 */
export function ImportSection({ t }: ImportSectionProps) {
  const [candidates, setCandidates] = useState<readonly SourceCandidate[] | null>(null)
  const [selectedSource, setSelectedSource] = useState<ImportSourceId | null>(null)
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [included, setIncluded] = useState<string[]>([])
  const [phase, setPhase] = useState<Phase>('sources')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportApplyResult>(EMPTY_RESULT)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeAcknowledged, setMergeAcknowledged] = useState(false)
  const requestSeq = useRef(0)

  const loadSources = (): void => {
    const seq = ++requestSeq.current
    setCandidates(null)
    setError(null)
    void requestJson(SESSION_IMPORT_CANDIDATES_ROUTE, { method: 'GET' }, (value) => {
      if (!Array.isArray(value)) return undefined
      const parsed = value.flatMap((entry) => {
        const candidate = candidateOf(entry)
        return candidate === undefined ? [] : [candidate]
      })
      return parsed
    }, t).then((next) => {
      if (seq === requestSeq.current) setCandidates(next)
    }).catch((reason: unknown) => {
      if (seq === requestSeq.current) setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  useEffect(() => {
    loadSources()
    return () => { requestSeq.current += 1 }
  }, [])

  const openSource = (source: ImportSourceId): void => {
    const seq = ++requestSeq.current
    setSelectedSource(source)
    setPlan(null)
    setResult(EMPTY_RESULT)
    setIncluded([])
    setError(null)
    setPhase('planning')
    const body: ImportPlanRequest = { source }
    void requestJson(SESSION_IMPORT_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'plan', ...body }),
    }, planOf, t).then((next) => {
      if (seq !== requestSeq.current) return
      setPlan(next)
      setIncluded(groupIds(next))
      setPhase('preview')
    }).catch((reason: unknown) => {
      if (seq !== requestSeq.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('sources')
    })
  }

  const ids = useMemo(() => plan === null ? [] : selectedSessionIds(plan, included), [plan, included])
  const merges = useMemo(() => plan === null ? [] : mergeGroupsFor(plan, included), [plan, included])
  const counts = useMemo(() => outcomeCounts(result), [result])
  const planning = phase === 'planning'
  const importing = phase === 'importing'

  const runImport = (confirmMerge: boolean): void => {
    if (plan === null || ids.length === 0) return
    setMergeOpen(false)
    setError(null)
    setPhase('importing')
    void requestJson(SESSION_IMPORT_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'apply',
        source: plan.source,
        sessionIds: ids,
        ...(confirmMerge ? { confirmMerge: true } : {}),
      }),
    }, resultOf, t).then((next) => {
      setResult(next)
      setPhase('done')
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('preview')
    })
  }

  const toggle = (id: string, checked: boolean): void => {
    setIncluded(current => checked
      ? [...current, id]
      : current.filter(candidate => candidate !== id))
  }

  const unavailableText = (reason: SourceCandidate['reason']): string => {
    if (reason === 'current-home') return t('unavailableCurrentHome')
    if (reason === 'scan-failed') return t('unavailableScanFailed')
    return t('unavailableNotFound')
  }

  const detailRows = result.results.filter(entry => entry.outcome === 'failed' || entry.outcome === 'skipped')

  return <section className={css.section}>
    <header className={css.header}>
      <div>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.intro}>{t('intro')}</p>
      </div>
      <Button variant="outline" size="sm" onClick={loadSources} disabled={importing || planning}>
        {t('refresh')}
      </Button>
    </header>

    {error === null ? null : <div className={css.error} role="alert">
      <strong>{t('errorTitle')}</strong>
      <span>{error}</span>
    </div>}

    <div className={css.shelf}>
      {candidates === null
        ? <div className={css.loading}><StateDot state="ongoing" />{t('loading')}</div>
        : candidates.map(candidate => <button
          key={candidate.id}
          type="button"
          className={css.source}
          data-selected={candidate.id === selectedSource ? 'true' : undefined}
          data-available={candidate.available ? 'true' : undefined}
          aria-pressed={candidate.id === selectedSource}
          disabled={!candidate.available || importing || planning}
          onClick={() => { openSource(candidate.id) }}
        >
          <span className={css.mark} aria-hidden="true">{initialsOf(candidate.label)}</span>
          <span className={css.sourceBody}>
            <span className={css.sourceName}>{candidate.label}</span>
            <span className={css.sourceMeta}>
              {candidate.available
                ? <>
                  <span>{t('sourceCount', { count: candidate.sessionCount })}</span>
                  <span className={css.sep}>·</span>
                  <span>{formatBytes(candidate.bytes)}</span>
                </>
                : <span>{unavailableText(candidate.reason)}</span>}
            </span>
            <span className={css.sourceFoot}>
              {candidate.available && candidate.sessionCount === 0
                ? t('emptySource')
                : candidate.available
                  ? <>{t('lastActivity')} {formatDay(candidate.latestAt ?? 0)}</>
                  : candidate.root}
            </span>
          </span>
        </button>)}
    </div>

    {planning
      ? <div className={css.loading}><StateDot state="ongoing" />{t('dryRun')}…</div>
      : null}

    {plan !== null && phase === 'preview' ? <section className={css.panel} aria-label={t('dryRun')}>
      <div className={css.panelHead}>
        <div>
          <h3 className={css.panelTitle}>{t('dryRun')}</h3>
          <p className={css.panelHint}>{t('dryRunHint')}</p>
        </div>
      </div>
      {plan.groups.length === 0
        ? <p className={css.empty}>{t('emptySource')}</p>
        : <ul className={css.projects}>
          {plan.groups.map((group, index) => {
            const id = groupId(group, index)
            const checked = included.includes(id)
            const label = group.path ?? t('noFolder')
            return <li key={id} className={css.project}>
              <Checkbox
                checked={checked}
                onChange={(next) => { toggle(id, next) }}
                label={label}
                className={css.projectCheck}
              />
              <span className={css.projectMeta}>
                <span>{t('sourceCount', { count: group.sessions.length })}</span>
                <span className={css.sep}>·</span>
                <span>{formatDay(group.sessions.at(-1)?.updatedAt ?? 0)}</span>
              </span>
              {group.merge && group.existingWorkspace !== undefined
                ? <span className={css.mergeBadge}>{t('mergeBadge', { count: group.existingWorkspace.sessionCount })}</span>
                : group.path === undefined
                  ? <span className={css.plainBadge}>{t('ungroupedBadge')}</span>
                  : null}
            </li>
          })}
        </ul>}
      <footer className={css.actions}>
        <span className={css.summary}>
          {merges.length > 0
            ? t('mergeSummary', { count: merges.length })
            : t('selectedSummary', { count: ids.length })}
        </span>
        <Button
          variant="primary"
          disabled={ids.length === 0 || importing}
          onClick={() => {
            if (merges.length > 0) {
              setMergeAcknowledged(false)
              setMergeOpen(true)
            } else {
              runImport(false)
            }
          }}
        >
          {t('importButton')}
        </Button>
      </footer>
    </section> : null}

    {importing ? <div className={css.loading} role="status"><StateDot state="ongoing" />{t('importing')}</div> : null}

    {phase === 'done' ? <section className={css.panel} aria-label={t('resultTitle')}>
      <h3 className={css.panelTitle}>{t('resultTitle')}</h3>
      <p className={css.resultLine}>
        <span className={css.resultStrong}>{counts.imported} {t('resultImported')}</span>
        <span className={css.sep}>·</span>
        <span>{counts.duplicate} {t('resultDuplicate')}</span>
        <span className={css.sep}>·</span>
        <span>{counts.skipped} {t('resultSkipped')}</span>
        <span className={css.sep}>·</span>
        <span className={counts.failed > 0 ? css.resultFailed : undefined}>{counts.failed} {t('resultFailed')}</span>
      </p>
      <p className={css.panelHint}>{t('resultHint')}</p>
      {detailRows.length === 0 ? null : <details className={css.details}>
        <summary>{t('problemDetails')}</summary>
        <ul>
          {detailRows.map(entry => <li key={entry.key}>
            <code>{entry.key}</code>
            <span>{entry.reason ?? entry.outcome}</span>
          </li>)}
        </ul>
      </details>}
      <footer className={css.actions}>
        <span />
        <Button variant="primary" onClick={() => { loadSources(); setPhase('sources'); setPlan(null) }}>
          {t('importAnother')}
        </Button>
      </footer>
    </section> : null}

    <Modal
      open={mergeOpen}
      onClose={() => { setMergeOpen(false) }}
      title={t('mergeTitle')}
      closeLabel={t('close')}
      description={t('mergeBody')}
      footer={<>
        <Button onClick={() => { setMergeOpen(false) }}>{t('cancel')}</Button>
        <Button variant="primary" disabled={!mergeAcknowledged} onClick={() => { runImport(true) }}>
          {t('confirmImport')}
        </Button>
      </>}
    >
      <ul className={css.modalList}>
        {merges.map(group => <li key={group.path ?? group.title}>
          <code>{group.path}</code>
          <span>{t('sourceCount', { count: group.sessions.length })}</span>
        </li>)}
      </ul>
      <Checkbox
        checked={mergeAcknowledged}
        onChange={setMergeAcknowledged}
        label={t('mergeAck')}
      />
    </Modal>
  </section>
}

/** Two-letter shelf mark for a source name. */
function initialsOf(label: string): string {
  return label.split(' ').map(word => word[0] ?? '').join('').slice(0, 2).toUpperCase()
}
