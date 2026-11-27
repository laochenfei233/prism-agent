/**
 * Settings · About section: the app's identity, the in-app updater (update
 * source switchable between the domestic mirror, GitHub Releases, and
 * user-added custom sources), and the project links.
 *
 * The section is a pure reader of the shell-injected update carrier. Outside
 * the desktop shell it degrades to one static line — no dead buttons — and a
 * carrier whose status times out renders the identity block with unknown
 * facts rather than pretending to know them.
 */
import { useEffect, useState } from 'react'
import {
  customEndpointsOf,
  deriveButtonState,
  endpointsForMode,
  deriveSourceMode,
  deriveSourceView,
  isValidEndpoint,
  readCarrier,
  type AboutUpdateSources,
  type AboutUpdateState,
  type ButtonState,
  type DesktopUpdateCarrier,
  type SourceMode,
  type UpdateFailureKind,
} from './about-bridge.ts'
import { ABOUT_CSS } from './styles.ts'

/** Props bound by the settings renderer. */
export interface AboutSectionProps {
  /** Closes the settings modal; the renderer binds it for every section. */
  close: () => void
  /** Translator bound to this plugin's namespace. */
  t: (key: string, params?: Record<string, string | number>) => string
}

/** Dictionary key of a classified failure's copy. */
const FAILURE_KEYS: Readonly<Record<UpdateFailureKind, string>> = {
  check: 'failureCheck',
  'check-network': 'failureCheckNetwork',
  download: 'failureDownload',
  'download-network': 'failureDownloadNetwork',
  install: 'failureInstall',
  'install-network': 'failureInstallNetwork',
  'stop-failed': 'failureStop',
}

/** The fork's repository, for the links the non-desktop About page still shows. */
const REPO = 'laochenfei233/prism-agent'

/** The primary button's label for its current state. */
function buttonLabel(button: ButtonState, t: AboutSectionProps['t']): string {
  switch (button) {
    case 'checking': return t('checking')
    case 'upToDate': return t('upToDate')
    case 'available': return t('availableAction')
    case 'error': return t('retry')
    default: return t('checkUpdate')
  }
}

/**
 * Render the About section.
 * @param props - the bound translator; the close callback is part of the
 *   section seat's props but this page never needs it.
 * @returns the section.
 */
