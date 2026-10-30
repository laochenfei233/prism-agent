// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { allowAllAccess, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AppearanceSection } from '../src/client/AppearanceSection.tsx'
import type { AppearanceSectionComponentProps } from '../src/client/AppearanceSection.tsx'
import { createAppearanceSectionStore } from '../src/client/settings-store.ts'
import { projectThemeGallery } from '../src/client/gallery.ts'
import { BUILTIN_THEMES } from '../src/builtin-themes.ts'
import type { ThemePreference } from '../src/client/index.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

const COPY: Record<string, string> = {
  'appearance.gallery': 'Theme',
  'appearance.customGroup': 'Custom theme',
  'appearance.customScheme': 'Base palette',
  'appearance.customSchemeLight': 'Light',
  'appearance.customSchemeDark': 'Dark',
  'appearance.customCanvas': 'Canvas',
  'appearance.customAccent': 'Accent',
  'appearance.customCanvasInput': 'Pick the canvas color',
  'appearance.customAccentInput': 'Pick the accent color',
  'appearance.customReset': 'Reset',
  'appearance.system': 'System',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.graphGlass': 'Graph Paper Glass',
  'appearance.monoAccent': 'Single Accent',
  'appearance.strataDark': 'Lightness Strata',
  'appearance.paper': 'Paper',
  'appearance.blueprint': 'Blueprint',
  'appearance.phosphor': 'Amber Phosphor',
  'appearance.sumi': 'Sumi Ink',
  'appearance.sage': 'Sage',
  'appearance.custom': 'Custom',
  'fontSize.text.title': 'Font size',
}

const GALLERY = projectThemeGallery(BUILTIN_THEMES)
const SIZES = { text: 14, code: 11, terminal: 13 }
const FONTS = { text: '', code: '', terminal: '' }
const DEFAULT_CUSTOM = { scheme: 'light' as const, canvas: '#ffffff', accent: '#ff6900' }

function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  return bindSnapshotSelector(store)
}

type AttentionSnapshot = Parameters<Parameters<AppearanceSectionComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: AppearanceSectionComponentProps['useSessionStatus'] = selector => selector(noAttention)

function mount(preference: ThemePreference = 'system', custom = DEFAULT_CUSTOM) {
  const store = createAppearanceSectionStore().create()
  store.actions.sync(preference, GALLERY, SIZES, FONTS, custom, 0)
  const setTheme = vi.fn()
  const setCustom = vi.fn()
  const setFontSize = vi.fn()
  const setFontFamily = vi.fn()
  const props: AppearanceSectionComponentProps = {
    close: () => {},
    useSessions: emptySessions(),
    useSessionStatus,
    usePanelInfo, useResource,
    useWorkspaces: emptyWorkspaces(),
    ...allowAllAccess,
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setTheme, setCustom, setFontSize, setFontFamily,
  }
  render(<AppearanceSection {...props} />)
  return { store, setTheme, setCustom, setFontSize, setFontFamily }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('AppearanceSection', () => {
  it('renders the theme gallery, the custom theme group, and the font settings', () => {
    mount()
    expect(screen.getByText('Theme')).toBeDefined()
    expect(screen.getByText('Custom theme')).toBeDefined()
    expect(screen.getByText('Font size')).toBeDefined()
  })

  it('the scheme segmented control writes through setCustom', () => {
    const b = mount()
    const segmented = screen.getByRole('group', { name: 'Base palette' })
    fireEvent.click(within(segmented).getByRole('button', { name: 'Dark' }))
    expect(b.setCustom).toHaveBeenCalledWith({ scheme: 'dark' })
    fireEvent.click(within(segmented).getByRole('button', { name: 'Light' }))
    expect(b.setCustom).toHaveBeenCalledWith({ scheme: 'light' })
  })

  it('preset swatches commit instantly and the native picker commits on settle', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Canvas #f4eee1' }))
    expect(b.setCustom).toHaveBeenCalledWith({ canvas: '#f4eee1' })
    const input = document.querySelector('input[type="color"][aria-label="Pick the canvas color"]') as HTMLInputElement
    expect(input).toBeDefined()
    fireEvent.change(input, { target: { value: '#123456' } })
    act(() => { vi.advanceTimersByTime(149) })
    expect(b.setCustom).not.toHaveBeenCalledWith({ canvas: '#123456' })
    act(() => { vi.advanceTimersByTime(1) })
    expect(b.setCustom).toHaveBeenCalledWith({ canvas: '#123456' })
  })

  it('reset is disabled at the defaults and writes them once the inputs change', () => {
    const b = mount('system', { scheme: 'dark', canvas: '#112233', accent: '#00ff00' })
    const reset = screen.getByRole('button', { name: 'Reset' })
    expect(reset).toHaveProperty('disabled', false)
    fireEvent.click(reset)
    expect(b.setCustom).toHaveBeenCalledWith(DEFAULT_CUSTOM)
  })

  it('reset is disabled while the custom inputs match the defaults', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Reset' })).toHaveProperty('disabled', true)
  })
})
