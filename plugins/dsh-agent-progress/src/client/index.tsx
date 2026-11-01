/**
 * Browser half of the Agent Progress panel.
 *
 * The panel is a global page of the shell's main column: a row in the sidebar's
 * panel list (directly below the shipped Plugins row, which registers at order
 * 0) and the page that row selects. The row's id and the page's key are the
 * same string — the layout addresses a main panel by it, throws when a selected
 * id has no page, and returns to the conversation when a session is opened.
 *
 * It is a pure reader: every fact it shows already reaches the browser for the
 * shipped UI (the session list, each row's Host-computed projection values, and
 * the per-session status snapshot), so this plugin adds no Host service, RPC
 * surface, or storage.
 */
import { useMemo, useRef, useState } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { Context } from '@deepseek-ai/cordis'
import {
  deriveProgress, type ApprovalDecision, type ApprovalRequest, type ProgressRow, type SessionListLike, type SessionStatusLike,
} from './progress.ts'
import { en, NS, zh } from './locales.ts'
import { PANEL_CSS } from './styles.ts'

/** Bound translator for this plugin's namespace. */
type Translate = (key: string) => string

/** The main-panel id, the sidebar row's id, and the page's key — one identity. */
export const PANEL_ID = 'agent-progress'

/** Services and seats this plugin's registrations need. */
export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']

/** Global standard seats the shell binds onto every slot component. */
interface GlobalSeats {
  useSessions: SnapshotSelectorHook<SessionListLike>
  useSessionStatus: SnapshotSelectorHook<ReadonlyMap<string, SessionStatusLike>>
}

/** Sidebar panel-row props: the row supplies its glyph geometry and selection state. */
interface IconProps {
  size: number
  active: boolean
}

/** Page props: the global seats plus this entry's injected callbacks. */
type PageProps = GlobalSeats & {
  t: Translate
  openSession: (sessionId: string) => void
  refresh: () => void
  resolveReason: (copy: Readonly<Record<string, string>>) => string
}

/** Substitute `{n}` in a dictionary line. */
function fill(template: string, value: number): string {
  return template.replace('{n}', String(value))
}

/** Human-readable age of the last activity. */
function age(t: Translate, updatedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000))
  if (seconds < 60) return t('now')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return fill(t('minutes'), minutes)
  const hours = Math.round(minutes / 60)
  if (hours < 24) return fill(t('hours'), hours)
  return fill(t('days'), Math.round(hours / 24))
}

/**
 * The activity glyph the sidebar row renders, in both column widths.
 * @param props - requested glyph edge plus the row's selection state.
 * @returns the icon.
 */
export function AgentProgressPanelIcon({ size, active }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={active ? undefined : { opacity: 0.75 }}
    >
      <path d="M2 11.5h3.5M2 8h7M2 4.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12.5" cy="11.5" r="2" fill="currentColor" />
    </svg>
  )
}

/** One row's right-hand column: todo tally, goal, and plan chips. */
function RowProgress({ row, t }: { row: ProgressRow, t: Translate }) {
  const { done, total } = row.todos
  return (
    <div className="ap-side">
      {row.waiting ? <span className="ap-chip" data-tone="waiting">{t('waiting')}</span> : null}
      {!row.waiting && row.unread ? <span className="ap-chip" data-tone="business">{t('unread')}</span> : null}
      {total > 0 ? (
        <>
          <span className="ap-chip" data-tone={row.running ? 'running' : undefined}>{done}/{total} {t('todos')}</span>
          <span className="ap-bar"><i style={{ width: `${Math.round((done / total) * 100)}%` }} /></span>
        </>
      ) : null}
      {row.goal !== null
        ? <span className="ap-chip ap-goal" data-tone="business" title={`${t('goal')}: ${row.goal}`}>{row.goal}</span>
        : null}
      {row.planning ? <span className="ap-chip">{t('planning')}</span> : null}
    </div>
  )
}

/**
 * The pending approval under its session: the requester's one-line summary and
 * the two decisions. It sits beside the row rather than inside it, because the
 * row is itself a button and a decision nested in a button is not a control a
 * browser can activate.
 * @param props.approval - the request to present.
 * @param props.title - the session's displayed title, named in each accessible name.
 * @param props.resolveReason - resolves requester-owned copy in the UI language.
 * @param props.t - the panel's translator.
 * @returns the approval strip.
 */
