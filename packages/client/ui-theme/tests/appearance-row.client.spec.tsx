// @vitest-environment jsdom
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { allowAllAccess, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AppearanceRow } from '../src/client/AppearanceRow.tsx'
import type { AppearanceRowComponentProps } from '../src/client/AppearanceRow.tsx'
import { createAppearanceRowStore } from '../src/client/settings-store.ts'
import { projectThemeGallery } from '../src/client/gallery.ts'
import type { ThemeGalleryEntry } from '../src/client/gallery.ts'
import { BUILTIN_THEMES } from '../src/builtin-themes.ts'
import type { ThemePreference } from '../src/client/index.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

const COPY: Record<string, string> = {
  'appearance.title': 'Theme',
  'appearance.system': 'System',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.graphGlass': 'Graph Paper Glass',
  'appearance.monoAccent': 'Single Accent',
  'appearance.strataDark': 'Lightness Strata',
}

const GALLERY = projectThemeGallery(BUILTIN_THEMES)

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

type AttentionSnapshot = Parameters<Parameters<AppearanceRowComponentProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: AppearanceRowComponentProps['useSessionStatus'] = selector => selector(noAttention)

function mount(preference: ThemePreference = 'system', entries: readonly ThemeGalleryEntry[] = GALLERY) {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createAppearanceRowStore().create()
  store.actions.sync(preference, entries, 0)
  const setTheme = vi.fn()
  const props: AppearanceRowComponentProps = {
    useSessions: emptySessions(),
    useSessionStatus,
    usePanelInfo, useSessionRetainInfo: () => undefined, useResource,
    useWorkspaces: emptyWorkspaces(),
    ...allowAllAccess,
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setTheme,
  }
  render(<AppearanceRow {...props} />)
  return { store, setTheme }
}

const pressed = (name: RegExp): string | null =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed')

describe('AppearanceRow', () => {
  it('renders every registered theme as a card with the preference card selected', () => {
    mount('dark')
    expect(screen.getByText('Theme')).toBeDefined()
    expect(screen.getAllByRole('button')).toHaveLength(GALLERY.length)
    expect(pressed(/^Dark$/)).toBe('true')
    expect(pressed(/^Light$/)).toBe('false')
    expect(pressed(/^Graph Paper Glass$/)).toBe('false')
  })

  it('labels a designed theme from the locale dictionary and falls back to the id', () => {
    mount('system', [
      ...GALLERY,
      { id: 'sepia', base: '#f4ecd8', surface: '#efe3c8', accent: '#7c5b2a' },
    ])
    expect(screen.getByText('Single Accent')).toBeDefined()
    expect(screen.getByText('sepia')).toBeDefined()
  })

  it('paints each card preview from that theme entry colors', () => {
    mount('mono-accent')
    const preview = screen.getByRole('button', { name: /^Single Accent$/ })
      .querySelector<HTMLElement>('[style]')!
    expect(preview.style.getPropertyValue('--preview-base')).toBe('#0b0b0c')
    expect(preview.style.getPropertyValue('--preview-accent')).toBe('#ff6900')
  })

  it('click drives setTheme; selection follows the store mirror, not the click echo', () => {
    const b = mount('dark')
    fireEvent.click(screen.getByRole('button', { name: /^Graph Paper Glass$/ }))
    expect(b.setTheme).toHaveBeenCalledWith('graph-glass')
    // No store write yet: selection is unchanged.
    expect(pressed(/^Dark$/)).toBe('true')
    act(() => { b.store.actions.sync('graph-glass', GALLERY, 1) })
    expect(pressed(/^Graph Paper Glass$/)).toBe('true')
    expect(pressed(/^Dark$/)).toBe('false')
  })
})
