// @vitest-environment jsdom

/**
 * The scheduled-task panel's presentation: rows, the create and edit form, the
 * two-press delete, run-now, recent results, and the phases it reports before
 * any row exists.
 *
 * Every query is scoped to the panel region or to one task row, because the
 * panel repeats a control per task: an unscoped `getByRole` for "Delete" finds
 * one match per row, and a match count is not a property of the panel.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type MockedFunction } from 'vitest'
import type { CronJobId, CronJobView, CronSnapshot } from '@deepseek-ai/dsh-api-cron-controller/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { CronPanel, type CronPanelProps } from '../src/client/CronPanel.tsx'
import { en, NS } from '../src/client/locales.ts'

const t = ((key: keyof typeof en, params?: Record<string, string | number>) => {
  const template = en[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name]))
}) as TranslateNS<typeof NS>

afterEach(() => { cleanup() })

function job(overrides: Partial<CronJobView> = {}): CronJobView {
  return {
    jobId: 'cron-1' as CronJobId,
    expression: '0 9 * * 1-5',
    timeZone: 'UTC',
    enabled: true,
    target: {
      kind: 'new-session',
      workspacePath: '/work',
      agentPreset: 'default',
      permissionPreset: 'ask',
      model: null,
    },
    prompt: 'run the report',
    overlapPolicy: 'skip',
    misfirePolicy: 'skip',
    maxRunMs: 5_000,
    createdAt: 0,
    updatedAt: 0,
    nextDueAt: Date.UTC(2030, 0, 1),
    recentRuns: [],
    ...overrides,
  }
}

/** The panel's framework seat: a selector hook over the supplied snapshot. */
function useCronOf(snapshot: CronSnapshot): CronPanelProps['useCron'] {
  return selector => selector(snapshot)
}

/** Every command a case asserts on, declared as the seat the panel receives. */
interface CommandMocks {
  create: MockedFunction<CronPanelProps['create']>
  update: MockedFunction<CronPanelProps['update']>
  setEnabled: MockedFunction<CronPanelProps['setEnabled']>
  remove: MockedFunction<CronPanelProps['remove']>
  runNow: MockedFunction<CronPanelProps['runNow']>
}

/** One builder per command: the panel's command signatures differ per verb, so each stub is the concrete mock its own seat member takes. */
const stubBuilders: { [Name in keyof CommandMocks]: () => CommandMocks[Name] } = {
  create: () => vi.fn<CronPanelProps['create']>(async () => null),
  update: () => vi.fn<CronPanelProps['update']>(async () => null),
  setEnabled: () => vi.fn<CronPanelProps['setEnabled']>(async () => null),
  remove: () => vi.fn<CronPanelProps['remove']>(async () => null),
  runNow: () => vi.fn<CronPanelProps['runNow']>(async () => null),
}

/** One command stub answering success until a case scripts a refusal. */
function commandMock<Name extends keyof CommandMocks>(name: Name): CommandMocks[Name] {
  return stubBuilders[name]()
}

function props(snapshot: CronSnapshot, overrides: Partial<CommandMocks> = {}): CronPanelProps {
  return {
    sessionId: 'session-1',
    useCron: useCronOf(snapshot),
    create: commandMock('create'),
    update: commandMock('update'),
    setEnabled: commandMock('setEnabled'),
    remove: commandMock('remove'),
    runNow: commandMock('runNow'),
    ...overrides,
    t,
  } as CronPanelProps
}

const ready = (items: readonly CronJobView[]): CronSnapshot => ({ items, phase: 'ready', error: null })

/** The open panel region, which is where every control it owns lives. */
function panel(): HTMLElement {
  return screen.getByRole('region', { name: en['list.aria'] })
}

/** One task row by its position in the published order. */
function row(index: number): HTMLElement {
  const rows = within(panel()).getAllByRole('listitem')
  const found = rows[index]
  if (found === undefined) throw new Error(`the panel published no task row at position ${index}`)
  return found
}

/** The panel's own control with that accessible name. */
function control(name: string): HTMLElement {
  return within(panel()).getByRole('button', { name })
}

/** One task row's control with that accessible name. */
function rowControl(index: number, name: string): HTMLElement {
  return within(row(index)).getByRole('button', { name })
}

/** Open the panel from its trigger. */
function open(): void {
  act(() => { fireEvent.click(screen.getByRole('button', { name: en['trigger.aria'] })) })
}

