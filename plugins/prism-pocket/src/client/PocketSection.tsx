/**
 * The Pocket settings page: the phone verdict with its QR, the nine bot
 * channels, the push state, and the PWA install hint. It calls the host
 * routes directly over the authenticated channel.
 *
 * @module @prism/prism-pocket/client/PocketSection
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { POCKET_PUSH_SUBSCRIBE_PATH, POCKET_PUSH_TEST_PATH, POCKET_REMOTE_PATH } from '../routes.ts'
import { remoteCommands } from '../commands.ts'
import { promptInstall, subscribeThisDevice } from './pwa.ts'
import { CHANNEL_META, type BotChannelMeta } from './channel-meta.ts'
import { phoneQrSvg } from './qr.ts'
import type { PocketLocaleKey } from './locales.ts'
import type { PocketRemoteStatus } from '../types.ts'

/** Section props bound by the settings shell. */
export type PocketSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'pocket.settings'>

/** One copyable deployment step: ordered, so the numbered marker carries information. */
interface Step {
  key: PocketLocaleKey
  code: string
}

/** One channel's wire view, narrowed by {@link readBots}. */
interface BotView {
  readonly channel: string
  readonly enabled: boolean
  readonly status: 'off' | 'starting' | 'online' | 'error'
  readonly detail?: string
  readonly setFields: ReadonlySet<string>
  readonly callback?: boolean
}

/** Read one JSON route; failures surface as text. */
async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const detail = typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error: unknown }).error)
      : String(response.status)
    throw new Error(detail)
  }
  return body
}

