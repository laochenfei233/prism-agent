/** Appearance and font-size row stores: snapshot-mirror actions and the revision guards. */
import { describe, expect, it } from 'vitest'
import { createAppearanceRowStore, createFontRowStore } from '../src/client/settings-store.ts'
import { projectThemeGallery } from '../src/client/gallery.ts'
import { BUILTIN_THEMES } from '../src/builtin-themes.ts'

const GALLERY = projectThemeGallery(BUILTIN_THEMES)

describe('createAppearanceRowStore', () => {
  it('init shape: system preference, no rows, revision at -1', () => {
    const store = createAppearanceRowStore().create()
    expect(store.getSnapshot()).toEqual({ preference: 'system', entries: [], revision: -1 })
  })

  it('sync mirrors the preference and the gallery rows and advances the revision', () => {
    const store = createAppearanceRowStore().create()
    store.actions.sync('dark', GALLERY, 0)
    expect(store.getSnapshot()).toEqual({ preference: 'dark', entries: GALLERY, revision: 0 })
    store.actions.sync('graph-glass', GALLERY, 2)
    expect(store.getSnapshot().preference).toBe('graph-glass')
    expect(store.getSnapshot().revision).toBe(2)
  })

  it('revision guard drops stale and duplicate writes', () => {
    const store = createAppearanceRowStore().create()
    store.actions.sync('dark', GALLERY, 3)
    store.actions.sync('system', GALLERY, 2)
    store.actions.sync('system', GALLERY, 3)
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

  it('previews a theme another package registers', () => {
    const entries = projectThemeGallery([
      { id: 'sepia', colorScheme: 'light', tokens: { '--dsw-alias-bg-base': '#f4ecd8' } },
    ])
    expect(entries.map(entry => entry.id)).toEqual(['system', 'sepia'])
    expect(entries[1]).toMatchObject({ base: '#f4ecd8', surface: '#f5f6f7', accent: '#0f1115' })
  })
})

describe('createFontRowStore', () => {
  it('init shape: default size with revision at -1', () => {
    const store = createFontRowStore().create()
    expect(store.getSnapshot()).toEqual({ fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' }, revision: -1 })
  })

  it('sync mirrors the size; the revision guard drops stale and duplicate writes', () => {
    const store = createFontRowStore().create()
    const sizes = { text: 16, code: 12, terminal: 14 }
    const fonts = { text: '"Inter"', code: '', terminal: '' }
    store.actions.sync(sizes, { ...fonts }, 3)
    expect(store.getSnapshot()).toEqual({ fontSizes: sizes, fontFamilies: fonts, revision: 3 })
    store.actions.sync({ ...sizes, text: 12 }, fonts, 2)
    store.actions.sync({ ...sizes, text: 12 }, fonts, 3)
    expect(store.getSnapshot().fontSizes.text).toBe(16)
    expect(store.getSnapshot().revision).toBe(3)
  })
})