/** Set the text of one labelled control. */
function type(label: string, value: string): void {
  act(() => { fireEvent.change(screen.getByLabelText(label), { target: { value } }) })
}

/** Press one of the panel's own controls. */
function press(name: string): void {
  act(() => { fireEvent.click(control(name)) })
}

/** Press one task row's control. */
function pressRow(index: number, name: string): void {
  act(() => { fireEvent.click(rowControl(index, name)) })
}

/** Press one row control and settle the asynchronous command its handler starts. */
async function pressRowAsync(index: number, name: string): Promise<void> {
  await act(async () => { fireEvent.click(rowControl(index, name)) })
}

/** Press the panel's save control and settle the command its handler starts. */
async function pressAsync(name: string): Promise<void> {
  await act(async () => { fireEvent.click(control(name)) })
}

describe('CronPanel phases', () => {
  it('collapses to a trigger until the user opens it', () => {
    render(<CronPanel {...props(ready([]))} />)
    const trigger = screen.getByRole('button', { name: en['trigger.aria'] })
    expect(trigger.textContent).toContain('0 scheduled tasks')

    open()
    expect(panel()).not.toBeNull()
    expect(within(panel()).getByText(en.empty)).not.toBeNull()
  })

  it('reports a lost carrier and a refused scheduler in place', () => {
    const connecting = render(<CronPanel {...props({ items: [], phase: 'connecting', error: null })} />)
    open()
    expect(within(panel()).getByText(en['status.loading'])).not.toBeNull()
    connecting.unmount()

    render(<CronPanel {...props({ items: [], phase: 'unavailable', error: null })} />)
    open()
    expect(within(panel()).getByText(en['status.unavailable'])).not.toBeNull()
  })

  it('renders the terminal stream failure with its reason', () => {
    const error = new RemoteError('gateway/internal', 'the stream ended', {})
    render(<CronPanel {...props({ items: [], phase: 'error', error })} />)
    open()
    expect(within(panel()).getByText('Reading scheduled tasks failed: the stream ended')).not.toBeNull()
  })
})

