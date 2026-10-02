import { useMemo, useState } from 'react'
import type { CronJobId, CronJobView, CronSnapshot } from '@deepseek-ai/dsh-api-cron-controller/client'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  InjectFace, PropsLocale, PropsRuntime, TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { CronPanelKey } from './locales.ts'
import { NS } from './locales.ts'
import {
  draftFor, draftRequest, formatDuration, formatInZone, newDraft, runSummary,
  type CronDraft, type CronDraftRequest,
} from './logic.ts'
import css from './CronPanel.module.css'
// Type-only: pulls the ui-conversation SlotMap merge for the header-actions seat.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** The observable scheduled-task source this panel binds as `useCron`. */
export interface CronPanelSource {
  /** Read the identity-stable current snapshot. */
  getSnapshot(): CronSnapshot
  /**
   * Subscribe to snapshot changes.
   * @param listener - invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

/** Registration-side business face for the scheduled-task panel. */
export interface CronPanelInjected {
  hooks: {
    /** Client scheduled-task snapshot bound by the renderer as `useCron`. */
    cron: CronPanelSource
  }
  /** Store a new task and report the refusal when the Host rejects it. */
  create: (request: CronDraftRequest) => Promise<string | null>
  /** Replace the stated fields of one task. */
  update: (request: CronDraftRequest & { readonly jobId: CronJobId }) => Promise<string | null>
  /** Turn one task's schedule on or off. */
  setEnabled: (jobId: CronJobId, enabled: boolean) => Promise<string | null>
  /** Remove one task. */
  remove: (jobId: CronJobId) => Promise<string | null>
  /** Run one task once, now. */
  runNow: (jobId: CronJobId) => Promise<string | null>
}

/** Full props for the scheduled-task panel. */
export type CronPanelProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<typeof NS>
  & InjectFace<CronPanelInjected>

/** The panel's translator face. */
type PanelTranslate = TranslateNS<typeof NS>

/** The line a refused command leaves in the panel: the copy key and its reason. */
interface Notice {
  readonly key: CronPanelKey
  readonly error: string
}

function outcomeKey(outcome: ReturnType<typeof runSummary>['outcome']): CronPanelKey {
  switch (outcome) {
    case 'completed': return 'outcome.completed'
    case 'failed': return 'outcome.failed'
    case 'timeout': return 'outcome.timeout'
    case 'blocked': return 'outcome.blocked'
    case 'interrupted': return 'outcome.interrupted'
    /* v8 ignore next -- the closed stored outcome union has no other member */
    default: return assertNever(outcome)
  }
}

/* v8 ignore next 3 -- closed stored outcome union */
function assertNever(value: never): never {
  throw new Error(`unhandled cron run outcome: ${JSON.stringify(value)}`)
}

function stateLabel(job: CronJobView, t: PanelTranslate): string {
  return t(job.enabled ? 'state.enabled' : 'state.disabled')
}

/** One task's row: its rule, zone, next occurrence, state, actions, and results. */
function CronRow({ job, now, t, armed, actions }: {
  job: CronJobView
  now: number
  t: PanelTranslate
  /** Whether this row's delete control is waiting for its confirming press. */
  armed: boolean
  actions: {
    edit: () => void
    remove: () => void
    toggle: () => void
    run: () => void
  }
}) {
  const [openResults, setOpenResults] = useState(false)
  const next = formatInZone(job.nextDueAt, job.timeZone)
  const overdue = job.nextDueAt <= now
  return (
    <li className={css.row}>
      <span className={css.cells}>
        <code className={css.expression}>{job.expression}</code>
        <span className={css.zone}>{job.timeZone}</span>
        <span className={css.next}>{next}</span>
        <span className={job.enabled ? css.stateOn : css.stateOff}>
          <StateDot state={job.enabled ? 'done' : 'idle'} className={css.stateDot} />
          {stateLabel(job, t)}
        </span>
        {overdue && job.enabled ? <span className={css.overdue}>{t('run.overdue')}</span> : null}
      </span>
      <span className={css.actions}>
        <button type="button" className={css.action} onClick={actions.run}>{t('run.now')}</button>
        <button type="button" className={css.action} onClick={actions.edit}>{t('action.edit')}</button>
        {/* The control's accessible name is the action it performs, so it is the
            button's own text: an aria-label restating the target task would
            contradict the visible label and name the same control two ways. */}
        <button type="button" className={css.action} onClick={actions.toggle}>
          {t(job.enabled ? 'state.disable' : 'state.enable')}
        </button>
        <button
          type="button"
          className={armed ? `${css.action} ${css.danger}` : css.action}
          onClick={actions.remove}
        >
          {t(armed ? 'action.deleteConfirm' : 'action.delete')}
        </button>
        <button
          type="button"
          className={css.action}
          aria-expanded={openResults}
          onClick={() => { setOpenResults(current => !current) }}
        >
          {t('recent.count', { count: job.recentRuns.length })}
        </button>
      </span>
      {openResults
        ? (
          <div className={css.results}>
            <div className={css.resultsTitle}>{t('recent.title')}</div>
            {job.recentRuns.length === 0
              ? <div className={css.resultsEmpty}>{t('recent.empty')}</div>
              : (
                <ul className={css.resultsList}>
                  {job.recentRuns.map((record, index) => {
                    const summary = runSummary(record)
                    return (
                      // Two runs can start in the same millisecond, so the
                      // position is part of the row's identity.
                      <li key={`${record.startedAt}:${index}`} className={css.result}>
                        {t('run.detail', {
                          outcome: t(outcomeKey(summary.outcome)),
                          time: formatInZone(summary.finishedAt, job.timeZone),
                          duration: formatDuration(summary.durationMs, t),
                        })}
                      </li>
                    )
                  })}
                </ul>
              )}
          </div>
        )
        : null}
    </li>
  )
}

/**
 * One labelled text control of the task form.
 *
 * The label element carries only the field's name. A hint inside it would be
 * concatenated into the input's accessible name, so the hint is a sibling the
 * input points at by id and is announced as a description instead.
 */
function Field({ id, label, value, onChange, hint }: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
}) {
  const hintId = `${id}-hint`
  return (
    <div className={css.field}>
      <label className={css.fieldLabel} htmlFor={id}>{label}</label>
      <input
        id={id}
        className={css.input}
        value={value}
        {...hint === undefined ? {} : { 'aria-describedby': hintId }}
        onChange={(event) => { onChange(event.target.value) }}
      />
      {hint === undefined ? null : <span className={css.hint} id={hintId}>{hint}</span>}
    </div>
  )
}

