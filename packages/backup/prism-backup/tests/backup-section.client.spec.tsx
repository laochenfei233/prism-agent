// @vitest-environment jsdom
/** The backup page as the settings shell renders it: destination, switches, actions, history. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackupSection, type BackupSectionProps } from '../src/client/BackupSection.tsx'
import { en } from '../src/client/locales.ts'
import type { BackupFieldDraft, BackupFormState, BackupRunState, BackupSectionFace } from '../src/client/page-controller.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

/** One staged draft. */
function draft(text: string, rest: Partial<BackupFieldDraft> = {}): BackupFieldDraft {
  return { text, overridden: false, invalid: false, ...rest }
}

/** The default staged form state. */
function formState(overrides: Partial<BackupFormState> = {}): BackupFormState {
  return {
    available: true,
    writable: true,
    dirty: false,
    invalid: false,
    saving: false,
    failed: false,
    fields: {
      targetType: draft('webdav'),
      webdavUrl: draft('https://dav.example.com'),
      s3Endpoint: draft(''),
      s3Region: draft('us-east-1'),
      s3Bucket: draft(''),
      s3PathStyle: draft('false'),
      smbPath: draft(''),
      username: draft('me'),
      s3AccessKeyId: draft(''),
      remoteDir: draft('prism-backup'),
      includeSettings: draft('true'),
      includeMemory: draft('true'),
      includeProjects: draft('true'),
      projectExcludes: draft('.git'),
      maxBackups: draft('10'),
    },
    secretText: { webdavPassword: '', smbPassword: '', s3SecretKey: '' },
    ...overrides,
  }
}

/** The default run state. */
function runState(overrides: Partial<BackupRunState> = {}): BackupRunState {
  return {
    running: false,
    phase: undefined,
    history: [],
    secrets: { 'webdav-password': false, 'smb-password': false, 's3-secret-key': false },
    testing: false,
    notice: undefined,
    ...overrides,
  }
}

/**
 * Render the page over two stores.
 * @param form - staged form state.
 * @param run - run state.
 * @returns the action spies.
 */
function renderPage(form: Partial<BackupFormState> = {}, run: Partial<BackupRunState> = {}): {
  edit: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  test: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  clearSecret: ReturnType<typeof vi.fn>
  resetField: ReturnType<typeof vi.fn>
} {
  const formStore = createSnapshotStore(formState(form))
  const runStore = createSnapshotStore(runState(run))
  const face: BackupSectionFace = {
    edit: vi.fn(),
    resetField: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
    hooks: { backupForm: formStore, backupRun: runStore },
    test: vi.fn(),
    run: vi.fn(),
    clearSecret: vi.fn(),
  }
  const props = {
    close: vi.fn(),
    t,
    edit: face.edit,
    resetField: face.resetField,
    save: face.save,
    discard: face.discard,
    test: face.test,
    run: face.run,
    clearSecret: face.clearSecret,
    useBackupForm: bindSnapshotSelector(formStore),
    useBackupRun: bindSnapshotSelector(runStore),
  } as BackupSectionProps
  render(<BackupSection {...props} />)
  return {
    edit: face.edit as ReturnType<typeof vi.fn>,
    resetField: face.resetField as ReturnType<typeof vi.fn>,
    save: face.save as ReturnType<typeof vi.fn>,
    test: face.test as ReturnType<typeof vi.fn>,
    run: face.run as ReturnType<typeof vi.fn>,
    clearSecret: face.clearSecret as ReturnType<typeof vi.fn>,
  }
}

