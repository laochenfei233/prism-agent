/** Appearance section store: the snapshot-mirror action and its revision guard. */
import { describe, expect, it } from 'vitest'
import { createAppearanceSectionStore } from '../src/client/settings-store.ts'
import { projectThemeGallery } from '../src/client/gallery.ts'
import { BUILTIN_THEMES } from '../src/builtin-themes.ts'

const GALLERY = projectThemeGallery(BUILTIN_THEMES)
const SIZES = { text: 16, code: 12, terminal: 14 }
const FONTS = { text: '"Inter"', code: '', terminal: '' }
const CUSTOM = { scheme: 'dark' as const, canvas: '#112233', accent: '#00ff00' }
const PRESETS = [{ name: 'Navy', scheme: 'light' as const, canvas: '#112233', accent: '#00ff00' }]

describe('createAppearanceSectionStore', () => {
  it('init shape: system preference, no rows, schema defaults, revision at -1', () => {
    const store = createAppearanceSectionStore().create()
    expect(store.getSnapshot()).toEqual({
      preference: 'system', entries: [], fontSizes: { text: 14, code: 11, terminal: 13 },
      fontFamilies: { text: '', code: '', terminal: '' },
      custom: { scheme: 'light', canvas: '#ffffff', accent: '#ff6900' }, customPresets: [], revision: -1,
    })
  })

  it('sync mirrors every snapshot slice and advances the revision', () => {
    const store = createAppearanceSectionStore().create()
    store.actions.sync('dark', GALLERY, SIZES, FONTS, CUSTOM, PRESETS, 0)
    expect(store.getSnapshot()).toEqual({
      preference: 'dark', entries: GALLERY, fontSizes: SIZES, fontFamilies: FONTS, custom: CUSTOM, customPresets: PRESETS, revision: 0,
    })
    store.actions.sync('graph-glass', GALLERY, { ...SIZES, text: 12 }, FONTS, CUSTOM, PRESETS, 2)
    expect(store.getSnapshot().preference).toBe('graph-glass')
    expect(store.getSnapshot().fontSizes.text).toBe(12)
    expect(store.getSnapshot().revision).toBe(2)
  })

  it('revision guard drops stale and duplicate writes', () => {
    const store = createAppearanceSectionStore().create()
    store.actions.sync('dark', GALLERY, SIZES, FONTS, CUSTOM, PRESETS, 3)
    store.actions.sync('system', GALLERY, SIZES, FONTS, CUSTOM, PRESETS, 2)
    store.actions.sync('system', GALLERY, SIZES, FONTS, CUSTOM, PRESETS, 3)
    expect(store.getSnapshot().preference).toBe('dark')
    expect(store.getSnapshot().revision).toBe(3)
  })
})

describe('projectThemeGallery', () => {
  it('lists system first, then every registered theme with a preview read from its tokens', () => {
    const entries = projectThemeGallery(BUILTIN_THEMES)
    expect(entries.map(entry => entry.id))
      .toEqual(['system', 'light', 'dark', 'graph-glass', 'mono-accent', 'strata-dark', 'paper', 'blueprint', 'phosphor', 'sumi', 'sage'])
    // The base palettes override no surface token, so they preview their scheme defaults.
    expect(entries.find(entry => entry.id === 'light')).toMatchObject({ base: '#ffffff', accent: '#0f1115' })
    expect(entries.find(entry => entry.id === 'dark')).toMatchObject({ base: '#151517', accent: '#f9fafb' })
    // A designed theme previews itself.
    expect(entries.find(entry => entry.id === 'mono-accent')).toMatchObject({
      base: '#0b0b0c', surface: '#131315', accent: '#ff6900',
    })
    // `system` shows one half per base palette.
    expect(entries[0]!.base).toContain('linear-gradient')
  })

  it('assigns each known preference its own preview motif and carries the theme textures', () => {
    const entries = projectThemeGallery(BUILTIN_THEMES)
    expect(entries.map(entry => entry.motif)).toEqual([
      'split', 'sheet', 'night', 'grid', 'beacon', 'strata', 'grain', 'plan', 'crt', 'ink', 'fern',
    ])
    const paper = entries.find(entry => entry.id === 'paper')!
    expect(paper.canvasImage).toContain('data:image/svg+xml')
    expect(paper.centerImage).toBeUndefined()
    const strata = entries.find(entry => entry.id === 'strata-dark')!
    expect(strata.centerImage).toContain('repeating-linear-gradient')
    expect(strata.canvasImage).toBeUndefined()
  })

  it('previews a theme another package registers with the plain motif', () => {
    const entries = projectThemeGallery([
      { id: 'sepia', colorScheme: 'light', tokens: { '--dsw-alias-bg-base': '#f4ecd8' } },
    ])
    expect(entries.map(entry => entry.id)).toEqual(['system', 'sepia'])
    expect(entries[1]).toMatchObject({ base: '#f4ecd8', surface: '#f5f6f7', accent: '#0f1115', motif: 'plain' })
  })
})
