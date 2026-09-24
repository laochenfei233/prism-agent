---
feature: design-conformity-audit-and-mimo-fix
status: delivered
updated: 2026-07-26
branch: master
commits: pending (staged, user decision on commit)
---

# Design Conformity Audit + MiMo Loading Fix

## Report

**What was built**

1. **MiMo default provider/model loading was broken** because the internal provider id in `defaultModel.ts` and `defaultModelSeeder.ts` was `'xiaomi'` — a value not in `SystemProviderId` enum, not in `PROVIDER_URLS`, and not in the provider-registry. Fix: `DEFAULT_MODEL_PROVIDER_ID` → `'mimo'`, seeder rewritten with `endpointConfigs` (http://api.xiaomimimo.com + anthropic), idempotent self-heal migrating existing broken `'xiaomi'` DB rows, merging apiKeys, re-pointing default model preferences to `mimo::mimo-v2-5`. Version bumped to `v3-mimo-id`.

2. **Design conformance** applied across 10 renderer files without touching fonts. `--material-*` tokens gained reduced-transparency solid fallbacks and glass-vibrancy text-shadow. Structural chrome (sidebar, tab bar, settings left pane) replaced hard dividers with shadow depth or translucent glass. Settings groups became `material-thin` rounded cards. Tracing/tracking added to titles, page transition upgraded to fade + 6px y-settle. Feature panels swapped hard borders for depth shadows.

**Verification**

- `npx tsc --noEmit` — EXIT:0
- `npx vitest run` — 77 files, 888 tests, PASS
- Independent subagent review confirmed all acceptance criteria met; two code-quality findings fixed.

**Journey log**

1. `batchUpsertTx` is insert-ignore → fresh-install must seed endpoints directly.
2. Model check by `(providerId, modelId)` not PK — `PresetModelSeeder` uses `crypto.randomUUID()` ids.
3. `backdrop-filter` on flex-docked chrome doesn't produce glass — shadow depth used instead.
4. `mimoKeys === '[]'` is dead code (Drizzle JSON-mode column always parses on SELECT).
5. `file-processing` → `document-processing` route rename was pre-existing user WIP, confirmed correct.

## [S1] Problem

Two unrelated problems on the `master` branch (v2 refactor, actively WIP):

1. **MiMo provider/model cannot load.** The default chat model never fetches models,
   and the default MiMo provider has no API host.
2. **Visual design drift.** The app (Shadcn/Tailwind based) has not been audited
   against Apple's fluid-interface philosophy (`apple-design`) nor the iOS 26
   Liquid Glass design language (`ios26-liquid-glass`). The `DESIGN.md` referenced
   by `AGENTS.md` does not exist at the repo root, so there is no agreed design
   spec to anchor styling.

## [S2] Design

### [S2.A] MiMo loading fix — minimal, evidence-backed

Root cause (verified against code):

- Canonical internal **system provider id for MiMo is `'mimo'`**:
  - `src/shared/utils/systemProviderId.ts:62` enumerates `'mimo'` (not `'xiaomi'`).
  - `src/renderer/pages/settings/ProviderSettings/providerUrls.ts:664` (`PROVIDER_URLS`)
    has a `'mimo'` entry only.
  - `packages/provider-registry/data/providers.json` builds the runtime provider
    with `id: "mimo"`, `defaultChatEndpoint: "openai-chat-completions"`,
    `endpointConfigs`:
      - `anthropic-messages` → `https://api.xiaomimimo.com/anthropic`
      - `openai-chat-completions` → `https://api.xiaomimimo.com`
- But the **default-model preset and seeder use `'xiaomi'`** as the internal
  provider id:
  - `src/shared/data/presets/defaultModel.ts:3` `DEFAULT_MODEL_PROVIDER_ID = 'xiaomi'`
    → `DEFAULT_UNIQUE_MODEL_ID = 'xiaomi::mimo-v2-5'`.
  - `src/main/data/db/seeding/seeders/defaultModelSeeder.ts:12`
    `DEFAULT_PROVIDER_ID = 'xiaomi'`. It inserts a `user_provider` row with
    `providerId='xiaomi'` and **no `endpointConfigs`**, three `user_model` rows
    under `provider_id='xiaomi'`, and four default preferences pointing at
    `xiaomi::mimo-v2-5`.
- Consequences:
  - The seeded `'xiaomi'` provider is **not a `SystemProviderId`**, has **no entry
    in `PROVIDER_URLS`**, and never received `endpointConfigs` → `useProviderHostPreview`
    resolves no configured host → `routeToEndpoint` returns empty baseURL →
    `/providers/:id/models:resolve`/`ai.list_models` cannot reach the API → models do
    not load.
  - Meanwhile the registry-seeded correct `'mimo'` provider (with endpoints) exists
    in the DB but the app's default model preference does not use it.
  - `src/main/data/services/ProviderService.ts:300` `batchUpsertTx` is
    **insert-ignore** (only inserts absent rows; never updates). Therefore if any
    seeder creates a `'mimo'` provider **without** endpoints first, the registry's
    later upsert is a no-op and the broken state is preserved. The fix must seed
    the `'mimo'` provider WITH the registry's endpoint values, not empty.
  - `user_model.providerId` is a FK → `user_provider.providerId`
    (`ON DELETE CASCADE`). Seeder order is `DefaultModelSeeder` **before**
    `PresetProviderSeeder`/`PresetModelSeeder` (`seederRegistry.ts`), so the seeder
    must create the `'mimo'` provider row before its `user_model` rows to satisfy the
    FK.

Fix contract (minimal — per user decision):

- `src/shared/data/presets/defaultModel.ts`:
  - `DEFAULT_MODEL_PROVIDER_ID` → `'mimo'`. `DEFAULT_UNIQUE_MODEL_ID` becomes
    `mimo::mimo-v2-5`. All consumers compare via this const, so the rename is
    coherent (`ModelService`, `shared/utils/provider.ts`,
    `shared/utils/model.ts`, `defaultAssistant.ts`).
- `src/main/data/db/seeding/seeders/defaultModelSeeder.ts`:
  - `DEFAULT_PROVIDER_ID` → `'mimo'`.
  - When creating the `'mimo'` provider row, populate `endpointConfigs` and
    `defaultChatEndpoint` to the registry's MiMo values (openai + anthropic base
    URLs above) so that even though `batchUpsertTx` is insert-ignore, the provider
    is usable out of the box. A comment references the registry block.
  - Keep creating the three `user_model` rows with `id = uniqueId`
    (`mimo::mimo-v2-5`, `…-pro`, `…-ultraspeed`) so the default-model preference
    resolves to a real row (the preset model seeder uses random-uuid ids and does
    not populate these unique-id rows).
  - Bump seeder `version` so `run-on-change` re-runs once.
