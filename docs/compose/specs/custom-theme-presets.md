---
feature: custom-theme-presets
status: in-progress
updated: 2026-10-31
branch: feat/custom-theme-presets
commits: 0d1cb5bf50.. # filled at delivery
---

# Custom theme presets: save, apply, and delete named color schemes

## Report

## [S1] Problem

The custom theme holds exactly one set of inputs (`customScheme`,
`customCanvas`, `customAccent`): saving a second look overwrites the first.
Users who tune several schemes (one per mood or per workspace) cannot keep
them.

## [S2] Design

### S2.1 Storage

- `theme-settings.ts` gains `CustomThemePreset { name, scheme, canvas, accent }`
  and `ThemeSettings.customPresets: CustomThemePreset[]` (default `[]`,
  additive — old documents load unchanged). The schema validates each item:
  non-empty string name, scheme union, hex canvas/accent.
- The `ui-theme` Host `Config` mirrors the field (volatile) so the browser
  write path accepts it; `docs/config-catalog*.md` regenerate.

### S2.2 Runtime

- `ThemeRuntime` carries the presets in state, adopts them through the same
  tolerant reader as the other custom fields (invalid entries dropped, colors
  normalized, duplicate names keep the first, capped at 16), and publishes
  them on `ThemeSnapshot.customPresets`.
- `saveCustomPreset(name)`: trims the name (empty or over 24 code points
  throws before any write), upserts by name over the CURRENT custom inputs,
  and writes the whole array in one settings mutation. Saving never changes
  the active preference.
- `deleteCustomPreset(name)`: removes the entry and writes the array;
  deleting the active preset leaves the current inputs untouched.
- Applying a preset reuses `setCustom` (which switches the preference to
  `custom`); no new activation path exists.

### S2.3 UI

The custom-theme group gains a preset area below the accent field: a save row
(text input + 保存 button, enabled while the name has content) and one chip per
preset. A chip applies its scheme/canvas/accent through `setCustom`; a per-chip
× deletes it (accessible name carries the preset name). Presets stay inside
the custom group — the gallery remains the bounded, registry-driven surface.

### S2.4 Copy

`settings.theme` namespace, zh and en together: group label, placeholder,
save, and delete labels.

## [S3] Scope

- In scope: schema/host mirror, runtime save/delete/adopt/snapshot, section
  store + group UI, i18n, ThemeSnapshot consumer updates, config-catalog
  regeneration, README sync, tests.
- Out of scope: renaming (delete + re-save), preset rows in the gallery,
  import/export, reordering, boot changes (presets never affect first paint).

## Tasks

- [ ] T1: schema + types, runtime save/delete/adopt, snapshot field,
      consumer literals + tests (depends: none)
- [ ] T2: section store, `CustomThemeGroup` preset UI, i18n (depends: T1)
- [ ] T3: Host `Config` mirror, config-catalog regen, README sync (depends: T1)
- [ ] T4: verification, visual walkthrough, review subagent, finalize spec
      (depends: T1–T3)

## [S4] Acceptance

- Saving the current inputs under a name persists an entry, appears as a
  chip, and survives reload (durable document).
- Clicking a chip applies its colors, switches the preference to `custom`,
  and the synthesized tokens update live.
- The × chip deletes the entry; deleting the active one keeps the current
  look; saving over an existing name replaces it.
- Malformed preset documents are dropped at the runtime boundary; the schema
  rejects malformed wire values; the array caps at 16 entries.
- Old documents load unchanged; zh/en dictionaries stay complete.
- Focused specs, `typecheck`, `build` (incl. build:check), catalog gates, and
  the review subagent pass.