export function AboutSection({ t }: AboutSectionProps) {
  const [carrier] = useState<DesktopUpdateCarrier | null>(() => readCarrier())
  const [state, setState] = useState<AboutUpdateState | null>(null)
  const [checked, setChecked] = useState(false)
  const [lastAction, setLastAction] = useState<'check' | 'install'>('check')
  const [sources, setSourcesState] = useState<AboutUpdateSources | null>(null)
  const [sourceDraft, setSourceDraft] = useState('')
  const [sourceNote, setSourceNote] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [customEditing, setCustomEditing] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent) => {
      if ((event.target as Element).closest('.pa-select') === null) setMenuOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', escape)
    }
  }, [menuOpen])

  useEffect(() => {
    if (carrier === null) return
    const unsubscribe = carrier.subscribe((next) => setState(next))
    void carrier.status().then(
      (initial) => setState((previous) => previous ?? initial),
      (error: unknown) => console.error('prism-about: update status unavailable:', error),
    )
    void carrier.sources?.().then(
      (list) => setSourcesState(list),
      (error: unknown) => console.error('prism-about: update sources unavailable:', error),
    )
    return unsubscribe
  }, [carrier])

  if (carrier === null) {
    // Outside the desktop shell (a phone browser) there is no update carrier:
    // still show the identity — name, embedded version, tagline — and the
    // project links, then the honest one-liner about the updater.
    return (
      <section className="pa-about" aria-label={t('nav')}>
        <style>{ABOUT_CSS}</style>
        <header className="pa-brand">
          <div className="pa-identity">
            <div className="pa-title">
              <h2>{t('appName')}</h2>
              <span className="pa-version" title={t('versionLabel')}>{process.env.DSH_CLIENT_VERSION ?? '—'}</span>
            </div>
            <p className="pa-muted">{t('tagline')}</p>
          </div>
        </header>
        <div className="pa-links">
          <a href={`https://github.com/${REPO}/releases`} target="_blank" rel="noreferrer">{t('changelog')}</a>
          <a href={`https://github.com/${REPO}/issues`} target="_blank" rel="noreferrer">{t('feedback')}</a>
        </div>
        <p className="pa-muted">{t('desktopOnly')}</p>
      </section>
    )
  }

  const runCheck = () => {
    setLastAction('check')
    // An older shell without the additive `check` degrades to `open`, whose
    // install flow re-checks first anyway; on success the shell exits, so the
    // resolution only ever marks the check completed for interactive paths.
    const check = carrier.check?.bind(carrier) ?? carrier.open.bind(carrier)
    void check().then(
      () => setChecked(true),
      (error: unknown) => {
        console.error('prism-about: update check failed:', error)
        setChecked(true)
      },
    )
  }

  const runInstall = () => {
    setLastAction('install')
    void carrier.open().then(
      () => undefined,
      (error: unknown) => console.error('prism-about: update install failed:', error),
    )
  }

  const button = deriveButtonState(state?.phase ?? 'idle', checked)
  const onPrimary = () => {
    if (button === 'available' || (button === 'error' && lastAction === 'install')) runInstall()
    else runCheck()
  }

  const phase = state?.phase ?? 'idle'
  const hint = state !== null && phase === 'available'
    ? t('availableHint', { version: state.version ?? '' })
    : state !== null && phase === 'error'
      ? t(FAILURE_KEYS[state.failure ?? 'check'])
      : null
  const percent = state?.percent
  const progressLine = phase === 'downloading'
    ? (percent === undefined ? t('downloadIndeterminate') : t('downloadProgress', { percent }))
    : phase === 'installing'
      ? t('installing')
      : phase === 'ready'
        ? t('ready')
        : null

  const repo = state?.source?.repo ?? ''
  const releaseUrl = state?.source?.releaseUrl ?? ''
  const { label } = deriveSourceView(state?.source)

  const busy = phase === 'checking' || phase === 'downloading' || phase === 'verifying' || phase === 'installing'
  const persistSources = (endpoints: readonly string[]) => {
    const setter = carrier.setSources?.bind(carrier)
    if (setter === undefined) return
    setSourceNote(null)
    void setter(endpoints).then(
      (next) => setSourcesState(next),
      (error: unknown) => {
        console.error('prism-about: update sources rejected:', error)
        setSourceNote(String(error))
      },
    )
  }
  const addCustomSource = () => {
    const value = sourceDraft.trim()
    if (value === '') return
    if (!isValidEndpoint(value)) {
      setSourceNote(t('sourcesInvalid'))
      return
    }
    const existing = sources === null ? [] : customEndpointsOf(sources.endpoints)
    if (existing.includes(value)) {
      setSourceDraft('')
      return
    }
    setSourceDraft('')
    persistSources(endpointsForMode('custom', sources?.defaultEndpoints ?? [], [...existing, value]))
  }
  const sourcesEditable = sources !== null && carrier.setSources !== undefined && !busy
  const mode: SourceMode = sources === null ? 'mirror' : deriveSourceMode(sources.endpoints)
  const customs = sources === null ? [] : customEndpointsOf(sources.endpoints)
  const selectorLabel = mode === 'mirror'
    ? t('sourcesMirrorOption')
    : mode === 'github'
      ? t('sourcesGithubOption')
      : t('sourcesCustomOption')
  const modeHint = mode === 'mirror'
    ? t('sourcesMirrorHint')
    : mode === 'github'
      ? t('sourcesGithubHint')
      : t('sourcesCustomHint')
  const toggleMenu = () => setMenuOpen((open) => !open)
  const pickMode = (next: SourceMode) => {
    setMenuOpen(false)
    setCustomEditing(next === 'custom')
    if (next !== 'custom') persistSources(endpointsForMode(next, sources?.defaultEndpoints ?? [], customs))
  }

  return (
    <section className="pa-about" aria-label={t('nav')}>
      <style>{ABOUT_CSS}</style>
      <header className="pa-brand">
        <div className="pa-identity">
          <div className="pa-title">
            <h2>{t('appName')}</h2>
            <span className="pa-version" title={t('versionLabel')}>{state?.currentVersion ?? '—'}</span>
          </div>
          <p className="pa-muted">{t('tagline')}</p>
          {hint !== null && <p className="pa-hint" data-tone={phase === 'error' ? 'error' : undefined}>{hint}</p>}
          {state?.lastCheck !== undefined && (
            <p className="pa-muted">{t('lastCheck', { time: new Date(state.lastCheck).toLocaleString() })}</p>
          )}
        </div>
        {button !== 'progress' && (
          <button
            type="button"
            data-variant={button === 'available' ? 'primary' : undefined}
            disabled={button === 'checking'}
            onClick={onPrimary}
          >
            {buttonLabel(button, t)}
          </button>
        )}
      </header>
      {progressLine !== null && (
        <div className="pa-progress" role="status">
          <div className="pa-bar">
            <i
              data-indeterminate={percent === undefined}
              style={percent === undefined ? undefined : { width: `${Math.round(percent)}%` }}
            />
          </div>
          <span className="pa-muted">{progressLine}</span>
        </div>
      )}
      <div className="pa-card pa-source-card">
        <div className="pa-row">
          <span className="pa-label">{t('sourceTitle')}</span>
          {sources !== null && (
            <div className="pa-select">
              <button
                type="button"
                className="pa-select-button"
                aria-haspopup="listbox"
                aria-expanded={menuOpen}
                disabled={!sourcesEditable}
                onClick={toggleMenu}
              >
                <span>{selectorLabel}</span>
                <i className="pa-caret" aria-hidden="true" />
              </button>
              {menuOpen && (
                <ul className="pa-menu" role="listbox">
                  <li>
                    <button
                      type="button"
                      role="option"
                      aria-selected={mode === 'mirror'}
                      data-active={mode === 'mirror' || undefined}
                      onClick={() => pickMode('mirror')}
                    >
                      {t('sourcesMirrorOption')}
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      role="option"
                      aria-selected={mode === 'github'}
                      data-active={mode === 'github' || undefined}
                      onClick={() => pickMode('github')}
                    >
                      {t('sourcesGithubOption')}
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      role="option"
                      aria-selected={mode === 'custom'}
                      data-active={mode === 'custom' || undefined}
                      onClick={() => pickMode('custom')}
                    >
                      {t('sourcesCustomOption')}
                    </button>
                  </li>
                </ul>
              )}
            </div>
          )}
        </div>
        <p className="pa-muted">{modeHint}</p>
        {label !== '' && mode === 'custom' && (
          <span className="pa-repo">{label}</span>
        )}
        {mode === 'custom' && (customEditing || customs.length > 0) && (
          <div className="pa-source-editor">
            {customs.length > 0 && (
              <ul className="pa-source-list">
                {customs.map((endpoint) => (
                  <li key={endpoint} className="pa-source-row">
                    <code className="pa-source-url">{endpoint}</code>
                    <span className="pa-source-actions">
                      <button
                        type="button"
                        className="pa-quiet"
                        disabled={!sourcesEditable}
                        onClick={() => persistSources(endpointsForMode('custom', sources?.defaultEndpoints ?? [], customs.filter((entry) => entry !== endpoint)))}
                      >
                        {t('sourcesRemove')}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="pa-source-add">
              <input
                className="pa-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('sourcesAddPlaceholder')}
                value={sourceDraft}
                disabled={!sourcesEditable}
                onChange={(event) => { setSourceDraft(event.target.value); setSourceNote(null) }}
              />
              <button
                type="button"
                disabled={!sourcesEditable || sourceDraft.trim() === ''}
                onClick={addCustomSource}
              >
                {t('sourcesAdd')}
              </button>
            </div>
            <p className="pa-muted">{t('sourcesCustomHint')}</p>
          </div>
        )}
        {sourceNote !== null && <p className="pa-hint" data-tone="error">{sourceNote}</p>}
        {busy && <p className="pa-muted">{t('sourcesBusy')}</p>}
      </div>
      <div className="pa-links">
        {releaseUrl !== '' && <a href={releaseUrl} target="_blank" rel="noreferrer">{t('changelog')}</a>}
        {repo !== '' && <a href={`https://github.com/${repo}/issues`} target="_blank" rel="noreferrer">{t('feedback')}</a>}
      </div>
    </section>
  )
}
