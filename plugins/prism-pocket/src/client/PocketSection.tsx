/**
 * The Pocket settings section: remote-access facts and commands, push state
 * with subscribe/test, and the PWA install hint. It calls the host routes
 * directly over the authenticated channel.
 *
 * @module @prism/prism-pocket/client/PocketSection
 */

import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { POCKET_PUSH_SUBSCRIBE_PATH, POCKET_PUSH_TEST_PATH, POCKET_REMOTE_PATH } from '../routes.ts'
import { isOriginTrusted, remoteCommands } from '../commands.ts'
import { promptInstall, subscribeThisDevice } from './pwa.ts'
import type { PocketRemoteStatus } from '../types.ts'

/** Section props bound by the settings shell. */
export type PocketSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'pocket.settings'>

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
    const publicKey = status.pocket.vapidPublicKey
    if (publicKey === null) {
      setPushNote(t('push.unsupported'))
      return
    }
    void (async () => {
      const publicKey = status.pocket.vapidPublicKey
      if (publicKey === null) {
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

  if (error !== null) {
    return <div className='prism-section-error'>{error}</div>
  }
  if (status === null) {
    return <div className='prism-section-loading'>…</div>
  }

  const trusted = isOriginTrusted(window.location.origin, status.server)
  const generated = remoteCommands(status.server, status.tailscale)
  const commands: ReadonlyArray<{ label: string; text: string | undefined }> = [
    { label: t('remote.commands.directIp'), text: generated.directIp },
    { label: t('remote.commands.serve'), text: generated.serve },
    { label: t('remote.commands.trustedHost'), text: generated.trustedHost },
    { label: t('remote.commands.publicUrl'), text: generated.publicUrl },
  ]

  return (
    <div className='prism-section'>
      <section>
        <h3>
          {t('remote.title')}
          {' '}
          <span className={trusted ? 'prism-badge-ok' : 'prism-badge-warn'}>{trusted ? t('remote.trusted') : t('remote.untrusted')}</span>
        </h3>
        <p>
          {t('remote.server')}: <code>{`${status.server.host}:${status.server.port}`}</code>
          {status.server.publicUrl !== undefined && (
            <>
              {' · '}
              {t('remote.publicUrl')}: <code>{status.server.publicUrl}</code>
            </>
          )}
        </p>
        <p>
          {t('remote.tailscale.available')}
          {': '}
          {status.tailscale.available
            ? <code>{[status.tailscale.dnsName, status.tailscale.ipv4].filter(Boolean).join(' · ')}</code>
            : t('remote.tailscale.unavailable')}
        </p>
        {status.tailscale.available && (
          <div className='prism-commands'>
            <h4>{t('remote.commands.title')}</h4>
            {commands.filter(command => command.text !== undefined).map(command => (
              <div key={command.label} className='prism-command'>
                <span className='prism-command-label'>{command.label}</span>
                <code>{command.text}</code>
                <button type='button' onClick={() => copy(command.label, command.text ?? '')}>
                  {copied === command.label ? t('remote.commands.copied') : t('remote.commands.copy')}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      <section>
        <h3>
          {t('push.title')}
          {' '}
          <span className='prism-badge'>{status.pocket.pushEnabled ? t('push.state.on') : t('push.state.off')}</span>
          {' '}
          <span className='prism-badge'>{status.pocket.barkConfigured ? t('push.bark.on') : t('push.bark.off')}</span>
        </h3>
        <p>{t('push.subscriptions').replace('{n}', String(status.pocket.subscriptions))}</p>
        <div className='prism-actions'>
          <button type='button' onClick={subscribe}>{t('push.subscribe')}</button>
          <button type='button' onClick={test}>{t('push.test')}</button>
        </div>
        {pushNote !== null && <p className='prism-note'>{pushNote}</p>}
      </section>
      <section>
        <h3>{t('pwa.title')}</h3>
        <p>{t('pwa.hint')}</p>
        {installEvent !== null && (
          <div className='prism-actions'>
            <button type='button' onClick={() => { void promptInstall(installEvent) }}>{t('pwa.title')}</button>
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * Narrow the status body field by field without trusting the wire; a
 * malformed body reads as the empty status rather than crashing the page.
 */
function readStatus(value: unknown): PocketRemoteStatus {
  const root = objectOf(value)
  const server = objectOf(root?.server)
  const tailscale = objectOf(root?.tailscale)
  const pocket = objectOf(root?.pocket)
  const publicUrl = stringOf(server?.publicUrl)
  const dnsName = stringOf(tailscale?.dnsName)
  const ipv4 = stringOf(tailscale?.ipv4)
  const detail = stringOf(tailscale?.detail)
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