describe('BackupSection', () => {
  it('renders the destination, the content switches, and the history heading', () => {
    renderPage()
    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByText(en.warning)).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'WebDAV' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByLabelText(en.webdavUrl)).toBeTruthy()
    expect(screen.getByLabelText(en.webdavPassword)).toBeTruthy()
    expect(screen.getByText(en.includeMemoryHint)).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.history })).toBeTruthy()
    expect(screen.getByText(en.historyEmpty)).toBeTruthy()
  })

  it('stages a protocol switch and shows that protocol\'s fields', () => {
    const actions = renderPage()
    fireEvent.click(screen.getByRole('tab', { name: 'S3' }))
    expect(actions.edit).toHaveBeenCalledWith('targetType', 's3')

    cleanup()
    renderPage({ fields: { ...formState().fields, targetType: draft('s3') } })
    expect(screen.getByLabelText(en.s3Bucket)).toBeTruthy()
    expect(screen.getByLabelText(en.s3SecretKey)).toBeTruthy()
    expect(screen.queryByLabelText(en.webdavUrl)).toBeNull()
    expect(screen.queryByLabelText(en.username)).toBeNull()

    cleanup()
    renderPage({ fields: { ...formState().fields, targetType: draft('smb') } })
    expect(screen.getByLabelText(en.smbPath)).toBeTruthy()
    expect(screen.getByLabelText(en.smbPassword)).toBeTruthy()
  })

  it('stages a typed field, a toggle, and a reset', () => {
    const actions = renderPage({
      fields: { ...formState().fields, username: draft('me', { overridden: true }), includeMemory: draft('false') },
    })
    fireEvent.change(screen.getByLabelText(en.webdavUrl), { target: { value: 'https://other.example.com' } })
    expect(actions.edit).toHaveBeenCalledWith('webdavUrl', 'https://other.example.com')

    fireEvent.click(screen.getByLabelText(en.includeProjects))
    expect(actions.edit).toHaveBeenCalledWith('includeProjects', 'false')
    fireEvent.click(screen.getByLabelText(en.includeMemory))
    expect(actions.edit).toHaveBeenCalledWith('includeMemory', 'true')

    fireEvent.click(screen.getByRole('button', { name: en.reset }))
    expect(actions.edit).toHaveBeenCalledTimes(3)
  })

  it('stages a password and reports whether one is stored', () => {
    const actions = renderPage({}, { secrets: { 'webdav-password': true, 'smb-password': false, 's3-secret-key': false } })
    expect(screen.getByText(en.secretStored)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.webdavPassword), { target: { value: 'hunter2' } })
    expect(actions.edit).toHaveBeenCalledWith('webdavPassword', 'hunter2')

    cleanup()
    renderPage()
    expect(screen.getByText(en.secretMissing)).toBeTruthy()
  })

  it('clears a stored password from its own control', () => {
    const actions = renderPage({}, { secrets: { 'webdav-password': true, 'smb-password': false, 's3-secret-key': false } })
    fireEvent.click(screen.getByRole('button', { name: en.secretClear }))
    expect(actions.clearSecret).toHaveBeenCalledWith('webdav-password')
  })

  it('clears the password of whichever protocol is selected', () => {
    const actions = renderPage(
      { fields: { ...formState().fields, targetType: draft('s3') } },
      { secrets: { 'webdav-password': false, 'smb-password': false, 's3-secret-key': true } },
    )
    fireEvent.click(screen.getByRole('button', { name: en.secretClear }))
    expect(actions.clearSecret).toHaveBeenCalledWith('s3-secret-key')

    cleanup()
    const smb = renderPage(
      { fields: { ...formState().fields, targetType: draft('smb') } },
      { secrets: { 'webdav-password': false, 'smb-password': true, 's3-secret-key': false } },
    )
    fireEvent.click(screen.getByRole('button', { name: en.secretClear }))
    expect(smb.clearSecret).toHaveBeenCalledWith('smb-password')
  })

  it('resets the exclusion list to the composition value', () => {
    const actions = renderPage({
      fields: { ...formState().fields, projectExcludes: draft('.git', { overridden: true }) },
    })
    fireEvent.click(screen.getByRole('button', { name: en.reset }))
    expect(actions.resetField).toHaveBeenCalledWith('projectExcludes')
  })

  it('renders the exclusion list in a multi-line control', () => {
    const twoLines = '.git' + String.fromCharCode(10) + 'node_modules'
    const actions = renderPage({ fields: { ...formState().fields, projectExcludes: draft(twoLines) } })
    const area = screen.getByLabelText(en.excludes)
    expect(area.tagName).toBe('TEXTAREA')
    expect((area as HTMLTextAreaElement).value).toBe(twoLines)
    fireEvent.change(area, { target: { value: '.git' + String.fromCharCode(10) + 'tmp' } })
    expect(actions.edit).toHaveBeenCalledWith('projectExcludes', '.git' + String.fromCharCode(10) + 'tmp')
  })

  it('saves the staged edits and disables the controls on a read-only document', () => {
    const actions = renderPage({ dirty: true })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(actions.save).toHaveBeenCalledOnce()

    cleanup()
    renderPage({ writable: false, dirty: true })
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'WebDAV' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: en.run }).hasAttribute('disabled')).toBe(true)
  })

  it('says the page is unavailable when the Host does not serve it', () => {
    renderPage({ available: false })
    expect(screen.getByRole('status').textContent).toBe(en.unavailable)
  })

  it('runs the connection probe and the backup from their buttons', () => {
    const actions = renderPage()
    fireEvent.click(screen.getByRole('button', { name: en.test }))
    fireEvent.click(screen.getByRole('button', { name: en.run }))
    expect(actions.test).toHaveBeenCalledOnce()
    expect(actions.run).toHaveBeenCalledOnce()
  })

  it('shows busy labels, the live phase, and the last notice', () => {
    renderPage({}, { testing: true, running: true, phase: 'Uploading to D:\\remote' })
    expect(screen.getByRole('button', { name: en.testing }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: en.running }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Uploading to D:\\remote')).toBeTruthy()

    cleanup()
    renderPage({}, { notice: { tone: 'ok', text: 'runOk' } })
    expect(screen.getByText(en.runOk)).toBeTruthy()

    cleanup()
    renderPage({}, { notice: { tone: 'error', text: 'server said no' } })
    expect(screen.getByText('server said no')).toBeTruthy()

    cleanup()
    renderPage({}, { notice: { tone: 'error', text: 'unreachable' } })
    expect(screen.getByText(en.unreachable)).toBeTruthy()
  })

  it('renders finished runs with their status, endpoint, and size', () => {
    renderPage({}, {
      history: [
        {
          id: 'a',
          startedAt: 1_700_000_000_000,
          finishedAt: 1_700_000_001_000,
          status: 'success',
          targetType: 'smb',
          endpoint: 'D:\\remote',
          sizeBytes: 2048,
          counts: { settings: 1, memoryFiles: 0, projects: 0, projectFiles: 0 },
        },
        {
          id: 'b',
          startedAt: 1_700_000_000_000,
          finishedAt: 1_700_000_001_000,
          status: 'failed',
          targetType: 's3',
          endpoint: 'https://s3.example.com/bucket',
          counts: { settings: 0, memoryFiles: 0, projects: 0, projectFiles: 0 },
          failure: { code: 'prism-backup/auth-failed', message: 'refused' },
        },
      ],
    })
    expect(screen.getByText(en.historySuccess)).toBeTruthy()
    expect(screen.getByText(en.historyFailed)).toBeTruthy()
    expect(screen.getByText(/D:\\remote/u)).toBeTruthy()
    expect(screen.getByText('2.0KB')).toBeTruthy()
    expect(screen.getByText('refused')).toBeTruthy()
  })

  it('marks an invalid draft in place of its hint', () => {
    renderPage({ fields: { ...formState().fields, maxBackups: draft('many', { invalid: true }) } })
    expect(screen.getByText(en.invalidNumber)).toBeTruthy()
  })
})