describe('CronPanel rows', () => {
  it('shows each task rule, zone, next occurrence, and state', () => {
    const overdue = Date.now() - 60_000
    render(<CronPanel {...props(ready([
      job(),
      job({ jobId: 'cron-2' as CronJobId, enabled: false, timeZone: 'Asia/Tokyo', nextDueAt: overdue }),
      job({ jobId: 'cron-3' as CronJobId, nextDueAt: overdue }),
    ]))} />)
    open()

    expect(within(row(0)).getByText('0 9 * * 1-5')).not.toBeNull()
    expect(within(row(0)).getByText('UTC')).not.toBeNull()
    expect(within(row(0)).getByText(en['state.enabled'])).not.toBeNull()
    expect(within(row(1)).getByText('Asia/Tokyo')).not.toBeNull()
    expect(within(row(1)).getByText(en['state.disabled'])).not.toBeNull()
    // An occurrence already owed is marked on a task the scheduler may fire,
    // and a disabled task claims nothing about its next one.
    expect(within(row(1)).queryByText(en['run.overdue'])).toBeNull()
    expect(within(row(2)).getByText(en['run.overdue'])).not.toBeNull()
    expect(within(panel()).getByText('3 scheduled tasks')).not.toBeNull()
  })

  it('names each task control by the action it performs', () => {
    render(<CronPanel {...props(ready([
      job(),
      job({ jobId: 'cron-2' as CronJobId, enabled: false }),
    ]))} />)
    open()

    // A control's accessible name is the action it performs, so the enabled
    // task offers "Disable" and the disabled one offers "Enable".
    expect(rowControl(0, en['state.disable']).textContent).toBe(en['state.disable'])
    expect(rowControl(1, en['state.enable']).textContent).toBe(en['state.enable'])
  })

  it('names every recorded run outcome in the reader language', () => {
    const at = Date.UTC(2029, 0, 1)
    const recorded = job({
      recentRuns: [
        { startedAt: at, finishedAt: at + 1_000, outcome: 'completed' },
        { startedAt: at, finishedAt: at + 2_000, outcome: 'failed' },
        { startedAt: at, finishedAt: at + 3_000, outcome: 'timeout' },
        { startedAt: at, finishedAt: at + 4_000, outcome: 'blocked' },
        { startedAt: at, finishedAt: at + 5_000, outcome: 'interrupted' },
      ],
    })
    render(<CronPanel {...props(ready([recorded]))} />)
    open()
    pressRow(0, en['recent.count'].replace('{count}', '5'))
    for (const key of ['outcome.completed', 'outcome.failed', 'outcome.timeout', 'outcome.blocked', 'outcome.interrupted'] as const) {
      expect(within(row(0)).getByText(new RegExp(`^${en[key]} ·`))).not.toBeNull()
    }
  })

  it('runs one task now and reports the refusal a failed run carries', async () => {
    const runNow = commandMock('runNow')
    render(<CronPanel {...props(ready([job()]), { runNow })} />)
    open()
    await pressRowAsync(0, en['run.now'])
    expect(runNow).toHaveBeenCalledWith('cron-1')
    expect(within(panel()).queryByText(/Run failed/)).toBeNull()

    runNow.mockResolvedValueOnce('no lease (cron/not-leader)')
    await pressRowAsync(0, en['run.now'])
    expect(within(panel()).getByText('Run failed: no lease (cron/not-leader)')).not.toBeNull()
  })

  it('toggles one task and reports a refused change', async () => {
    const setEnabled = commandMock('setEnabled')
    render(<CronPanel {...props(ready([job()]), { setEnabled })} />)
    open()
    await pressRowAsync(0, en['state.disable'])
    expect(setEnabled).toHaveBeenCalledWith('cron-1', false)

    setEnabled.mockResolvedValueOnce('missing (cron/not-found)')
    await pressRowAsync(0, en['state.disable'])
    expect(within(panel()).getByText('Saving failed: missing (cron/not-found)')).not.toBeNull()
  })

  it('closes the panel from its own dismiss control', () => {
    render(<CronPanel {...props(ready([job()]))} />)
    open()
    expect(panel()).not.toBeNull()

    press(en['action.close'])
    expect(screen.queryByRole('region', { name: en['list.aria'] })).toBeNull()
    expect(screen.getByRole('button', { name: en['trigger.aria'] })).not.toBeNull()
  })

  it('shows the empty state once the Host stops reporting the last task', async () => {
    const remove = commandMock('remove')
    const view = render(<CronPanel {...props(ready([job()]), { remove })} />)
    open()
    pressRow(0, en['action.delete'])
    await pressRowAsync(0, en['action.deleteConfirm'])
    expect(remove).toHaveBeenCalledWith('cron-1')
    // The panel renders what the Host reports, so the removal becomes visible
    // when the projection drops the row — which is what this re-render states.
    view.rerender(<CronPanel {...props(ready([]))} />)
    expect(within(panel()).getByText(en.empty)).not.toBeNull()
    expect(within(panel()).queryAllByRole('listitem')).toEqual([])
  })

  it('deletes on the confirming second press and reports a refusal', async () => {
    const remove = commandMock('remove')
    render(<CronPanel {...props(ready([job()]), { remove })} />)
    open()
    pressRow(0, en['action.delete'])
    expect(remove).not.toHaveBeenCalled()
    // The armed press renames the same control, so the confirmation is legible
    // without hover and the button still names the action it now performs.
    expect(rowControl(0, en['action.deleteConfirm'])).not.toBeNull()

    await pressRowAsync(0, en['action.deleteConfirm'])
    expect(remove).toHaveBeenCalledWith('cron-1')

    remove.mockResolvedValueOnce('missing (cron/not-found)')
    pressRow(0, en['action.delete'])
    await pressRowAsync(0, en['action.deleteConfirm'])
    expect(within(panel()).getByText('Delete failed: missing (cron/not-found)')).not.toBeNull()
  })

  it('shows a task recent results on demand, including an empty history', () => {
    const recorded = job({
      recentRuns: [
        { startedAt: Date.UTC(2029, 0, 1), finishedAt: Date.UTC(2029, 0, 1, 0, 0, 5), outcome: 'completed' },
        { startedAt: Date.UTC(2029, 0, 2), finishedAt: Date.UTC(2029, 0, 2, 1, 30, 0), outcome: 'timeout' },
      ],
    })
    const view = render(<CronPanel {...props(ready([recorded]))} />)
    open()
    pressRow(0, en['recent.count'].replace('{count}', '2'))
    expect(within(row(0)).getByText(en['recent.title'])).not.toBeNull()
    expect(within(row(0)).getByText(/completed ·/)).not.toBeNull()
    expect(within(row(0)).getByText(/5s$/)).not.toBeNull()
    expect(within(row(0)).getByText(/timed out ·/)).not.toBeNull()
    expect(within(row(0)).getByText(/1h 30m/)).not.toBeNull()
    // The same control folds the results again.
    pressRow(0, en['recent.count'].replace('{count}', '2'))
    expect(within(row(0)).queryByText(en['recent.title'])).toBeNull()
    view.unmount()

    render(<CronPanel {...props(ready([job()]))} />)
    open()
    pressRow(0, en['recent.count'].replace('{count}', '0'))
    expect(within(row(0)).getByText(en['recent.empty'])).not.toBeNull()
  })

  it('enables a disabled task and reports a refused change', async () => {
    const setEnabled = commandMock('setEnabled')
    render(<CronPanel {...props(ready([job({ enabled: false })]), { setEnabled })} />)
    open()
    await pressRowAsync(0, en['state.enable'])
    expect(setEnabled).toHaveBeenCalledWith('cron-1', true)

    setEnabled.mockResolvedValueOnce('missing (cron/not-found)')
    await pressRowAsync(0, en['state.enable'])
    expect(within(panel()).getByText('Saving failed: missing (cron/not-found)')).not.toBeNull()
  })

  it('reports a run that is in flight until its command settles', async () => {
    const runNow = commandMock('runNow')
    const gate = Promise.withResolvers<string | null>()
    runNow.mockReturnValueOnce(gate.promise)
    render(<CronPanel {...props(ready([job()]), { runNow })} />)
    open()
    act(() => { fireEvent.click(rowControl(0, en['run.now'])) })
    expect(within(panel()).getByText(en['run.running'])).not.toBeNull()

    await act(async () => { gate.resolve(null) })
    expect(within(panel()).queryByText(en['run.running'])).toBeNull()
  })

  it('arms one row at a time and disarms the row that loses it', () => {
    const remove = commandMock('remove')
    render(<CronPanel {...props(ready([
      job(),
      job({ jobId: 'cron-2' as CronJobId }),
    ]), { remove })} />)
    open()
    pressRow(0, en['action.delete'])
    expect(rowControl(0, en['action.deleteConfirm'])).not.toBeNull()

    // Arming the other row moves the confirmation there, so a press can never
    // confirm a row the operator did not arm.
    pressRow(1, en['action.delete'])
    expect(rowControl(0, en['action.delete'])).not.toBeNull()
    expect(rowControl(1, en['action.deleteConfirm'])).not.toBeNull()
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('CronPanel form', () => {
  it('reaches every field by its dictionary label', () => {
    render(<CronPanel {...props(ready([job()]))} />)
    open()
    pressRow(0, en['action.edit'])

    // The property is that every field is reachable by the name the dictionary
    // states, so the two cannot drift: the assertion reads the same key the
    // panel renders, and a label that stops being associated fails here.
    for (const key of [
      'field.expression', 'field.timeZone', 'field.targetKind', 'field.workspacePath',
      'field.agentPreset', 'field.permissionPreset', 'field.prompt', 'field.maxRunMs',
      'field.overlapPolicy', 'field.misfirePolicy',
    ] as const) {
      expect(screen.getByLabelText(en[key])).not.toBeNull()
    }

    // The expression hint describes that field rather than naming it.
    const expression = screen.getByLabelText<HTMLInputElement>(en['field.expression'])
    const describedBy = expression.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe(en['field.expressionHint'])

    // A session destination replaces the three new-session fields.
    act(() => {
      fireEvent.change(screen.getByLabelText(en['field.targetKind']), { target: { value: 'session' } })
    })
    expect(screen.getByLabelText(en['field.sessionId'])).not.toBeNull()
    expect(screen.queryByLabelText(en['field.workspacePath'])).toBeNull()
  })

  it('creates a task from the form and closes it on success', async () => {
    const create = commandMock('create')
    render(<CronPanel {...props(ready([]), { create })} />)
    open()
    press(en['action.create'])
    expect(screen.getByRole('form', { name: en['create.title'] })).not.toBeNull()

    type(en['field.expression'], '0 9 * * *')
    type(en['field.workspacePath'], '/work')
    type(en['field.agentPreset'], 'default')
    type(en['field.permissionPreset'], 'ask')
    type(en['field.prompt'], 'run the report')
    type(en['field.maxRunMs'], '2500')
    await pressAsync(en['action.save'])

    // The panel states the request the capability stores, so the destination is
    // one `target` value and the form's own field names do not appear on it.
    expect(create).toHaveBeenCalledWith({
      expression: '0 9 * * *',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
      prompt: 'run the report',
      target: {
        kind: 'new-session',
        workspacePath: '/work',
        agentPreset: 'default',
        permissionPreset: 'ask',
        model: null,
      },
      maxRunMs: 2_500,
      overlapPolicy: 'skip',
      misfirePolicy: 'skip',
    })
    // A created task has no identity yet, so the request states none.
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('jobId')
    expect(screen.queryByRole('form')).toBeNull()
  })

  it('edits a task, switches its destination, and reports a refused save', async () => {
    const update = commandMock('update')
    render(<CronPanel {...props(ready([job()]), { update })} />)
    open()
    pressRow(0, en['action.edit'])
    expect(screen.getByRole('form', { name: en['edit.title'] })).not.toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>(en['field.workspacePath']).value).toBe('/work')

    act(() => {
      fireEvent.change(screen.getByLabelText(en['field.targetKind']), { target: { value: 'session' } })
    })
    type(en['field.sessionId'], 'session-9')
    await pressAsync(en['action.save'])
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'cron-1',
      target: { kind: 'session', sessionId: 'session-9' },
    }))

    // A refused save keeps the form open and names the reason.
    update.mockResolvedValueOnce('bad rule (cron/invalid-expression)')
    pressRow(0, en['action.edit'])
    await pressAsync(en['action.save'])
    expect(within(panel()).getByText('Saving failed: bad rule (cron/invalid-expression)')).not.toBeNull()
    expect(screen.getByRole('form', { name: en['edit.title'] })).not.toBeNull()
  })

  it('states the chosen overlap and misfire policies', async () => {
    const update = commandMock('update')
    render(<CronPanel {...props(ready([job()]), { update })} />)
    open()
    pressRow(0, en['action.edit'])
    act(() => {
      fireEvent.change(screen.getByLabelText(en['field.overlapPolicy']), { target: { value: 'queue-one' } })
    })
    act(() => {
      fireEvent.change(screen.getByLabelText(en['field.misfirePolicy']), { target: { value: 'run-once-late' } })
    })
    await pressAsync(en['action.save'])
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      overlapPolicy: 'queue-one',
      misfirePolicy: 'run-once-late',
    }))
  })

  it('states no run ceiling when the form leaves it blank', async () => {
    const create = commandMock('create')
    render(<CronPanel {...props(ready([]), { create })} />)
    open()
    press(en['action.create'])
    type(en['field.expression'], '0 9 * * *')
    type(en['field.workspacePath'], '/work')
    type(en['field.agentPreset'], 'default')
    type(en['field.permissionPreset'], 'ask')
    type(en['field.prompt'], 'run the report')
    await pressAsync(en['action.save'])
    // A blank ceiling leaves the capability's own default in force rather than
    // storing a number the operator never chose.
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('maxRunMs')
  })

  it('states the defaults the operator selects back from the stored values', async () => {
    const update = commandMock('update')
    // The stored task carries the non-default policies and a session
    // destination, so selecting the other arms is the state the panel must send.
    render(<CronPanel {...props(ready([job({
      overlapPolicy: 'queue-one',
      misfirePolicy: 'run-once-late',
      target: { kind: 'session', sessionId: 'session-1' },
    })]), { update })} />)
    open()
    pressRow(0, en['action.edit'])
    act(() => {
      fireEvent.change(screen.getByLabelText(en['field.targetKind']), { target: { value: 'new-session' } })
    })
    act(() => {
      fireEvent.change(screen.getByLabelText(en['field.overlapPolicy']), { target: { value: 'skip' } })
    })
    act(() => {
      fireEvent.change(screen.getByLabelText(en['field.misfirePolicy']), { target: { value: 'skip' } })
    })
    type(en['field.timeZone'], 'Asia/Tokyo')
    type(en['field.workspacePath'], '/work')
    type(en['field.agentPreset'], 'default')
    type(en['field.permissionPreset'], 'ask')
    await pressAsync(en['action.save'])
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      timeZone: 'Asia/Tokyo',
      overlapPolicy: 'skip',
      misfirePolicy: 'skip',
      target: {
        kind: 'new-session',
        workspacePath: '/work',
        agentPreset: 'default',
        permissionPreset: 'ask',
        model: null,
      },
    }))
  })

  it('cancels an edit without sending anything', () => {
    const update = commandMock('update')
    render(<CronPanel {...props(ready([job()]), { update })} />)
    open()
    pressRow(0, en['action.edit'])
    press(en['action.cancel'])
    expect(screen.queryByRole('form')).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })
})
