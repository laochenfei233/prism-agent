/**
 * Settings · About section: the app's identity, the in-app updater (update
 * source fixed to this repository's GitHub Releases), and the project links.
 *
 * The section is a pure reader of the shell-injected update carrier. Outside
 * the desktop shell it degrades to one static line — no dead buttons — and a
 * carrier whose status times out renders the identity block with unknown
 * facts rather than pretending to know them.
 */
import { useEffect, useState } from 'react'
import {
  deriveButtonState,
  readCarrier,
  type AboutUpdateState,
  type ButtonState,
  type DesktopUpdateCarrier,
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

  useEffect(() => {
    if (carrier === null) return
    const unsubscribe = carrier.subscribe((next) => setState(next))
    void carrier.status().then(
      (initial) => setState((previous) => previous ?? initial),
      (error: unknown) => console.error('prism-about: update status unavailable:', error),
    )
    return unsubscribe
  }, [carrier])

  if (carrier === null) {
    return (
      <section className="pa-about" aria-label={t('nav')}>
        <style>{ABOUT_CSS}</style>
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
      <div className="pa-card">
        <div className="pa-row">
          <span className="pa-label">{t('sourceTitle')}</span>
          <span className="pa-badge">{t('sourceGitHub')}</span>
        </div>
        {repo !== ''
          ? <a className="pa-repo" href={releaseUrl} target="_blank" rel="noreferrer">{repo}</a>
          : <span className="pa-muted">{t('sourceUnavailable')}</span>}
      </div>
      <div className="pa-links">
        {releaseUrl !== '' && <a href={releaseUrl} target="_blank" rel="noreferrer">{t('changelog')}</a>}
        {repo !== '' && <a href={`https://github.com/${repo}/issues`} target="_blank" rel="noreferrer">{t('feedback')}</a>}
      </div>
    </section>
  )
}