/** One labelled select control of the task form. */
function SelectField({ id, label, value, options, onChange }: {
  id: string
  label: string
  value: string
  options: readonly { readonly value: string; readonly label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <div className={css.field}>
      <label className={css.fieldLabel} htmlFor={id}>{label}</label>
      <select
        id={id}
        className={css.input}
        value={value}
        onChange={(event) => { onChange(event.target.value) }}
      >
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </div>
  )
}

/** One labelled multi-line control of the task form. */
function TextAreaField({ id, label, value, onChange }: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className={css.field}>
      <label className={css.fieldLabel} htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className={css.textarea}
        value={value}
        onChange={(event) => { onChange(event.target.value) }}
      />
    </div>
  )
}

/**
 * The create and edit form, fully controlled by the panel that owns the draft.
 *
 * The form holds no draft state of its own: the panel already owns it, and a
 * second copy inside the form would keep the values it first mounted with when
 * the same task is edited twice.
 */
function CronForm({ draft, saving, t, onChange, onSubmit, onCancel }: {
  draft: CronDraft
  saving: boolean
  t: PanelTranslate
  onChange: (fields: Partial<CronDraft>) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const editing = draft.jobId !== undefined
  return (
    <form
      className={css.form}
      aria-label={t(editing ? 'edit.title' : 'create.title')}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className={css.formTitle}>{t(editing ? 'edit.title' : 'create.title')}</div>
      <Field id="cron-expression" label={t('field.expression')} hint={t('field.expressionHint')} value={draft.expression} onChange={(expression) => { onChange({ expression }) }} />
      <Field id="cron-zone" label={t('field.timeZone')} value={draft.timeZone} onChange={(timeZone) => { onChange({ timeZone }) }} />
      <SelectField
        id="cron-target"
        label={t('field.targetKind')}
        value={draft.targetKind}
        options={[
          { value: 'new-session', label: t('target.newSession') },
          { value: 'session', label: t('target.session') },
        ]}
        onChange={(target) => { onChange({ targetKind: target === 'session' ? 'session' : 'new-session' }) }}
      />
      {draft.targetKind === 'session'
        ? <Field id="cron-session" label={t('field.sessionId')} value={draft.sessionId} onChange={(sessionId) => { onChange({ sessionId }) }} />
        : (
          <>
            <Field id="cron-workspace" label={t('field.workspacePath')} value={draft.workspacePath} onChange={(workspacePath) => { onChange({ workspacePath }) }} />
            <Field id="cron-agent" label={t('field.agentPreset')} value={draft.agentPreset} onChange={(agentPreset) => { onChange({ agentPreset }) }} />
            <Field id="cron-permission" label={t('field.permissionPreset')} value={draft.permissionPreset} onChange={(permissionPreset) => { onChange({ permissionPreset }) }} />
          </>
        )}
      <TextAreaField id="cron-prompt" label={t('field.prompt')} value={draft.prompt} onChange={(prompt) => { onChange({ prompt }) }} />
      <Field id="cron-max-run" label={t('field.maxRunMs')} value={draft.maxRunMs} onChange={(maxRunMs) => { onChange({ maxRunMs }) }} />
      <SelectField
        id="cron-overlap"
        label={t('field.overlapPolicy')}
        value={draft.overlapPolicy}
        options={[
          { value: 'skip', label: t('overlap.skip') },
          { value: 'queue-one', label: t('overlap.queue-one') },
        ]}
        onChange={(policy) => { onChange({ overlapPolicy: policy === 'queue-one' ? 'queue-one' : 'skip' }) }}
      />
      <SelectField
        id="cron-misfire"
        label={t('field.misfirePolicy')}
        value={draft.misfirePolicy}
        options={[
          { value: 'skip', label: t('misfire.skip') },
          { value: 'run-once-late', label: t('misfire.run-once-late') },
        ]}
        onChange={(policy) => { onChange({ misfirePolicy: policy === 'run-once-late' ? 'run-once-late' : 'skip' }) }}
      />
      <div className={css.formActions}>
        <button type="submit" className={css.primary} disabled={saving}>{t('action.save')}</button>
        <button type="button" className={css.action} onClick={onCancel}>{t('action.cancel')}</button>
      </div>
    </form>
  )
}

/**
 * Session-header entry point for the deployment's scheduled tasks. Mounting it
 * opens one panel; the follow stream itself belongs to the Client scheduled-task
 * service, so a second mounted header shares the same rows.
 * @param props - the runtime slot currency, the scheduled-task snapshot hook,
 *   the command callbacks, and the namespace translator.
 * @returns the trigger and its panel, or null while nothing can be managed.
 */
export function CronPanel({ useCron, create, update, setEnabled, remove, runNow, t }: CronPanelProps) {
  const snapshot = useCron(state => state)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<CronDraft | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  const [armedDelete, setArmedDelete] = useState<CronJobId | undefined>(undefined)
  const [running, setRunning] = useState<CronJobId | undefined>(undefined)
  const now = useMemo(() => Date.now(), [snapshot.items])

  const jobs = snapshot.items
  const countLabel = t(jobs.length === 1 ? 'trigger.one' : 'trigger.other', { count: jobs.length })

  const submit = (candidate: CronDraft): void => {
    setSaving(true)
    const request = draftRequest(candidate)
    const pending = candidate.jobId === undefined
      ? create(request)
      : update({ ...request, jobId: candidate.jobId })
    void pending
      .then((error) => {
        setNotice(error === null ? undefined : { key: 'save.failed', error })
        if (error === null) setDraft(undefined)
      })
      .finally(() => { setSaving(false) })
  }

  const pressDelete = (job: CronJobView): void => {
    if (armedDelete !== job.jobId) {
      setArmedDelete(job.jobId)
      return
    }
    setArmedDelete(undefined)
    void remove(job.jobId).then((error) => {
      setNotice(error === null ? undefined : { key: 'delete.failed', error })
    })
  }

  const pressRun = (job: CronJobView): void => {
    setRunning(job.jobId)
    void runNow(job.jobId)
      .then((error) => {
        setNotice(error === null ? undefined : { key: 'run.failed', error })
      })
      .finally(() => { setRunning(undefined) })
  }

  if (!open) {
    return (
      <button type="button" className={css.trigger} aria-label={t('trigger.aria')} onClick={() => { setOpen(true) }}>
        {countLabel}
      </button>
    )
  }

  return (
    <section className={css.panel} aria-label={t('list.aria')}>
      <div className={css.head}>
        <span className={css.heading}>{countLabel}</span>
        <button type="button" className={css.action} onClick={() => { setOpen(false) }}>{t('action.close')}</button>
        <button type="button" className={css.primary} onClick={() => { setDraft(newDraft()) }}>{t('action.create')}</button>
      </div>
      {notice === undefined ? null : <div className={css.notice}>{t(notice.key, { error: notice.error })}</div>}
      {snapshot.phase === 'connecting' ? <div className={css.status}>{t('status.loading')}</div> : null}
      {snapshot.phase === 'unavailable' ? <div className={css.status}>{t('status.unavailable')}</div> : null}
      {/* The notice is driven by the retained failure, so a terminal phase is
          never reported without the reason it ended on. */}
      {snapshot.error === null
        ? null
        : <div className={`${css.status} ${css.notice}`}>{t('status.error', { error: snapshot.error.message })}</div>}
      {draft === undefined
        ? null
        : (
          <CronForm
            draft={draft}
            saving={saving}
            t={t}
            onChange={(fields) => { setDraft({ ...draft, ...fields }) }}
            onSubmit={() => { submit(draft) }}
            onCancel={() => { setDraft(undefined) }}
          />
        )}
      {snapshot.phase === 'ready' && jobs.length === 0
        ? <div className={css.status}>{t('empty')}</div>
        : null}
      {jobs.length === 0
        ? null
        : (
          <ul className={css.list}>
            {jobs.map(job => (
              <CronRow
                key={String(job.jobId)}
                job={job}
                now={now}
                t={t}
                armed={armedDelete === job.jobId}
                actions={{
                  edit: () => { setDraft(draftFor(job)) },
                  remove: () => { pressDelete(job) },
                  toggle: () => {
                    void setEnabled(job.jobId, !job.enabled).then((error) => {
                      setNotice(error === null ? undefined : { key: 'save.failed', error })
                    })
                  },
                  run: () => { pressRun(job) },
                }}
              />
            ))}
          </ul>
        )}
      {running === undefined ? null : <div className={css.status}>{t('run.running')}</div>}
    </section>
  )
}
