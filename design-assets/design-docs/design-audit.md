# Design Conformity Audit — prism-agent renderer

Scope: all renderer pages and global chrome, audited against two references —
`apple-design` (Apple's *Designing Fluid Interfaces* philosophy, §1–17) and
`ios26-liquid-glass` (iOS 26 Liquid Glass design language). Fonts are
**explicitly excluded** per user instruction: the existing settings-driven
`--font-family` / `--code-font-family` system (`src/renderer/assets/styles/font.css`)
with its `-apple-system`/`system-ui` fallbacks stays as-is. This document lists
**issues only**; the implementation plan that consumes it lives in
`docs/compose/spec/design-conformity-audit-and-mimo-fix.md`.

Evidence state is real — every claim cites a file:line in the repo.

---

## 0. What already conforms (don't re-touch)

A surprising amount of groundwork is already present; the gap is **adoption**,
not absence:

| Already good | Where |
| --- | --- |
| Translucent material utilities + light/dark tokens, `prefers-reduced-transparency` + `prefers-contrast` guards | `src/renderer/assets/styles/tailwind.css:29–196` |
| Apple depth shadows (`--shadow-float/modal/sheet`) | `tailwind.css:39–42, 78–82` |
| Spring presets (default/snappy/gentle/momentum/sheet/tab/toast), reduced-motion helper, `MATERIAL.*`, `FADE_UP`/`SCALE_FADE`/`SLIDE_LEFT` | `src/renderer/lib/appleDesign.ts:1–81` |
| Global press-on-down tactile feedback (`button:active { transform: scale(0.97) }`) | `index.css:214–226` |
| Reduced-motion global override that keeps opacity transitions, kills springs/scroll-smooth | `index.css:238–247`, `animation.css:20–24, 140–146, 192–193, 262–267` |
| Chat-message enter/exit + composer-dock animations, transform-origin set | `animation.css:197–267` |
| iOS-26 glass blur tiers referenced (`light/medium/heavy/solid`) conceptually map to `material-ultra-thin/thin/regular/thick` | already 4 tiers in `tailwind.css` |

So the audit is **not** "add glass tokens" — they exist. It is "the high-traffic chrome and most pages are opaque and flat; wire them to the tokens that already exist."

---

## 1. App shell & navigation chrome (highest leverage)

### 1.1 Sidebar is opaque on Windows/Linux — `CRITICAL`
`src/renderer/components/Sidebar/Sidebar.tsx:202–204`
```tsx
isMacTransparentWindow ? 'bg-transparent' : 'bg-sidebar'
```
`--app-sidebar` is a flat neutral oklch (`tailwind.css:44` light = `oklch(0.9672 0 0)`, `:83` dark = `oklch(0.2393 0 0)`). On non-Mac the sidebar is a **solid opaque slab** with no translucency and no depth. `apple-design` §12: sidebars read as "structural region" → heavier material, and chrome is translucent with content scrolling under. `ios26-liquid-glass` §2.1: sidebars/nav are Medium/Heavy Glass. Only the floating variant (`Sidebar.tsx:121`) gets `backdrop-blur-2xl backdrop-saturate-150`.

**Fix direction**: docked sidebar uses `material-regular` (Medium Glass) on non-Mac; keep `--app-sidebar` as the fallback *color* behind the blur only. Apply `--shadow-float` so the sidebar reads as a layer above content.

### 1.2 App tab bar — opaque, no material
`src/renderer/components/layout/AppShellTabBar.tsx` (entire component) renders the top window tab strip. No `material-*` class, no `backdrop-filter`, no depth shadow. `apple-design` §12: toolbars are floating translucent layers; `ios26` §5.2 navbar spec is exactly `rgba(255,255,255,0.72)` + `blur(40px)`.

**Fix direction**: tab strip uses `material-regular` + `--shadow-float`, with a scroll-edge fade mask where tabs meet overflow (§12 "scroll edge effects, not hard dividers").

### 1.3 Settings left list pane uses a hard right divider — `CRITICAL`
`src/renderer/pages/settings/SettingsPage.tsx:44, 47`
```tsx
isMacTransparentWindow ? 'bg-transparent' : 'bg-white dark:bg-background'
…border-border border-r-[0.5px]
```
Same opaque-slab pattern as the sidebar. `apple-design` §12 explicitly says "never stack a light translucent surface on another" — but here we'd instead make the **list** the translucent pane and keep content opaque, OR keep content translucent-regular and the list a thinner ultra-thin. Pick the lower-risk: list = `material-thin` + `border-border-muted`, content stays solid for legibility.

### 1.4 Scrollbars never adapt to translucent surfaces
`src/renderer/assets/styles/scrollbar.css:1–65` defines thumbs as flat `rgba` with `background: transparent` track — fine, but with no blur behind the thumb there's no "edge fade" when floating chrome overlaps. Lower priority; call out only.

---

## 2. Settings pages (shared primitives)

### 2.1 `SettingGroup` separates with a border only — `CRITICAL`
`src/renderer/components/SettingsPrimitives.tsx:111–120`
```tsx
className={cn('mt-2 border-border/60 border-t pt-3 first:mt-0 first:border-t-0 first:pt-0', className)}
```
Sections are visual **only** via a `border-t + pt-3`. No card, no material, no radius. `apple-design` §12 + `ios26` §5.4: grouping = a card/elevated surface; material weight encodes hierarchy. `§16 Familiarity/Clarity`: proximity implies relationship, so a contained group reads more clearly than `border-t`.

**Fix direction**: `SettingGroup` becomes a `material-thin` (light) / `material-regular` (in a busy content column) rounded card (`radius-lg`, `p-4`) with `--shadow-float-`-lite and a subtle top edge highlight (`::before` 1px `rgba(255,255,255,0.4)`). Keep the `first:` reset so the page top isn't double-padded. Sections separated by spacing instead of hairlines.

### 2.2 `SettingTitle` lacks optical-size tracking
`SettingsPrimitives.tsx:55–60` — `font-semibold text-[15px]`, no `letter-spacing`. `apple-design` §15: tracking is **size-specific**; at 15px a tiny negative tracking (`-0.01em`) tightens titles, body near `0`. No font change needed — this is tracking, not family.

### 2.3 `SettingRow` could use haptic-style hover (not needed hard)
Current rows have no hover affordance; Apple lists highlight on hover for pointer users. Optional; out of the critical set unless we want it.

### 2.4 Page transitions are opacity-only
`SettingsPage.tsx:158` wraps `<Outlet/>` in `animation-fade-in` (opacity only). `apple-design` §7 "symmetric paths": entering should hint direction. `animation.css` already has `animation-move-down-in/out`. Low-risk upgrade: content fades + 6–8px `y` settle, exit mirrors. Springs not required (page nav isn't gesture-driven); the existing `--ease-out` cubic-bezier is fine.

---

## 3. Feature pages — surveyed

### 3.1 Knowledge & Workflows side-panels already glass, but content under them isn't scroll-aware
`KnowledgePage.tsx:107, 228` and `WorkflowsPage.tsx:113` apply `material-regular`. Good. But the panes are static `flex` columns, not floating; they don't visually separate from the main content via depth (`--shadow-float` is unused — `grep shadow-float` returns 0 usages outside the definition). Add `--shadow-float` (or a right-facing shadow) so the panel reads as lifted.

### 3.2 Chat / Home / Agent shells
`AgentPage.tsx`, `HomePage.tsx`, `Shell.tsx` — heavy lift, not audited line-by-line here. Spot check: `ConversationSidebarToggleButton` exists; chat message enter animations exist (`animation.css:197–267`). Known drift from `apple-design`:
- No velocity-handoff evidence on the composer dock / drawer (§3–§5). The composer uses `animation-chat-composer-dock-down` — a `@keyframes` scale/opacity, **not** a spring, and not interruptible mid-flight. `apple-design` §3 "the single most important principle": gesture-driven motion must be interruptible & start from the presentation value. If the composer dock is draggable, this keyframes animation is a regression. → needs a spring (use `appleDesign.SPRING_SHEET`) if draggable; keep keyframes if it's dismiss-only.
- Chat message enter uses keyframes (`animation-chat-message-enter-*`) — fine for a non-gesture enter, acceptable.

### 3.3 Translate / Tasks / Tools pages
Not individually audited. Likely share `SettingGroup`/`SettingsContentColumn` or their own list shells. Expect the same opaque-pane + hairline-divider issues as §2 once inspected. Treatment follows §2.1 and §1.3 patterns.

### 3.4 Settings sub-pages (Appearance, Notifications, Shortcut, Data, About, Provider, Model, MCP, Document Processing, etc.)
All consume `SettingsPrimitives` or `SettingsContentColumn`, so the §2 fixes cascade. `ProviderSettings*` has its own sidebar (`ProviderList/*`) similar to `SettingsPage` — apply the §1.3 list-pane treatment uniformly.

---

## 4. Motion & interaction gaps (cross-cutting)

### 4.1 Springs available but unused in gesture paths
`appleDesign.ts` exports `SPRING_DEFAULT/MOMENTUM/SHEET/TAB/TOAST`, but `grep SPRING_` in `src/renderer` shows them **only defined**, not used in components (need confirm at implementation time). `apple-design` §3/§4: anything a user can touch/drag → spring. Audit each draggable surface (split panes, composer dock, drawer, reorderable lists) at implementation time and swap `transition`/`@keyframes` for the matching preset.

### 4.2 Touch-device hover nuke is too broad — `MEDIUM`
`index.css:228–235`
```css
@media (hover: none) and (pointer: coarse) {
  *:hover { background-color: inherit !important; color: inherit !important; transform: none !important; }
}
```
This nukes *every* hover affordance on touch devices, including structural hovers that can't misfire. `apple-design` §10: tap gets highlight on pointer-*down*; here we just remove hover. Prefer: scope to interactive elements only (`button:hover`, `[role=button]:hover`), and ensure :active provides the feedback. Lower priority but flag.

### 4.3 No `will-change` on heavy-motion surfaces
`apple-design` §11: hint `will-change: transform, opacity` where motion is imminent. None set on chat message wrappers or the composer. Minor perf item; bundle with §3.2.

### 4.4 No momentum projection / rubber-banding at boundaries
§6 and §9 of `apple-design` describe flick-projection and rubber-band edges. The app's scrollable surfaces use plain overflow scroll. Realistic scope note: full rubber-banding is heavy and out of scope; **document as known gap**, implement only if a specific surface (e.g. tab strip overflow) deserves it. Do **not** add it speculatively.

---

## 5. Depth & material — cross-cutting

### 5.1 Depth shadows defined, never used — `MEDIUM`
`grep -r 'shadow-float|shadow-modal|shadow-sheet' src/renderer` → 0 hits. All depth is currently conveyed by `border`/`border-r`/`bg-card`. `apple-design` §12 depth ≠ flat borders. As pages adopt `material-*` (§2.1, §3.1), pair each with the shadow tiers already defined.

### 5.2 Light-on-light legibility risk on glass
`apple-design` §12: "Never stack a light translucent surface on another — legibility collapses." When we make `SettingGroup` a `material-thin` card **inside** a `SettingsContentColumn` whose parent is itself glass (e.g. the settings left-pane made translucent per §1.3), we risk exactly this. Rule for implementation: glass pane + glass card = bump the card to `material-regular` or keep the parent opaque. Enforce at implementation per-page, not globally.

### 5.3 `prefers-reduced-transparency` documented in tokens, but no per-surface solid fallback
`tailwind.css:179–187` neutralizes `backdrop-filter` under reduced-transparency, but backgrounds stay at the translucent rgba → still semi-transparent. `apple-design` §14: raise background opacity to near-solid, drop blur. Fix: under that media query, set `--material-*` to opaque (`rgba(255,255,255,0.98)` etc.). One-line token tweak.

---

## 6. Accessibility (§14 + ios26 §9)

- **Touch targets**: `ios26` §9.3 requires 44×44pt min. Several `SettingRow` siblings (Switch + label) are inline-flex with no min-height; the row container is `min-h-6` (24px) — below the 44pt bar. Not strictly broken (Switch has its own hit area) but worth a `min-h-11` on rows that are themselves clickable. Verify per-component at implementation; don't blanket-pad.
- **Contrast on glass text**: `SettingRowTitle` is `text-foreground`; on a `material-thin` card over a busy wallpaper, foreground-only text may dip below 4.5:1. `ios26` §4.3 prescribes `vibrancy` (text-shadow + slight weight bump) for glass-on-text. Apply a subtle `text-shadow: 0 1px 2px rgba(255,255,255,0.5)` (light) / `rgba(0,0,0,0.5)` (dark) on titles inside `material-thin` cards only — scoped, not global.

---

## 7. What is explicitly OUT OF SCOPE for the modification pass

1. **Fonts** — do not change `--font-family`, `--code-font-family`, or introduce SF Pro / `ios26`'s font stack. Per user.
2. **Gyro-driven highlight motion** (`ios26` §2.2 deviceorientation) — desktop app; irrelevant.
3. **Full rubber-banding + momentum projection** — too heavy without a specific surface justification (§4.4).
4. **MiMo OAuth login** — separate from this design pass; lives in mimo spec section.
5. **v1 maintenance** — out per repo rules.
6. **New components** — reuse `@cherrystudio/ui`; only restyle/existing-token-wiring.

---

## 8. Prioritized fix list (feeds the implementation tasks)

| # | Priority | Area | Issue (ref above) | Touches |
| --- | --- | --- | --- | --- |
| F1 | CRITICAL | Shell | Sidebar opaque on non-Mac (§1.1) | `Sidebar.tsx` |
| F2 | CRITICAL | Shell | App tab bar opaque (§1.2) | `AppShellTabBar.tsx` |
| F3 | CRITICAL | Settings | Settings left pane opaque + hard divider (§1.3) | `SettingsPage.tsx`, likely `ProviderSettings` list |
| F4 | CRITICAL | Settings | `SettingGroup` border-only groups (§2.1) | `SettingsPrimitives.tsx` (cascades to ~all settings pages) |
| F5 | HIGH | Tokens | `--material-*` need solid fallback under reduced-transparency (§5.3) | `tailwind.css` |
| F6 | HIGH | Depth | Use `--shadow-*` wherever we add `material-*` (§5.1) | inline per-page |
| F7 | MEDIUM | Motion | Wire `SPRING_*` into draggable surfaces (§4.1); composer-dock if draggable (§3.2) | component-level |
| F8 | MEDIUM | Settings | `SettingTitle` size-specific tracking (§2.2) | `SettingsPrimitives.tsx` |
| F9 | MEDIUM | Settings | Page transition fade + y-settle (§2.4) | `SettingsPage.tsx` |
| F10 | MEDIUM | Glass | Vibrancy `text-shadow` on titles inside `material-thin` cards (§6) | scoped css |
| F11 | LOW | Touch | Scope the coarse-pointer hover nuke (§4.2) | `index.css` |
| F12 | LOW | Feature | Add `--shadow-float` to Knowledge/Workflows glass panels (§3.1) | 3 files |
| F13 | LOW | Knowledge/Workflows / Translate / Tasks / Tools | Audit-then-apply §2/§5 patterns (§3.3) | per-page |

This table is the input to tasks T4–T7 in the compose spec. Implementation order: F4 → F3 → F1 → F2 → F5/F6 (tokens+depth as they're applied) → F7–F13 page by page.