- Idempotent self-heal for **existing** installs (inside the same seeder `run`,
  before the create-if-absent steps), so users whose DB already has the broken
  `'xiaomi'` rows get fixed on the next boot:
  1. If a `user_provider` row with `providerId='xiaomi'` exists:
     - ensure a usable `'mimo'` provider row exists (create with the registry
       endpoint values if missing; otherwise set endpoints if null);
     - if `'mimo'` has no API keys and `'xiaomi'` does, copy the keys over
       (preserve user-entered credentials);
     - delete `user_model` rows under `provider_id='xiaomi'`;
     - delete the `'xiaomi'` `user_provider` row.
  2. Re-point default-model preferences: for the four known default preference keys
     set `value = DEFAULT_UNIQUE_MODEL_ID` whenever the current value equals the old
     `xiaomi::mimo-v2-5` (covers the prior default). Same for the `pro` /
     `ultraspeed` old unique ids if any pref points at them.
- Out of scope (per user): MiMo OAuth login — `mimoOAuth.ts:23` requests
  `oauth.sign_in` with `providerId: 'xiaomi'`, but
  `src/main/services/oauth/runtime/providerDefinitions.ts:14` only registers codex
  + grok, so `getDefinition('xiaomi')` throws. This is a separate, larger fix and
  is **not** addressed here.
- Out of scope: provider-registry source/build drift (`mimo.ts` source id
  `'xiaomi'` vs built `providers.json` id `'mimo'`, baseUrl `/v1` vs no `/v1`).
  The user's working tree already has pending changes there; left untouched.

### [S2.B] Design conformity — full sweep, no font changes

Apply `apple-design` + `ios26-liquid-glass` to all renderer pages. **Fonts are
excluded**: the existing settings-driven font (`--font-family` /
`--code-font-family` in `src/renderer/assets/styles/font.css`, with system-font
fallback) is kept. Do NOT introduce SF Pro / liquid-glass font stacks.

