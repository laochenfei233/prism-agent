---
feature: appearance-themes
status: delivered
updated: 2026-10-31
branch: feat/appearance-themes
commits: 42f8b7cfed..745b01c530
---

# Appearance themes: standalone section, custom theme, five palettes, distinct previews

## Report

**What was built** — The theme picker is now a standalone Appearance section in
the settings sidebar (nav order 5, its own swatch glyph), holding the theme
gallery, a custom-theme group, and the font settings; General no longer lists
them. The gallery renders twelve rows — `system`, ten built-in palettes
(`light`, `dark`, `graph-glass`, `mono-accent`, `strata-dark`, and the new
`paper`, `blueprint`, `phosphor`, `sumi`, `sage`), and `custom` — each painting
its own preview motif; designed themes show their canvas textures through the
same tokens the runtime applies.

The custom theme synthesizes a partial override layer at runtime from three
persisted inputs (`customScheme`, `customCanvas`, `customAccent`, hex-validated
at the settings boundary): surfaces derive from the canvas at clamped neutral
saturation, the accent spends like `mono-accent` with luminance-resolved
inverted text, and label/state ramps fall through to the proven base palette.
`ThemeRuntime.setCustom` writes changed fields plus the preference switch in
one settings mutation and republishes `theme/change`; the boot scripts paint
the stored custom canvas before first paint. All `ThemeSnapshot` consumers were
updated for the new `custom` field, and the config/slot catalogs were
regenerated.

**Verification** —
`pnpm vitest run packages/client/ui-theme/tests/` PASS (2 failures
PRE-EXISTING on base: corner-shape-styles, scrollbar-styles stylesheet scans);
`packages/client/ui-settings-general/tests/` 86 PASS (2 previously failing
ledger tests fixed by recording the true shipped roster); ThemeSnapshot
consumer specs across ui-layout/ui-settings-account/ui-sidebar-terminal 164
PASS; `pnpm run build` (build:artifacts + build:check) PASS; `pnpm run
typecheck` PASS; `pnpm run duplication` FAIL(PRE-EXISTING, 13 clones identical
on base, none in touched files); web e2e `settings-chrome.e2e.ts` 18 PASS and
`settings-appearance.e2e.ts` PASS with `DSH_SNAPSHOT=refresh` goldens committed;
`verify-config-catalog`/`verify-client-catalog` PASS after regeneration; doc
gates clean for touched packages (ui-chat/ui-conversation summary budgets and
the prism-backup README skeleton fail PRE-EXISTING from other master merges);
visual walkthrough screenshots reviewed for all twelve motifs, five applied
themes, and live custom synthesis. Review subagent: spec compliance PASS,
correctness PASS, codebase consistency PASS after the catalog fix; re-review
PASS on all items.

**Journey log** —
- A `settings.section` registration carries one store, so the two
  `settings.general.item` row stores merged into a single section store; the
  gallery, custom group, and font rows became section-internal components
  typed on store + locale instead of the slot runtime.
- Computed keys (`[CUSTOM_SCHEME_FIELD]:`) in the host `Config` z.object broke
  the config-catalog generator, which cannot evaluate them; generated catalogs
  need literal keys. Caught by review, fixed to literals.
- The custom theme ships as a partial override layer (surfaces + accent set
  derived, label/state ramps falling through to the base palette) rather than
  synthesizing all ~60 tokens — contrast stays with proven values and the
  derivation surface stays small.
- The new section puts two buttons named 深色/浅色 on screen at once (theme
  card vs base-palette segmented control); a `role="group"` + aria-label on the
  gallery disambiguates for assistive tech and the e2e (`openAppearanceGallery`).
- Master carried pre-existing red from earlier merges (stylesheet scans,
  summary budgets, prism-backup README skeleton, duplication clones); each was
  verified identical on the base tree before being recorded as PRE-EXISTING.

## [S1] Problem

The theme picker is one row inside the General settings section, the six
selectable options all render the same preview miniature with different
colors, there is no way to customize colors, and the palette roster is
missing the warm paper direction the user asked for. The user wants:

1. Themes promoted to a standalone Settings sidebar entry ("外观"), with the
   font settings moved in alongside.
2. A full custom theme: base scheme + canvas color + accent color, with the
   complete alias-token set synthesized at runtime.
3. Five new built-in palettes: a paper theme inspired by easel.xyern.com plus
   Blueprint, Amber Phosphor CRT, Sumi, and Sage.
4. A distinct preview icon per gallery row instead of one recolored layout.

Design was approved in plan mode (user confirmed scope: full custom theme,
all four extra directions, fonts moved, compose-next workflow).

