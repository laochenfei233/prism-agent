// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { AppearanceRow } from '../src/client/AppearanceRow.tsx'
import type { AppearanceRowComponentProps } from '../src/client/AppearanceRow.tsx'
import { createAppearanceSectionStore } from '../src/client/settings-store.ts'
import { projectThemeGallery } from '../src/client/gallery.ts'
import type { ThemeGalleryEntry } from '../src/client/gallery.ts'
import { BUILTIN_THEMES } from '../src/builtin-themes.ts'
import type { ThemePreference } from '../src/client/index.ts'

afterEach(cleanup)

const COPY: Record<string, string> = {
  'appearance.gallery': 'Theme',
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
}

const GALLERY = projectThemeGallery(BUILTIN_THEMES)

function mount(preference: ThemePreference = 'system', entries: readonly ThemeGalleryEntry[] = GALLERY) {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createAppearanceSectionStore().create()
  store.actions.sync(preference, entries, { text: 14, code: 11, terminal: 13 }, { text: '', code: '', terminal: '' }, {
    scheme: 'light', canvas: '#ffffff', accent: '#ff6900',
  }, 0)
  const setTheme = vi.fn()
  const props: AppearanceRowComponentProps = {
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

  it('renders each row with its motif composition and its texture variables', () => {
    mount('system', [
      ...GALLERY,
      { id: 'sepia', base: '#f4ecd8', surface: '#efe3c8', accent: '#7c5b2a', motif: 'plain' },
    ])
    const paper = screen.getByRole('button', { name: /^Paper$/ }).querySelector<HTMLElement>('[style]')!
    expect(paper.className).toContain('grain')
    expect(paper.style.getPropertyValue('--preview-image')).toContain('data:image/svg+xml')
    const sepia = screen.getByRole('button', { name: /^sepia$/ }).querySelector<HTMLElement>('[style]')!
    // Plain motifs carry no texture variable and no per-motif class.
    expect(sepia.className).not.toContain('grain')
    expect(sepia.style.getPropertyValue('--preview-image')).toBe('')
  })

  it('click drives setTheme; selection follows the store mirror, not the click echo', () => {
    const b = mount('dark')
    fireEvent.click(screen.getByRole('button', { name: /^Graph Paper Glass$/ }))
    expect(b.setTheme).toHaveBeenCalledWith('graph-glass')
    // No store write yet: selection is unchanged.
    expect(pressed(/^Dark$/)).toBe('true')
    act(() => {
      b.store.actions.sync('graph-glass', GALLERY, { text: 14, code: 11, terminal: 13 }, { text: '', code: '', terminal: '' }, {
        scheme: 'light', canvas: '#ffffff', accent: '#ff6900',
      }, 1)
    })
    expect(pressed(/^Graph Paper Glass$/)).toBe('true')
    expect(pressed(/^Dark$/)).toBe('false')
  })
})