Tokens to add/align (global, in `src/renderer/assets/styles/index.css` and a new
tokens layer) — naming must not collide with existing `--font-*`:

- **Glass surfaces** — `.glass`, `.glass-light/medium/heavy/solid` utilities and
  CSS vars (`--glass-blur`, `--glass-bg`, `--glass-border`, `--glass-shadow`), light
  + dark, with `backdrop-filter`. Respect `prefers-reduced-transparency`.
- **Motion** — additive CSS vars only (do not force springs on gesture paths):
  `--ease-apple`, `--ease-spring`, `--dur-3` (`200ms`), `--dur-4` (`300ms`); a
  reduced-motion override that keeps opacity/short cross-fades. Handels already
  using transitions get the standard eased tokens.
- **Spacing/radius/shadow** — keep the existing Tailwind/Shadcn scale; only
  normalise places that diverge without reason. Add `--card-ring` (the "bright top
  edge" highlight) for translucent surfaces.
- **Depth/layering** — sticky header/toolbar/navbars read as translucent floating
  chrome with content scrolling under; hard dividers replaced by edge-fade masks
  where floating UI overlaps content.

Page-by-page application (procedural, not by rewrite):

- App shell / sidebar / topbar / scrollbars (T5).
- Settings: `SettingsPage`, `SystemSettings`, `AdvancedSettings`,
  `ProviderSettings*` (left list + sections), `WebSearchSettings`, `Shortcut`, etc.
- Chat / home / workspace / translate / tasks / tools / workflows / knowledge
  pages.

Constraints: match surrounding Tailwind/Shadcn conventions; `@cherrystudio/ui`
components are reused (not rebuilt); i18n hardcodes forbidden; central logging; no
`console.log`; no font changes.

## [S3] Out of Scope

- Fonts (explicitly excluded by the user).
- MiMo OAuth login fix + provider-registry source/build reconciliation.
- v1 maintenance.
- New features beyond visual conformity + the mimo default-id fix.
- Re-architecting data layers; only the seeder/preset constants + self-heal SQL
  are touched for the mimo fix.

## Tasks

- [x] T1: Write this compose spec doc — acceptance: doc exists at
  `docs/compose/spec/design-conformity-audit-and-mimo-fix.md` (covers: S2)
- [x] T2: Fix mimo default provider/model loading — acceptance: on a fresh DB the
  default model pref is `mimo::mimo-v2-5` under a `'mimo'` provider that has
  populated `endpointConfigs` (openai + anthropic base URLs); on an existing DB
  with a broken `'xiaomi'` provider, the next boot migrates it away and re-points
  default prefs to `'mimo'`. `pnpm typecheck` + relevant vitest pass.
  (covers: S2.A; depends: T1)
- [x] T3: Verify mimo fix — acceptance: fresh-run `pnpm typecheck`,
  `pnpm test --run <mimo/seeder suites>` and `pnpm build:check` pass or
  pre-existing failures are flagged. (depends: T2)
- [x] T4: Design tokens layer (glass + motion + edge tokens), no fonts —
  acceptance: new tokens compile; reduced-transparency / reduced-motion media
  queries active; no `--font-*` changes. (covers: S2.B)
- [x] T5: Core shell/nav/scrollbars translucent + motion — acceptance: floating
  chrome shows content scrolling under; hard dividers replaced where floating UI
  overlaps; springs not forced on gesture paths. (covers: S2.B; depends: T4)
- [x] T6: Settings pages conformity — acceptance: list/sections use glass grouping,
  spacing hierarchy, inline (not submit) validation cues unchanged in behavior.
  (depends: T4, T5)
- [x] T7: Remaining pages conformity (chat/home/workspace/translate/tasks/tools/
  workflows/knowledge) — acceptance: applied without behavior or font changes.
  (depends: T4, T5)
- [x] T8: Verify all design changes — acceptance: `pnpm lint`, `pnpm test`,
  `pnpm format`, `pnpm build:check` pass or pre-existing failures are flagged with
  identifiers. (depends: T2–T7)
- [x] T9: Fresh-subagent review of the full diff — acceptance: spec-compliance,
  correctness, codebase-consistency conclusions returned. (depends: T8)
- [x] T10: Finalize feature doc (status delivered, report) and report to user.
  (depends: T9)