## [S2] Design

### S2.1 Standalone Appearance section

- `packages/client/ui-theme/src/client/index.ts` drops both
  `settings.general.item` registrations (`appearance`, `font-size`) and
  registers one `settings.section` entry: `{ id: 'appearance', order: 5 }`
  (between General 0 and Models 10), `label: () => t('appearance.title')`,
  `locale: SETTINGS_NS`.
- New `AppearanceSection.tsx` composes the theme gallery group, the custom
  theme group (S2.2), and the existing `FontSettingsGroup`.
- The two row stores (`createAppearanceRowStore`, `createFontRowStore`)
  merge into one `createAppearanceSectionStore` holding
  `{ preference, entries, revision, fontSizes, fontFamilies }` — a section is
  one slot surface, and a slot registration carries a single store.
- `SettingsRoot.navIcon` gains an `appearance` case rendering a new
  `IconThemeOutlineMedium` (hand-written 16x16 SVG in
  `packages/client/ui-primitives/src/icons/index.tsx`, house pattern).
- The glyph test in `packages/client/ui-settings-general/tests/settings-root.client.spec.tsx`
  and the shell ledger tests gain the new id.

### S2.2 Custom theme (runtime synthesis)

- `theme-settings.ts`: `THEME_PREFERENCES` gains `'custom'` (after the built-in
  ids; `BUILTIN_THEME_IDS` keeps meaning "shipped palettes"). `ThemeSettings`
  gains flat fields:
  - `customScheme: 'light' | 'dark'` (default `'light'`),
  - `customCanvas: string` (hex3/hex6, default `'#ffffff'`),
  - `customAccent: string` (hex3/hex6, default `'#ff6900'`).
  Defaults make the initial custom theme equal to the light base with the
  Prism orange. Schema additions are additive with defaults — no upgrade guide.
- `synthesizeThemeTokens({ scheme, canvas, accent }): ThemeTokens` — pure,
  shared by Host and browser, unit-tested:
  - Surfaces derive from the canvas: layer steps lighten by fixed deltas
    (+3/6/9% light, +5/10/15% dark) with saturation clamped to <= 8%;
    borders use the desaturated canvas hue at the existing alpha ramp
    (7/11/15/20% light, 6/12/16/20% dark).
  - Label ramps are the proven base-palette ink values per scheme, never
    derived — contrast is guaranteed for canvases in the scheme's lightness
    band (documented assumption; the user picks the canvas).
  - Accent spends like `mono-accent`: brand/link/button fills/business =
    accent; hover darkens 8% (light) or lightens 10% (dark); dimmed and
    interactive layers use accent alphas; `brand-primary-invert` resolves to
    white or near-black by WCAG luminance. Success/warn fold to neutral;
    error keeps the platform red (mono-accent precedent).
  - No texture tokens (`--dsh-theme-*-image` stay unset).
- `ThemeRuntime`: when `preference === 'custom'`, the active theme and the
  gallery snapshot carry the synthesized definition (id `'custom'`). A single
  `setCustom(patch)` writes the custom fields and switches `preference` to
  `'custom'` (editing the controls means using the theme); volatile fields
  make the re-synthesis live through the existing `theme/change` publish.
  `setTheme('custom')` only flips the preference.
- Boot: `bootThemeInjections` accepts a resolved custom
  `{ canvas, dark }`; the Host `apply()` reads its Config and passes it, so
  the pre-paint canvas matches and nothing flashes.

### S2.3 New palettes

`builtin-themes.ts` gains five complete token sets (every alias and specific
token the existing designed themes override, plus `bootBackground`):

- `paper` 纸感 (light, boot `#f4eee1`): canvas-image is an inline SVG
  feTurbulence grain data-URI (3.5% alpha); warm cream ramp
  `#f4eee1`/`#faf6ec`/`#fcf9f2`/`#fefcf6`; warm umber hairline borders; ink
  `#35291a` label ramp; vermilion `#c2402a` accent and buttons.
- `blueprint` 蓝晒图 (dark, boot `#10293f`): 32px white grid canvas-image;
  cyanotype ramp `#10293f`/`#16324c`/`#1b3a57`/`#20425f`; white-alpha borders;
  pale blue-white `#e6eef6` labels; pale-cyan linework brand `#dcebf7`; amber
  `#e8a33d` as the marking/selection color.
- `phosphor` 琥珀磷光 (dark, boot `#0d0a05`): scanline center-image (3px);
  warm near-black ramp `#0d0a05`/`#161006`/`#1c1509`/`#231a0c`; amber-tinted
  label ramp `#f2e8d8`…; single amber `#ffb000` on brand/link/buttons/
  business; success/warn fold neutral; error keeps platform red.
