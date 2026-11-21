/**
 * The backup settings page: destination protocol and connection fields, what to
 * archive and how much of it to keep, the two actions this page owns (test the
 * connection, back up now), and the run history below them. Every edit stages
 * in the shared form model and writes on save; passwords are write-only and
 * report only whether the Host holds one.
 */

import type { ReactNode } from 'react'
import {
  Button, Checkbox, SegmentedControl, SettingsForm, SettingsSecretField, SettingsValueField,
  Tag, fileSizeText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BackupLocaleKey } from './locales.ts'
import type { BackupSectionFace, BackupSecretTexts } from './page-controller.ts'
import css from './BackupSection.module.css'

/**
 * Props the renderer binds for the backup page. The page is a leaf inside the
 * 数据 section's tab, so it receives copy and its own face, not section chrome.
 */
export type BackupSectionProps =
  PropsLocale<'settings.backup'>
  & InjectFace<BackupSectionFace>

/**
 * The form frame's copy, from this page's dictionary.
 * @param t - bound translator of the backup namespace.
 * @returns the labels {@link SettingsForm} renders.
 */
export function formLabels(t: (key: BackupLocaleKey) => string): SettingsFormLabels {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
}

/**
 * Render one text field over the staged form.
 * @param props - staged draft, copy, and the staging action.
 * @returns the labelled control.
 */
function TextField(props: {
  readonly id: string
  readonly field: string
  readonly draft: { readonly text: string; readonly overridden: boolean; readonly invalid: boolean }
  readonly label: string
  readonly hint?: string
  readonly numeric?: boolean
  readonly disabled: boolean
  readonly t: (key: BackupLocaleKey) => string
  readonly edit: (field: string, text: string) => void
  readonly reset: (field: string) => void
}): ReactNode {
  return (
    <SettingsValueField
      id={props.id}
      label={props.label}
      {...props.hint === undefined ? {} : { hint: props.hint }}
      {...props.numeric === true ? { numeric: true } : {}}
      overriddenLabel={props.t('overridden')}
      resetLabel={props.t('reset')}
      invalidLabel={props.t('invalidNumber')}
      disabled={props.disabled}
      {...props.draft}
      onEdit={(text) => { props.edit(props.field, text) }}
      onReset={() => { props.reset(props.field) }}
    />
  )
}

/**
 * Render one boolean toggle over the staged form.
 * @param props - staged draft, copy, and the staging action.
 * @returns the labelled toggle.
 */
