/**
 * The Team panel: what a run's team is doing, and what waits for a person.
 *
 * Reads one snapshot from this plugin's own Host route, then again on refresh.
 * The component holds no store and subscribes to nothing else: the roster,
 * tasks, and reports all arrive in that one answer.
 *
 * @module prism-team/client/TeamPanel
 */

import { useCallback, useEffect, useState } from 'react'
import type { TeamPanelReport, TeamPanelValue } from '../panel-contract.ts'
import type { TeamKey } from './locales.ts'
import { styles } from './styles.ts'

/** Statuses the needs-a-person group shows first. */
const NEEDS_A_PERSON: ReadonlySet<string> = new Set(['blocked', 'failed', 'ready', 'waiting'])

/** What the plugin injects into the rendered panel. */
export interface TeamPanelInjected {
  /** Read the panel for the session this view belongs to. */
  readonly load: (signal: AbortSignal) => Promise<TeamPanelValue>
  /** Localized copy for this view. */
  readonly t: (key: TeamKey) => string
}

/** One report line. */
function ReportRow({ report }: { readonly report: TeamPanelReport }) {
  return (
    <div style={styles.row}>
      <span style={styles.status}>{report.status}</span>
      <span style={styles.name}>{report.name}</span>
      <span>
        {report.summary}
        {report.taskId === undefined ? null : <span style={styles.muted}> · {report.taskId}</span>}
      </span>
    </div>
  )
}

/**
 * Render the team panel.
 *
 * @param props - the injected read and copy.
 * @returns the panel, its loading state, or its empty state.
 */
export function TeamPanel(props: TeamPanelInjected) {
  const { load, t } = props
  const [value, setValue] = useState<TeamPanelValue>()
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(true)

  const read = useCallback((signal: AbortSignal): void => {
    setFailed(false)
    setPending(true)
    load(signal).then(
      (next) => { if (!signal.aborted) { setValue(next); setPending(false) } },
      () => { if (!signal.aborted) { setFailed(true); setPending(false) } },
    )
  }, [load])

  useEffect(() => {
    const controller = new AbortController()
    read(controller.signal)
    return () => { controller.abort() }
  }, [read])

  if (pending && value === undefined) return <div style={styles.root}>{t('loading')}</div>
  if (failed && value === undefined) {
    return (
      <div style={styles.root}>
        <div style={styles.notice}>{t('failed')}</div>
        <div><button type="button" style={styles.button} onClick={() => { read(new AbortController().signal) }}>{t('refresh')}</button></div>
      </div>
    )
  }
  if (value === undefined) return <div style={styles.root}>{t('loading')}</div>
  if (!value.live && value.reports.length === 0) return <div style={styles.root}>{t('empty')}</div>

  const needs = value.reports.filter(report => NEEDS_A_PERSON.has(report.status))
  const working = value.reports.filter(report => !NEEDS_A_PERSON.has(report.status))

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.headline}>
          {value.team} · {value.members.length} {t('members')} · {value.tasks.length} {t('tasks')}
        </span>
        <button type="button" style={styles.button} onClick={() => { read(new AbortController().signal) }}>{t('refresh')}</button>
      </div>
      {value.failure === undefined ? null : <div style={styles.notice}>{value.failure}</div>}
      {value.live ? null : <div style={styles.notice}>{t('offline')}</div>}
      {needs.length === 0 ? null : (
        <div style={styles.section}>
          <span style={styles.sectionTitle}>{t('needsAPerson')}</span>
          {needs.map((report, index) => <ReportRow key={`${report.name}-${report.status}-${String(index)}`} report={report} />)}
        </div>
      )}
      {working.length === 0 ? null : (
        <div style={styles.section}>
          <span style={styles.sectionTitle}>{t('working')}</span>
          {working.map((report, index) => <ReportRow key={`${report.name}-${report.status}-${String(index)}`} report={report} />)}
        </div>
      )}
      {value.tasks.length === 0 ? null : (
        <div style={styles.section}>
          <span style={styles.sectionTitle}>{t('tasks')}</span>
          {value.tasks.map(task => (
            <div key={task.id} style={styles.row}>
              <span style={styles.status}>{task.id}</span>
              <span style={styles.name}>{task.ownerName ?? task.status}</span>
              <span>{task.subject}{task.ready ? null : <span style={styles.muted}> · blocked</span>}</span>
            </div>
          ))}
        </div>
      )}
      {value.members.length === 0 ? null : (
        <div style={styles.section}>
          <span style={styles.sectionTitle}>{t('members')}</span>
          {value.members.map(member => (
            <div key={member.name} style={styles.row}>
              <span style={styles.status}>{member.role}</span>
              <span style={styles.name}>{member.name}</span>
              <span style={styles.muted}>{member.status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
