/**
 * The 语音识别 settings section: the default-recognizer switcher over the live
 * roster and one card per configured HTTP transcription service, with its
 * credential managed through the credential store.
 */

import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SpeechSettingsStore, type SpeechServiceConfig } from './store.ts'
import css from './SpeechSection.module.css'

/** Registration-side business face for the section. */
export interface SpeechSectionInjected {
  /** The page store owning section state. */
  readonly store: SpeechSettingsStore
}

/** Props the renderer binds for the section. */
export type SpeechSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.speech'>
  & InjectFace<SpeechSectionInjected>

/**
 * Render the speech settings page.
 * @param props - the section runtime face, copy, and page store.
 * @returns the section content.
 */
export function SpeechSection(props: SpeechSectionProps): ReactNode {
  const { t, store } = props
  const state = useSyncExternalStore(store.subscribe.bind(store), store.getSnapshot.bind(store))
  return (
    <div className={css.page}>
      <h2>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {state.roster === undefined
        ? <p className={css.hint}>{t('rosterUnavailable')}</p>
        : (
            <div className={css.card}>
              <label className={css.rowLabel} htmlFor='speech-default-recognizer'>{t('defaultRecognizer')}</label>
              <select
                id='speech-default-recognizer'
                className={css.select}
                value={state.roster.selected}
                onChange={event => { void store.selectProvider(event.target.value) }}
              >
                {state.roster.providers.map(provider =>
                  <option key={provider.id} value={provider.id}>{provider.name}</option>)}
              </select>
            </div>
          )}
      <h3>{t('services')}</h3>
      {state.services.map((service, index) => (
        <ServiceCard
          key={service.providerId ?? String(index)}
          service={service}
          index={index}
          store={store}
          t={t}
          keyConfigured={service.apiKeyEnv === undefined ? undefined : state.keyConfigured[service.apiKeyEnv]}
        />
      ))}
      <button type='button' className={css.addButton} onClick={() => { void store.addService() }}>{t('add')}</button>
      {state.notice !== undefined && <p className={css.error}>{t('writeFailed')}</p>}
    </div>
  )
}

/** One editable transcription-service card. */
function ServiceCard(props: {
  readonly service: SpeechServiceConfig
  readonly index: number
  readonly store: SpeechSettingsStore
  readonly t: TranslateNS<'settings.speech'>
  readonly keyConfigured: boolean | undefined
}): ReactNode {
  const { service, index, store, t, keyConfigured } = props
  const name = useRef<HTMLInputElement>(null)
  const endpoint = useRef<HTMLInputElement>(null)
  const model = useRef<HTMLInputElement>(null)
  const apiKeyEnv = useRef<HTMLInputElement>(null)
  const keyValue = useRef<HTMLInputElement>(null)
  const [keyNotice, setKeyNotice] = useState<string | undefined>(undefined)
  return (
    <div className={css.card}>
      <div className={css.row}>
        <span className={css.rowLabel}>{t('providerId')}</span>
        <code className={css.code}>{service.providerId}</code>
        {service.mode !== undefined && <span className={css.tag}>{service.mode}</span>}
        {keyConfigured !== undefined && (
          <span className={keyConfigured ? css.okTag : css.missingTag}>{keyConfigured ? t('keyConfigured') : t('keyMissing')}</span>
        )}
      </div>
      <label className={css.rowLabel}>
        {t('name')}
        <input className={css.input} ref={name} defaultValue={service.name ?? ''} />
      </label>
      <label className={css.rowLabel}>
        {t('endpoint')}
        <input className={css.input} ref={endpoint} defaultValue={service.endpoint ?? ''} />
      </label>
      <label className={css.rowLabel}>
        {t('model')}
        <input className={css.input} ref={model} defaultValue={service.model ?? ''} />
      </label>
      <label className={css.rowLabel}>
        {t('apiKeyEnv')}
        <input className={css.input} ref={apiKeyEnv} defaultValue={service.apiKeyEnv ?? ''} />
      </label>
      <div className={css.row}>
        <input
          className={css.input}
          ref={keyValue}
          type='password'
          placeholder={t('keyPlaceholder')}
          autoComplete='off'
        />
        <button
          type='button'
          className={css.button}
          onClick={() => {
            const ref = apiKeyEnv.current?.value ?? ''
            const value = keyValue.current?.value ?? ''
            if (ref.length === 0 || value.length === 0) return
            void store.storeKey(ref, value).then(refusal => { setKeyNotice(refusal) })
          }}
        >{t('keySet')}</button>
        {keyConfigured === true && (
          <button
            type='button'
            className={css.button}
            onClick={() => {
              const ref = apiKeyEnv.current?.value ?? ''
              if (ref.length === 0) return
              void store.removeKey(ref).then(refusal => { setKeyNotice(refusal) })
            }}
          >{t('keyRemove')}</button>
        )}
      </div>
      <p className={css.hint}>{keyNotice ?? t('keyHint')}</p>
      <div className={css.row}>
        <button
          type='button'
          className={css.button}
          onClick={() => {
            const modelValue = model.current?.value
            void store.saveService(index, {
              name: name.current?.value ?? '',
              endpoint: endpoint.current?.value ?? '',
              ...(modelValue === undefined || modelValue === '' ? {} : { model: modelValue }),
              apiKeyEnv: apiKeyEnv.current?.value ?? '',
            })
          }}
        >{t('save')}</button>
        <button
          type='button'
          className={css.dangerButton}
          onClick={() => {
            if (window.confirm(t('removeConfirm'))) void store.removeService(index)
          }}
        >{t('remove')}</button>
      </div>
    </div>
  )
}