function ToggleField(props: {
  readonly field: string
  readonly draft: { readonly text: string }
  readonly label: string
  readonly hint: string
  readonly disabled: boolean
  readonly edit: (field: string, text: string) => void
}): ReactNode {
  const checked = props.draft.text === 'true'
  return (
    <div className={css.toggle}>
      <Checkbox
        checked={checked}
        label={props.label}
        disabled={props.disabled}
        onChange={() => { props.edit(props.field, checked ? 'false' : 'true') }}
      />
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}

/**
 * Render the page's one write-only password control.
 * @param props - staged draft, presence, copy, and the staging action.
 * @returns the labelled secret control.
 */
function PasswordField(props: {
  readonly id: string
  readonly field: keyof BackupSecretTexts
  readonly text: string
  readonly configured: boolean
  readonly label: string
  readonly hint: string
  readonly disabled: boolean
  readonly t: (key: BackupLocaleKey) => string
  readonly edit: (field: string, text: string) => void
  readonly onClear: () => void
}): ReactNode {
  return (
    <div className={css.password}>
      <SettingsSecretField
        id={props.id}
        label={props.label}
        hint={props.hint}
        text={props.text}
        configured={props.configured}
        stateLabel={props.configured ? props.t('secretStored') : props.t('secretMissing')}
        disabled={props.disabled}
        onEdit={(text) => { props.edit(props.field, text) }}
      />
      {props.configured
        ? (
          <button type="button" className={css.reset} disabled={props.disabled} onClick={props.onClear}>
            {props.t('secretClear')}
          </button>
        )
        : null}
    </div>
  )
}

/**
 * Render the backup page.
 * @param props - runtime seat, locale copy, and the injected form and run state.
 * @returns the settings section.
 */
export function BackupSection(props: BackupSectionProps): ReactNode {
  const { t } = props
  const form = props.useBackupForm(snapshot => snapshot)
  const run = props.useBackupRun(snapshot => snapshot)
  const disabled = !form.writable
  const target = form.fields.targetType.text
  const phase = run.phase
  return (
    <section className={css.section}>
      <p className={css.notice}>{t('warning')}</p>
      <SettingsForm
        labels={formLabels(t)}
        state={{
          available: form.available,
          writable: form.writable,
          dirty: form.dirty,
          invalid: form.invalid,
          saving: form.saving,
          failed: form.failed,
        }}
        onSave={props.save}
        onDiscard={props.discard}
      >
        <div className={css.group}>
          <h3 className={css.groupTitle}>{t('destination')}</h3>
          <SegmentedControl
            id="prism-backup-protocol"
            label={t('protocol')}
            value={target}
            disabled={disabled}
            options={[
              { value: 'webdav', label: t('targetWebdav') },
              { value: 's3', label: t('targetS3') },
              { value: 'smb', label: t('targetSmb') },
            ]}
            onChange={(value) => { props.edit('targetType', value) }}
          />
          {target === 'webdav'
            ? (
              <TextField id="prism-backup-webdav-url" field="webdavUrl" draft={form.fields.webdavUrl}
                label={t('webdavUrl')} hint={t('webdavUrlHint')} disabled={disabled} t={t} edit={props.edit} reset={props.resetField} />
            )
            : null}
          {target === 's3'
            ? (
              <>
                <TextField id="prism-backup-s3-endpoint" field="s3Endpoint" draft={form.fields.s3Endpoint}
                  label={t('s3Endpoint')} hint={t('s3EndpointHint')} disabled={disabled} t={t} edit={props.edit} reset={props.resetField} />
                <TextField id="prism-backup-s3-region" field="s3Region" draft={form.fields.s3Region}
                  label={t('s3Region')} disabled={disabled} t={t} edit={props.edit} reset={props.resetField} />
                <TextField id="prism-backup-s3-bucket" field="s3Bucket" draft={form.fields.s3Bucket}
                  label={t('s3Bucket')} disabled={disabled} t={t} edit={props.edit} reset={props.resetField} />
                <TextField id="prism-backup-s3-access-key" field="s3AccessKeyId" draft={form.fields.s3AccessKeyId}
                  label={t('s3AccessKeyId')} disabled={disabled} t={t} edit={props.edit} reset={props.resetField} />
                <ToggleField field="s3PathStyle" draft={form.fields.s3PathStyle} label={t('s3PathStyle')}
                  hint={t('s3PathStyleHint')} disabled={disabled} edit={props.edit} />
              </>
            )
            : null}
          {target === 'smb'
            ? (
              <TextField id="prism-backup-smb-path" field="smbPath" draft={form.fields.smbPath}
                label={t('smbPath')} hint={t('smbPathHint')} disabled={disabled} t={t} edit={props.edit} reset={props.resetField} />
            )
            : null}
          {target === 's3'
            ? null
            : (
              <TextField id="prism-backup-username" field="username" draft={form.fields.username}
                label={t('username')} hint={t('usernameHint')} disabled={disabled} t={t} edit={props.edit} reset={props.resetField} />
            )}
          {target === 'webdav'
            ? (
              <PasswordField id="prism-backup-webdav-password" field="webdavPassword" text={form.secretText.webdavPassword}
                configured={run.secrets['webdav-password']} label={t('webdavPassword')} hint={t('passwordHint')}
                disabled={disabled} t={t} edit={props.edit} onClear={() => { props.clearSecret('webdav-password') }} />
            )
            : null}
          {target === 's3'
            ? (
              <PasswordField id="prism-backup-s3-secret" field="s3SecretKey" text={form.secretText.s3SecretKey}
                configured={run.secrets['s3-secret-key']} label={t('s3SecretKey')} hint={t('passwordHint')}
                disabled={disabled} t={t} edit={props.edit} onClear={() => { props.clearSecret('s3-secret-key') }} />
            )
            : null}
          {target === 'smb'
            ? (
              <PasswordField id="prism-backup-smb-password" field="smbPassword" text={form.secretText.smbPassword}
                configured={run.secrets['smb-password']} label={t('smbPassword')} hint={t('passwordHint')}
                disabled={disabled} t={t} edit={props.edit} onClear={() => { props.clearSecret('smb-password') }} />
            )
            : null}
          <TextField id="prism-backup-remote-dir" field="remoteDir" draft={form.fields.remoteDir}
            label={t('remoteDir')} hint={t('remoteDirHint')} disabled={disabled} t={t} edit={props.edit} reset={props.resetField} />
        </div>

        <div className={css.group}>
          <h3 className={css.groupTitle}>{t('content')}</h3>
          <ToggleField field="includeSettings" draft={form.fields.includeSettings} label={t('includeSettings')}
            hint={t('includeSettingsHint')} disabled={disabled} edit={props.edit} />
          <ToggleField field="includeMemory" draft={form.fields.includeMemory} label={t('includeMemory')}
            hint={t('includeMemoryHint')} disabled={disabled} edit={props.edit} />
          <ToggleField field="includeProjects" draft={form.fields.includeProjects} label={t('includeProjects')}
            hint={t('includeProjectsHint')} disabled={disabled} edit={props.edit} />
          <TextAreaField id="prism-backup-excludes" field="projectExcludes" draft={form.fields.projectExcludes}
            label={t('excludes')} hint={t('excludesHint')} disabled={disabled} t={t} edit={props.edit} reset={props.resetField} />
          <TextField id="prism-backup-keep" field="maxBackups" draft={form.fields.maxBackups}
            label={t('maxBackups')} hint={t('maxBackupsHint')} numeric disabled={disabled} t={t} edit={props.edit} reset={props.resetField} />
        </div>
      </SettingsForm>

      <div className={css.actions}>
        <Button variant="outline" size="sm" disabled={run.testing || run.running} onClick={props.test}>
          {run.testing ? t('testing') : t('test')}
        </Button>
        <Button variant="primary" size="sm" disabled={run.running || disabled} onClick={props.run}>
          {run.running ? t('running') : t('run')}
        </Button>
        {run.notice === undefined
          ? null
          : <p className={run.notice.tone === 'ok' ? css.ok : css.failed} role="status">{noticeText(t, run.notice.text)}</p>}
        {phase === undefined ? null : <p className={css.phase} role="status">{phase}</p>}
      </div>

      <div className={css.group}>
        <h3 className={css.groupTitle}>{t('history')}</h3>
        {run.history.length === 0
          ? <p className={css.hint}>{t('historyEmpty')}</p>
          : (
            <ul className={css.history}>
              {run.history.map(record => (
                <li key={record.id} className={css.historyRow}>
                  <span className={css.historyWhen}>{new Date(record.startedAt).toLocaleString()}</span>
                  <span className={record.status === 'success' ? css.ok : css.failed}>
                    {record.status === 'success' ? t('historySuccess') : t('historyFailed')}
                  </span>
                  <span className={css.historyMeta}>{record.targetType} · {record.endpoint}</span>
                  {record.sizeBytes === undefined ? null : <span className={css.historyMeta}>{fileSizeText(record.sizeBytes)}</span>}
                  {record.failure === undefined ? null : <span className={css.failed}>{record.failure.message}</span>}
                </li>
              ))}
            </ul>
          )}
      </div>
    </section>
  )
}

/** Notice texts this page owns as dictionary keys; everything else is a Host sentence. */
const NOTICE_KEYS = new Set<BackupLocaleKey>(['runOk', 'unreachable'])

/**
 * Render a notice: dictionary keys become sentences, Host messages pass through.
 * @param t - bound translator.
 * @param text - dictionary key or Host message.
 * @returns the sentence to show.
 */
function noticeText(t: (key: BackupLocaleKey) => string, text: string): string {
  return NOTICE_KEYS.has(text as BackupLocaleKey) ? t(text as BackupLocaleKey) : text
}

/**
 * Render a multi-line staged field, the shape a list of exclusions needs.
 * @param props - staged draft, copy, and the staging action.
 * @returns the labelled textarea.
 */
function TextAreaField(props: {
  readonly id: string
  readonly field: string
  readonly draft: { readonly text: string; readonly overridden: boolean }
  readonly label: string
  readonly hint: string
  readonly disabled: boolean
  readonly t: (key: BackupLocaleKey) => string
  readonly edit: (field: string, text: string) => void
  readonly reset: (field: string) => void
}): ReactNode {
  return (
    <div className={css.field}>
      <div className={css.fieldHead}>
        <label className={css.fieldLabel} htmlFor={props.id}>{props.label}</label>
        {props.draft.overridden
          ? (
            <span className={css.fieldBadges}>
              <Tag tone="neutral">{props.t('overridden')}</Tag>
              <button type="button" className={css.reset} disabled={props.disabled}
                onClick={() => { props.reset(props.field) }}>
                {props.t('reset')}
              </button>
            </span>
          )
          : null}
      </div>
      <textarea
        id={props.id}
        className={css.textarea}
        rows={6}
        value={props.draft.text}
        disabled={props.disabled}
        onChange={(event) => { props.edit(props.field, event.target.value) }}
      />
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}
