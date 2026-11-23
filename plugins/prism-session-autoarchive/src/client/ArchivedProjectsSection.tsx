/**
 * Settings · Archived projects: every Workspace the archive set hides, most
 * recently active first, each with a restore action.
 *
 * The section reads the client Workspace and Session snapshots and restores a
 * project through the Workspace navigation; it owns no state the Host also owns.
 */
import { useState, useSyncExternalStore } from 'react'
import { archivedWorkspaceRows, type ArchivedWorkspaceRow } from './rows.ts'
import { ARCHIVED_CSS } from './styles.ts'

/** Props bound by the settings renderer. */
export interface ArchivedProjectsSectionProps {
  /** Closes the settings modal; the renderer binds it for every section. */
  close: () => void
  /** Translator bound to this plugin's namespace. */
  t: (key: string, params?: Record<string, string | number>) => string
}

/**
 * The client services the section reads, declared structurally: an
 * out-of-tree bundle compiles without the shell's client packages, and the
 * browser resolves the real seats through the module table at runtime.
 */
export interface ArchivedProjectsSectionContext {
  workspaces: {
    list: {
      getSnapshot(): {
        readonly archivedWorkspaceIds: readonly string[]
        readonly items: ReadonlyArray<{
          readonly workspaceId: string
          readonly title?: string
          readonly path?: string
          readonly updatedAt?: string
          readonly sessionIds: readonly string[]
        }>
      }
      subscribe(listener: () => void): () => void
    }
  }
  sessions: {
    list: {
      getSnapshot(): { readonly byId: Readonly<Record<string, { updatedAt?: number }>> }
      subscribe(listener: () => void): () => void
    }
  }
  uiWorkspace: { unarchiveWorkspace(workspaceId: string): Promise<void> }
}

/** Milliseconds in one hour. */
const HOUR_MS = 3_600_000
/** Milliseconds in one day. */
const DAY_MS = 86_400_000

/**
 * Format one last-activity time the way a person reads it.
 * @param at - epoch milliseconds; `0` when the time is unknown.
 * @returns a compact relative label.
 */
export function when(at: number): string {
  if (at <= 0) return '—'
  const elapsed = Date.now() - at
  if (elapsed < DAY_MS) return `${Math.max(1, Math.round(elapsed / HOUR_MS))}h`
  return `${Math.round(elapsed / DAY_MS)}d`
}

/**
 * Build the section component over the plugin's browser context.
 *
 * The seat passes only the translator, so the context arrives through this
 * closure rather than a module-level binding a reload would strand.
 * @param ctx - browser plugin context carrying the client services.
 * @returns the settings-section component.
 */
export function createArchivedProjectsSection(ctx: ArchivedProjectsSectionContext) {
  return function ArchivedProjectsSection({ t }: ArchivedProjectsSectionProps) {
    const workspaceState = useSyncExternalStore(
      listener => ctx.workspaces.list.subscribe(listener),
      () => ctx.workspaces.list.getSnapshot(),
    )
    const byId = useSyncExternalStore(
      listener => ctx.sessions.list.subscribe(listener),
      () => ctx.sessions.list.getSnapshot().byId,
    )
    const [busy, setBusy] = useState<readonly string[]>([])
    const [report, setReport] = useState<string | null>(null)
    const rows: readonly ArchivedWorkspaceRow[] = archivedWorkspaceRows({
      archivedWorkspaceIds: workspaceState.archivedWorkspaceIds,
      workspaces: workspaceState.items,
      sessions: byId,
    })

    const restoreOne = async (id: string, title: string): Promise<void> => {
      setBusy(current => [...current, id])
      setReport(null)
      try {
        await ctx.uiWorkspace.unarchiveWorkspace(id)
        setReport(t('restored', { title }))
      } catch {
        setReport(t('restoreFailed', { title }))
      } finally {
        setBusy(current => current.filter(pending => pending !== id))
      }
    }

    return (
      <div className="pap">
        <style>{ARCHIVED_CSS}</style>
        <div className="pap-head">
          <p className="pap-intro">{t('intro')}</p>
          <span className="pap-count">{rows.length > 0 ? t('count', { count: rows.length }) : ''}</span>
        </div>
        {report !== null && <p className="pap-report" role="status">{report}</p>}
        {rows.length === 0
          ? <p className="pap-empty">{t('empty')}</p>
          : (
            <div className="pap-list">
              {rows.map(row => (
                <div key={row.id} className="pap-row">
                  <div className="pap-title">
                    {row.title}
                    <div className="pap-meta" title={row.path}>
                      {row.path}
                      {' · '}
                      {t('lastActivity', { when: row.updatedAt === 0 ? t('never') : when(row.updatedAt) })}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="pap-button"
                    disabled={busy.includes(row.id)}
                    onClick={() => { void restoreOne(row.id, row.title) }}
                  >
                    {busy.includes(row.id) ? t('restoring') : t('restore')}
                  </button>
                </div>
              ))}
            </div>
          )}
      </div>
    )
  }
}