/** Render the Pocket page. */
export function PocketSection({ t }: PocketSectionProps): ReactElement {
  const [status, setStatus] = useState<PocketRemoteStatus | null>(null)
  const [bots, setBots] = useState<readonly BotView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pushNote, setPushNote] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [installEvent, setInstallEvent] = useState<Event | null>(null)
  const requestSeq = useRef(0)

  const refresh = useCallback(async (seq: number): Promise<void> => {
    const [remote, botsBody] = await Promise.all([
      requestJson(POCKET_REMOTE_PATH),
      requestJson('/api/pocket/bots').catch(() => undefined),
    ])
    if (requestSeq.current !== seq) return
    setStatus(readStatus(remote))
    if (botsBody !== undefined) setBots(readBots(botsBody))
  }, [])

  useEffect(() => {
    const seq = ++requestSeq.current
    void refresh(seq).catch((cause: unknown) => {
      if (requestSeq.current === seq) setError(cause instanceof Error ? cause.message : String(cause))
    })
    const onInstallPrompt = (event: Event): void => {
      event.preventDefault()
      setInstallEvent(event)
    }
    window.addEventListener('beforeinstallprompt', onInstallPrompt)
    const poll = setInterval(() => {
      const current = requestSeq.current
      void refresh(current).catch(() => undefined)
    }, 8000)
    return () => {
      window.removeEventListener('beforeinstallprompt', onInstallPrompt)
      clearInterval(poll)
    }
  }, [refresh])

  const copy = (label: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(label)
      window.setTimeout(() => { setCopied(null) }, 1600)
    }).catch(() => {})
  }

  const act = (channel: string, action: string, config?: unknown): Promise<void> =>
    requestJson('/api/pocket/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config === undefined ? { channel, action } : { channel, action, config, enabled: true }),
    }).then((value) => { setBots(readBots(value)) })

  const subscribe = (): void => {
    if (status === null) return
    void (async () => {
      const publicKey = status.pocket.vapidPublicKey
      if (publicKey === '') {
        setPushNote(t('push.unsupported'))
        return
      }
      const outcome = await subscribeThisDevice(publicKey, async (subscription) => {
        await requestJson(POCKET_PUSH_SUBSCRIBE_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription),
        })
      })
      setPushNote(outcome === 'subscribed' ? t('push.subscribed') : outcome === 'denied' ? t('push.denied') : t('push.unsupported'))
      const refreshed = await requestJson(POCKET_REMOTE_PATH)
      setStatus(readStatus(refreshed))
    })().catch((cause: unknown) => { setPushNote(cause instanceof Error ? cause.message : String(cause)) })
  }

  const test = (): void => {
    void requestJson(POCKET_PUSH_TEST_PATH, { method: 'POST' })
      .then((value) => {
        const delivered = typeof value === 'object' && value !== null && typeof (value as { delivered?: unknown }).delivered === 'number'
          ? (value as { delivered: number }).delivered
          : 0
        setPushNote(delivered > 0 ? t('push.test.ok').replace('{n}', String(delivered)) : t('push.test.none'))
      })
      .catch((cause: unknown) => { setPushNote(cause instanceof Error ? cause.message : String(cause)) })
  }

  if (error !== null) return <p className='prism-page-message' data-tone='error'>{error}</p>
  // A Host half that predates the phone block answers without one; claim nothing.
  if (status === null || (status.phone.url === undefined && status.phone.blocker === undefined)) {
    return <p className='prism-page-message'>{t('phone.title')}</p>
  }

  const commands = remoteCommands(status.server, status.tailscale)
  const { phone } = status
  const verdict = verdictOf(phone)

  const steps: Step[] = []
  if (commands.serve !== undefined && phone.blocker === 'not-serving') {
    steps.push({ key: 'step.serve', code: commands.serve })
  }
  if (commands.trust !== undefined && phone.blocker === 'untrusted') {
    steps.push({ key: 'step.trust', code: commands.trust })
  }

  const publicOrigin = phone.url !== undefined ? new URL(phone.url).origin : undefined

  return (
    <div className='prism-page'>
      <section className='prism-panel'>
        <h3 className='prism-panel-title'>{t('phone.title')}</h3>
        <div className='prism-phone'>
          <div className='prism-phone-qr'>
            {phone.url !== undefined
              ? <div className='prism-qr' aria-label={t('phone.qr')} dangerouslySetInnerHTML={{ __html: phoneQrSvg(phone.url) }} />
              : <p className='prism-qr-empty'>{t('phone.qr.unavailable')}</p>}
            <span className='prism-qr-caption'>{t('phone.qr')}</span>
          </div>
          <div className='prism-phone-side'>
            <div className='prism-verdict' data-tone={verdict}>
              <p className='prism-verdict-text'>{t(verdict === 'ok' ? 'phone.ready' : blameKey(phone.blocker))}</p>
              {phone.display !== undefined && <code className='prism-address'>{phone.display}</code>}
            </div>
            {phone.url !== undefined && (
              <div className='prism-actions'>
                <button
                  type='button'
                  className='prism-button prism-button-primary'
                  onClick={() => copy('phone', phone.url ?? '')}
                >
                  {copied === 'phone' ? t('phone.copied') : t('phone.copy')}
                </button>
              </div>
            )}
            {steps.length > 0 && (
              <div className='prism-steps'>
                <h4 className='prism-steps-title'>{t('phone.steps')}</h4>
                {steps.map((step, index) => (
                  <div key={step.key} className='prism-step'>
                    <span className='prism-step-number'>{index + 1}</span>
                    <div className='prism-step-body'>
                      <span className='prism-step-label'>{t(step.key)}</span>
                      <code className='prism-code'>{step.code}</code>
                      {step.key === 'step.trust' && <span className='prism-step-hint'>{t('step.trust.hint')}</span>}
                      <button
                        type='button'
                        className='prism-button prism-button-quiet'
                        onClick={() => copy(step.key, step.code)}
                      >
                        {copied === step.key ? t('phone.copied') : t('phone.copy')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className='prism-panel'>
        <h3 className='prism-panel-title'>{t('bots.title')}</h3>
        <p className='prism-note'>{t('bots.intro')}</p>
        <div className='prism-channels'>
          {bots.map(bot => {
            const meta = CHANNEL_META.find(entry => entry.id === bot.channel)
            return meta === undefined ? null : (
              <ChannelCard
                key={bot.channel}
                meta={meta}
                view={bot}
                t={t}
                copied={copied}
                onCopy={copy}
                act={act}
                publicOrigin={publicOrigin}
              />
            )
          })}
        </div>
      </section>

      <section className='prism-panel'>
        <h3 className='prism-panel-title'>{t('push.title')}</h3>
        <p className='prism-facts'>
          <span>{status.pocket.pushEnabled ? t('push.state.on') : t('push.state.off')}</span>
          <span aria-hidden='true'>·</span>
          <span>{status.pocket.barkConfigured ? t('push.bark.on') : t('push.bark.off')}</span>
          <span aria-hidden='true'>·</span>
          <span>{t('push.subscriptions').replace('{n}', String(status.pocket.subscriptions))}</span>
        </p>
        <div className='prism-actions'>
          <button type='button' className='prism-button prism-button-primary' onClick={subscribe}>{t('push.subscribe')}</button>
          <button type='button' className='prism-button prism-button-quiet' onClick={test}>{t('push.test')}</button>
        </div>
        {pushNote !== null && <p className='prism-note'>{pushNote}</p>}
      </section>

      <section className='prism-panel'>
        <h3 className='prism-panel-title'>{t('pwa.title')}</h3>
        <p className='prism-note'>{t('pwa.hint')}</p>
        {installEvent !== null && (
          <div className='prism-actions'>
            <button
              type='button'
              className='prism-button prism-button-quiet'
              onClick={() => { void promptInstall(installEvent) }}
            >
              {t('pwa.title')}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

/** One bot channel card: chip, status, and the expandable credential form. */
function ChannelCard(props: {
  readonly meta: BotChannelMeta
  readonly view: BotView
  readonly t: (key: PocketLocaleKey) => string
  readonly copied: string | null
  readonly onCopy: (label: string, text: string) => void
  readonly act: (channel: string, action: string, config?: unknown) => Promise<void>
  readonly publicOrigin: string | undefined
}): ReactElement {
  const { meta, view, t, copied, onCopy, act, publicOrigin } = props
  const [expanded, setExpanded] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [region, setRegion] = useState<'feishu' | 'lark'>('feishu')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const run = (action: string): void => {
    if (busy) return
    setBusy(true)
    setNote(null)
    void act(meta.id, action)
      .then(() => {
        if (action === 'start') setNote(t('bots.started'))
        if (action === 'stop') setNote(t('bots.stopped'))
        if (action === 'test') setNote(t('bots.tested'))
      })
      .catch((cause: unknown) => { setNote(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(false) })
  }

  const save = (): void => {
    if (busy) return
    setNote(null)
    const config: Record<string, unknown> = meta.id === 'feishu' ? { region } : {}
    const complete = meta.fields.every(field => {
      if (field.region) return true
      const value = values[field.name]
      if (typeof value === 'string' && value.trim().length > 0) {
        config[field.name] = value.trim()
        return true
      }
      // A secret already stored can stay stored: only set fields travel.
      return view.setFields.has(field.name)
    })
    if (!complete) {
      setNote(t('bots.missing'))
      return
    }
    setBusy(true)
    void act(meta.id, 'config', config)
      .then(() => {
        setValues({})
        setNote(t('bots.saved'))
      })
      .catch((cause: unknown) => { setNote(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { setBusy(false) })
  }

  const callbackUrl = meta.callback === true && publicOrigin !== undefined
    ? `${publicOrigin}/pocket/bots/${meta.id}/callback`
    : undefined
  const statusKey = STATUS_KEYS[view.status]
  const running = view.enabled && view.status !== 'off'

  return (
    <article className='prism-channel'>
      <header className='prism-channel-head'>
        <span className='prism-channel-chip' style={{ background: meta.color }} aria-hidden='true'>{meta.chip}</span>
        <div className='prism-channel-name'>
          <span className='prism-channel-title'>{t(meta.label)}</span>
          {meta.callback === true && <span className='prism-channel-tag'>{t('bots.tag.callback')}</span>}
        </div>
        <span className='prism-channel-status' data-tone={view.status}>
          {t(statusKey)}{view.detail !== undefined && view.status === 'error' ? ` · ${view.detail}` : ''}
        </span>
        <div className='prism-channel-actions'>
          {running
            ? <button type='button' className='prism-button prism-button-quiet' disabled={busy} onClick={() => { run('stop') }}>{t('bots.stop')}</button>
            : <button type='button' className='prism-button prism-button-quiet' disabled={busy} onClick={() => { run('start') }}>{t('bots.start')}</button>}
          <button type='button' className='prism-button prism-button-quiet' disabled={busy} onClick={() => { run('test') }}>{t('bots.test')}</button>
          <button
            type='button'
            className='prism-button prism-button-quiet'
            aria-expanded={expanded}
            onClick={() => { setExpanded(value => !value) }}
          >
            {expanded ? t('bots.fold') : t('bots.configure')}
          </button>
        </div>
      </header>
      {expanded && (
        <div className='prism-channel-form'>
          <p className='prism-channel-hint'>{t(meta.hint)}</p>
          {meta.consoleUrl !== undefined && (
            <p className='prism-channel-hint'>
              <a className='prism-channel-link' href={meta.consoleUrl} target='_blank' rel='noreferrer'>{t('bots.console')}</a>
            </p>
          )}
          {meta.fields.map(field => field.region ? (
            <label key={field.name} className='prism-field'>
              <span className='prism-field-label'>{t('field.region')}</span>
              <select
                className='prism-input'
                value={region}
                onChange={(event) => { setRegion(event.target.value === 'lark' ? 'lark' : 'feishu') }}
              >
                <option value='feishu'>{t('field.region.feishu')}</option>
                <option value='lark'>{t('field.region.lark')}</option>
              </select>
            </label>
          ) : (
            <label key={field.name} className='prism-field'>
              <span className='prism-field-label'>
                {t(`field.${field.name}` as PocketLocaleKey)}
                {view.setFields.has(field.name) && <span className='prism-field-set'> · {t('bots.field.stored')}</span>}
              </span>
              <input
                className='prism-input'
                type={field.secret === true ? 'password' : 'text'}
                autoComplete='off'
                value={values[field.name] ?? ''}
                onChange={(event) => { setValues(previous => ({ ...previous, [field.name]: event.target.value })) }}
                placeholder={view.setFields.has(field.name) ? t('bots.field.placeholder') : ''}
              />
            </label>
          ))}
          {callbackUrl !== undefined && (
            <div className='prism-field'>
              <span className='prism-field-label'>{t('bots.callback')}</span>
              <code className='prism-code'>{callbackUrl}</code>
              <div className='prism-actions'>
                <button type='button' className='prism-button prism-button-quiet' onClick={() => { onCopy(meta.id, callbackUrl) }}>
                  {copied === meta.id ? t('phone.copied') : t('phone.copy')}
                </button>
              </div>
              <span className='prism-step-hint'>{t('bots.callback.hint')}</span>
            </div>
          )}
          <div className='prism-actions'>
            <button type='button' className='prism-button prism-button-primary' disabled={busy} onClick={save}>{t('bots.save')}</button>
          </div>
          {note !== null && <p className='prism-note'>{note}</p>}
        </div>
      )}
    </article>
  )
}

/** The status label key per wire status. */
const STATUS_KEYS: Record<BotView['status'], PocketLocaleKey> = {
  off: 'status.off',
  starting: 'status.starting',
  online: 'status.online',
  error: 'status.error',
}

/** The verdict tone the stylesheet colors the strip with. */
type Verdict = 'ok' | 'wait' | 'blocked'

/** Map the host's blocker to one tone: fixed, one step left, or no route at all. */
function verdictOf(phone: PocketRemoteStatus['phone']): Verdict {
  if (phone.blocker === undefined) return 'ok'
  if (phone.blocker === 'not-serving' || phone.blocker === 'untrusted') return 'wait'
  return 'blocked'
}

/** The sentence explaining the current blocker. */
function blameKey(blocker: PocketRemoteStatus['phone']['blocker']): PocketLocaleKey {
  switch (blocker) {
    case 'loopback': return 'phone.blocked.loopback'
    case 'no-tailscale': return 'phone.blocked.noTailscale'
    case 'not-serving': return 'phone.blocked.notServing'
    case 'untrusted': return 'phone.blocked.untrusted'
    default: return 'phone.ready'
  }
}

const BLOCKERS: ReadonlySet<string> = new Set(['loopback', 'no-tailscale', 'not-serving', 'untrusted'])

const STATUSES: ReadonlySet<string> = new Set(['off', 'starting', 'online', 'error'])

/**
 * Narrow the status body field by field without trusting the wire; a
 * malformed body reads as the empty status rather than crashing the page.
 */
function readStatus(value: unknown): PocketRemoteStatus {
  const root = objectOf(value)
  const server = objectOf(root?.server)
  const tailscale = objectOf(root?.tailscale)
  const pocket = objectOf(root?.pocket)
  const phone = objectOf(root?.phone)
  const publicUrl = stringOf(server?.publicUrl)
  const dnsName = stringOf(tailscale?.dnsName)
  const ipv4 = stringOf(tailscale?.ipv4)
  const detail = stringOf(tailscale?.detail)
  const blocker = typeof phone?.blocker === 'string' && BLOCKERS.has(phone.blocker)
    ? phone.blocker as NonNullable<PocketRemoteStatus['phone']['blocker']>
    : undefined
  const phoneUrl = stringOf(phone?.url)
  const phoneDisplay = stringOf(phone?.display)
  const vapidPublicKey = stringOf(pocket?.vapidPublicKey)
  return {
    server: {
      host: stringOf(server?.host) ?? '',
      port: numberOr(server?.port, 0),
      ...(publicUrl !== undefined ? { publicUrl } : {}),
      trustedHosts: Array.isArray(server?.trustedHosts) ? server.trustedHosts.filter(entry => typeof entry === 'string') : [],
    },
    tailscale: {
      available: tailscale?.available === true,
      ...(dnsName !== undefined ? { dnsName } : {}),
      ...(ipv4 !== undefined ? { ipv4 } : {}),
      ...(detail !== undefined ? { detail } : {}),
    },
    phone: {
      trusted: phone?.trusted === true,
      ...(blocker !== undefined ? { blocker } : {}),
      ...(phoneUrl !== undefined ? { url: phoneUrl } : {}),
      ...(phoneDisplay !== undefined ? { display: phoneDisplay } : {}),
    },
    pocket: {
      pushEnabled: pocket?.pushEnabled === true,
      notifyTurnComplete: pocket?.notifyTurnComplete === true,
      barkConfigured: pocket?.barkConfigured === true,
      ...(vapidPublicKey !== undefined ? { vapidPublicKey } : { vapidPublicKey: '' }),
      subscriptions: numberOr(pocket?.subscriptions, 0),
    },
  }
}

/** Narrow the bots list body; a malformed body reads as an empty list. */
function readBots(value: unknown): readonly BotView[] {
  const bots = objectOf(value)?.bots
  if (!Array.isArray(bots)) return []
  return bots.flatMap(bot => {
    const record = objectOf(bot)
    const channel = stringOf(record?.channel)
    if (channel === undefined) return []
    const status = typeof record?.status === 'string' && STATUSES.has(record.status)
      ? record.status as BotView['status']
      : 'off'
    const fields = Array.isArray(record?.fields) ? record.fields : []
    const setFields = new Set(fields
      .flatMap(field => typeof field === 'object' && field !== null && (field as { set?: unknown }).set === true
        ? [stringOf((field as { name?: unknown }).name) ?? '']
        : [])
      .filter(name => name.length > 0))
    const detail = stringOf(record?.detail)
    return [{
      channel,
      enabled: record?.enabled === true,
      status,
      ...(detail !== undefined ? { detail } : {}),
      setFields,
      ...(stringOf(record?.callbackPath) !== undefined ? { callback: true } : {}),
    }]
  })
}

/** `value as Record<string, unknown> | undefined` without an assertion ladder. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Defined-string reader for optional wire fields. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Defined-number reader for optional wire fields. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