function ApprovalBar({ approval, title, resolveReason, t }: {
  approval: ApprovalRequest
  title: string
  resolveReason: (copy: Readonly<Record<string, string>>) => string
  t: Translate
}) {
  const [answered, setAnswered] = useState(false)
  const busy = useRef(false)
  const answer = (decision: ApprovalDecision): void => {
    if (busy.current) return
    busy.current = true
    setAnswered(true)
    void approval.answer(decision).catch(() => {
      busy.current = false
      setAnswered(false)
    })
  }
  const text = approval.displayReason === null ? approval.reason : resolveReason(approval.displayReason)
  return (
    <div className="ap-approval" data-approval-key={approval.key} aria-busy={answered}>
      <span className="ap-approval-text" title={text}>
        {text.length > 0 ? text : t('approvalFallback').replace('{tool}', approval.toolName)}
      </span>
      <span className="ap-approval-actions">
        <button
          type="button"
          className="ap-approval-reject"
          disabled={answered}
          aria-label={t('rejectFor').replace('{title}', title)}
          onClick={() => { answer('rejected') }}
        >
          {t('reject')}
        </button>
        <button
          type="button"
          className="ap-approval-allow"
          disabled={answered}
          aria-label={t('allowOnceFor').replace('{title}', title)}
          onClick={() => { answer('allowed-once') }}
        >
          {t('allowOnce')}
        </button>
      </span>
    </div>
  )
}

/**
 * The panel page: every session with its running state, todo progress, and last
 * activity, most relevant first. Selecting a session returns the main column to
 * that conversation, which is also how the panel closes.
 * @param props - global seats and this entry's injected callbacks.
 * @returns the page.
 */
export function AgentProgressPanel(props: PageProps) {
  const list = props.useSessions(state => state)
  const status = props.useSessionStatus(state => state)
  const view = useMemo(() => deriveProgress(list, status), [list, status])
  const now = Date.now()

  return (
    <section className="ap-page" aria-label={props.t('title')}>
      <style>{PANEL_CSS}</style>
      <header className="ap-header">
        <div>
          <h2>{props.t('title')}</h2>
          <p className="ap-summary">
            {view.running === 0
              ? props.t('summaryQuiet')
              : props.t('summary')
                .replace('{running}', String(view.running))
                .replace('{unfinished}', String(view.unfinished))}
          </p>
        </div>
        <span className="ap-spacer" />
        <button type="button" onClick={() => { props.refresh() }}>{props.t('refresh')}</button>
      </header>
      {view.rows.length === 0 ? (
        <div className="ap-empty">
          <strong>{props.t('empty')}</strong>
          <p>{props.t('emptyHint')}</p>
        </div>
      ) : (
        <ul className="ap-scroll ap-list">
          {view.rows.map(row => (
            <li key={row.id}>
              <button
                type="button"
                className="ap-row"
                title={props.t('openSession')}
                onClick={() => { props.openSession(row.id) }}
              >
                <span className="ap-dot" data-running={row.running} />
                <span className="ap-main">
                  <span className="ap-title">{row.title}</span>
                  <span className="ap-meta">
                    <span className="ap-chip" data-tone={row.running ? 'running' : undefined}>
                      {row.running ? props.t('running') : props.t('idle')}
                    </span>
                    {row.subagent ? <span>{props.t('subagent')}</span> : null}
                    {row.cwdLabel.length > 0 ? <span>{row.cwdLabel}</span> : null}
                    <span>{age(props.t, row.updatedAt, now)}</span>
                  </span>
                  {row.todos.active !== null && row.todos.active.length > 0
                    ? <span className="ap-active">{row.todos.active}</span>
                    : null}
                </span>
                <RowProgress row={row} t={props.t} />
              </button>
              {row.approval === null
                ? null
                : (
                  <ApprovalBar
                    approval={row.approval}
                    title={row.title}
                    resolveReason={props.resolveReason}
                    t={props.t}
                  />
                )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Register the panel: its dictionary, the sidebar row beneath the Plugins row,
 * and the main-column page that row selects.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agent-progress: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 1,
    label: () => t('panel'),
    locale: NS,
  }, AgentProgressPanelIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({
      openSession: (sessionId: string) => { ctx.uiWorkspace.openSession(sessionId) },
      refresh: () => { void ctx.sessions.refresh() },
      resolveReason: (copy: Readonly<Record<string, string>>) => ctx.locale.resolveText(copy),
    }),
  }, AgentProgressPanel))
}