- `sumi` 墨韵 (light, boot `#fafaf8`): no texture; cool paper ramp
  `#fafaf8`/`#f3f3f0`/`#ecece8`/`#e4e4df`; neutral ink borders; ink `#1c1c1a`
  labels; ink-black brand and buttons with cinnabar `#b53a26` on links, the
  business state, and the selected row.
- `sage` 苔原绿 (light, boot `#edf0e8`): green-gray ramp
  `#edf0e8`/`#f4f6ef`/`#f9faf4`/`#fcfdf9`; green-gray hairlines; deep
  green-ink `#26332a` labels; moss `#3f6b4a` accent.

Boot `DARK_THEME_IDS` derives from `BUILTIN_THEMES` automatically.

### S2.4 Distinct preview motifs

- `gallery.ts`: `ThemeGalleryEntry` gains `motif: PreviewMotif`; a
  `THEME_MOTIFS` map in the same package assigns one per known id
  (`system: 'split'`, `light: 'sheet'`, `dark: 'night'`, `graph-glass:
  'grid'`, `mono-accent: 'beacon'`, `strata-dark: 'strata'`, `paper: 'grain'`,
  `blueprint: 'plan'`, `phosphor: 'crt'`, `sumi: 'ink'`, `sage: 'fern'`,
  `custom: 'bespoke'`); unknown registered themes fall back to `'plain'`
  (the current composition), so third-party registrations keep working.
- `AppearanceRow.module.css` renders each motif from the existing three
  preview variables plus static gradients/pseudo-elements (diagonal system
  split, grid lines, scanlines, hatching, seal dot, glow bar). The JSX only
  adds the motif class via a typed `Record<PreviewMotif, string>` lookup —
  the previews stay registry-driven and never hardcode a theme's colors.

### S2.5 Copy

All new copy lives in the `settings.theme` namespace dictionaries
(`packages/client/ui-theme/src/client/locales.ts`), zh and en in the same
change: five theme names, `appearance.custom`, custom-group labels (scheme
toggle, canvas, accent, reset, input aria labels). `LocaleDictOf` keeps the
key sets compile-checked.

## [S3] Scope

- In scope: the section move, the merged section store, the custom-theme
  fields/synthesis/runtime/boot, five palettes, preview motifs, nav icon,
  i18n, tests and expected-output updates, README/doc sync.
- Out of scope: third-party theme API changes (`register()` untouched),
  desktop native theme forwarding, contrast auto-correction for off-band
  custom canvases, saving/naming multiple custom presets, accent presets
  shared across themes.

## Tasks

- [x] T1: `theme-settings.ts` custom preference/fields/schema, hex
      validation, `synthesizeThemeTokens` + unit tests (depends: none)
- [x] T2: `builtin-themes.ts` five palettes; boot custom passthrough + Host
      `apply()` (depends: T1)
- [x] T3: `ThemeRuntime` custom synthesis, `setCustom`, snapshot exposure
      (depends: T1)
- [x] T4: Shell migration — `settings.section` registration,
      `AppearanceSection.tsx`, section store merge, nav icon (depends: T3)
- [x] T5: Preview motifs — `gallery.ts` + `AppearanceRow.module.css`
      (depends: T4)
- [x] T6: i18n keys; update ui-theme / ui-settings-general specs, web e2e
      helpers and expected markdown (depends: T4, T5)
- [x] T7: README/docs sync (depends: T6)
- [x] T8: Full verification, visual walkthrough, review subagent, finalize
      spec (depends: T1–T7)

## [S4] Acceptance

- Settings sidebar shows 外观 with its own glyph between 通用 and 模型; the
  section contains the theme gallery, the custom theme group, and the font
  settings; General no longer lists them.
- The gallery renders 12 rows (system, ten built-ins, 自定义) each with a
  distinct motif; selection persists via the existing settings transport.
- Each new theme applies its full palette including texture tokens; the boot
  canvas matches the active theme (no first-paint flash), including custom.
- Editing custom scheme/canvas/accent persists, activates `custom`, and
  re-synthesizes tokens live; reset restores defaults; malformed hex is
  rejected by the schema.
- Old settings documents load unchanged (additive defaults); zh/en
  dictionaries stay complete (compile-enforced).
- Focused unit specs, `typecheck`, `build:check` after `build:artifacts`,
  `duplication`, and the settings web e2e pass locally with updated expected
  markdown.
- Review subagent returns pass on spec compliance, correctness, and
  codebase consistency.
