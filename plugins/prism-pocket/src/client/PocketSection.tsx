/**
 * The Pocket settings section: the phone verdict and its copyable link, the
 * deployment steps still missing, push state, and the PWA install hint. It
 * calls the host routes directly over the authenticated channel.
 *
 * @module @prism/prism-pocket/client/PocketSection
 */

import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { POCKET_PUSH_SUBSCRIBE_PATH, POCKET_PUSH_TEST_PATH, POCKET_REMOTE_PATH } from '../routes.ts'
import { remoteCommands } from '../commands.ts'
import { promptInstall, subscribeThisDevice } from './pwa.ts'
import type { PocketLocaleKey } from './locales.ts'
import type { PocketRemoteStatus } from '../types.ts'

/** Section props bound by the settings shell. */
export type PocketSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'pocket.settings'>

/** One copyable deployment step: ordered, so the numbered marker carries information. */
interface Step {
  key: PocketLocaleKey
  code: string
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
export function PocketSection({ t }: PocketSectionProps) {
  const [status, setStatus] = useState<PocketRemoteStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pushNote, setPushNote] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [installEvent, setInstallEvent] = useState<Event | null>(null)
  const requestSeq = useRef(0)

  useEffect(() => {
    const seq = ++requestSeq.current
    void requestJson(POCKET_REMOTE_PATH)
      .then((value) => { if (requestSeq.current === seq) setStatus(readStatus(value)) })
      .catch((cause: unknown) => { if (requestSeq.current === seq) setError(cause instanceof Error ? cause.message : String(cause)) })
    const onInstallPrompt = (event: Event): void => {
      event.preventDefault()
      setInstallEvent(event)
    }
    window.addEventListener('beforeinstallprompt', onInstallPrompt)
    return () => { window.removeEventListener('beforeinstallprompt', onInstallPrompt) }
  }, [])

  const copy = (label: string, text: string): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(label)
      window.setTimeout(() => { setCopied(null) }, 1600)
    }).catch(() => {})
  }

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

  return (
    <div className='prism-page'>
      <section className='prism-panel'>
        <h3 className='prism-panel-title'>{t('phone.title')}</h3>
        <div className='prism-verdict' data-tone={verdict}>
          <p className='prism-verdict-text'>{t(verdict === 'ok' ? 'phone.ready' : blameKey(phone.blocker))}</p>
          {phone.display !== undefined && <code className='prism-address'>{phone.display}</code>}
        </div>
        {phone.url !== undefined && (
          <button
            type='button'
            className='prism-button prism-button-primary'
            onClick={() => copy('phone', phone.url ?? '')}
          >
            {copied === 'phone' ? t('phone.copied') : t('phone.copy')}
          </button>
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
        {steps.some(step => step.key === 'step.trust') && commands.trustedHost !== undefined && (
          <p className='prism-note'>
            {t('step.trust.cli')} <code className='prism-code prism-code-inline'>{commands.trustedHost}</code>
          </p>
        )}
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
