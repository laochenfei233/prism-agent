---
feature: usage-billing
status: in-progress
updated: 2026-11-04
branch: feat/usage-billing
commits: 50ff54bd96..HEAD
---

# Usage Billing

## Report

## [S1] Problem

The chat surfaces report token counts — the composer's usage pill and the completed-turn panel — but never money. A user cannot tell what a session has cost, and the only comparable third-party surface is a sidebar card plus dashboard, while the left sidebar is already crowded with panels and plugin entries.

## [S2] Design

### S2.1 Home: the existing statistics owner

The cost surfaces join `packages/client/ui-chat`, which already owns usage statistics (`UsagePill`, `TurnUsagePanel`, `StatsPills`), so no new package, bundle row, or sidebar entry is added. The two new surfaces are a session-header pill and a modal dashboard opened from it.

### S2.2 Session cost pill

`apply` registers one entry into `conversation.session.header.actions` (`id: 'usage-cost'`, `order: 30`), beside the job list and schedule entries. The pill shows `≈$0.012` — the session's estimated cost — and opens the dashboard modal on click. It renders nothing without billable tokens, a known model, or a unit price; it re-renders as the `tokenUsage` projection updates, so the current turn's cost is included while it streams.

Session cost prices the whole-log projection `tokenUsage` (`uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`) with the session's current route from the `modelSelection` projection and the currently active billing tier. The projection splits neither by time nor by route, so a session that changed models or crossed a tier boundary is estimated at today's route and tier; the dashboard labels the figure as an estimate.

### S2.3 Dashboard modal

The pill renders a `ui-primitives` `Modal` with: the estimated total and tier badge (peak / off-peak), one row per token bucket with its token count, unit price, and cost, the priced model, the built-in rate table for both DeepSeek models with peak and off-peak columns, and the custom unit-price editor (see S2.6). Escape, the mask, and the close button dismiss it; the modal owns focus like every other `Modal` consumer.

### S2.4 Built-in price table

Prices are USD per one million tokens at the off-peak rate, from the official pricing page (`https://api-docs.deepseek.com/quick_start/pricing`, read 2026-11-04):

| Model | Cache miss | Cache hit | Output |
|---|---|---|---|
| `deepseek-flash` | 0.15 | 0.003 | 0.6 |
| `deepseek-v4-pro` | 0.66 | 0.022 | 1.98 |

Peak hours bill at twice the off-peak rate. A peak hour is 01:00–04:00 or 06:00–10:00 UTC on a Monday–Friday. Chinese public holidays are off-peak per the same page; no holiday calendar ships, so holiday weekdays are priced as peak — a `shortcut:` comment marks the upgrade point. Cache-write tokens are priced at the cache-miss rate: the provider has no separate write price.

### S2.5 Per-turn cost

`TurnTokenUsage` already carries the route and exact buckets for a completed turn. `TurnUsagePanel` gains a cost row in its dialog and a cost in its collapsed trigger label (`Usage 12.3k tok · ≈$0.002`), priced at the turn's single route with the tier active at the turn's end time. A turn whose routes disagree, or whose model has no price, keeps the token-only presentation.

### S2.6 Custom unit prices

Per-model overrides `{ miss, hit, output }` (USD per million tokens) live in browser storage under `dsh.usage-billing.prices.v1`. Reads validate every entry and drop anything malformed; writes replace the whole map. An override replaces the built-in price for that model and is edited in the dashboard's rate section: three numeric fields for the priced model, save, and remove. Overrides are per browser, not per account — a `shortcut:` comment marks the settings-document upgrade path.

### S2.7 State ownership

`apply` creates one `UsagePricePolicy` (a snapshot store over the stored overrides) and passes it through two inject faces: the header action's hooks and the `turn-tail` node's hooks. Components never read storage directly, and the pill and the turn panel cannot disagree about a price.

### S2.8 Copy and absence

Every string is a `chat` dictionary key. Absent state is silent, never an error: no tokens or no price hides the pill; a failed storage read yields no overrides; the dashboard shows "未收录单价" with the editor for the selected model so the user can price it.

## [S3] Scope

- In scope: the session header pill, the dashboard modal, the built-in price table and tier rule, per-turn cost, custom unit prices, tests, package README and changelog.
- Out of scope: cross-session, monthly, or per-project aggregation; budgets, alerts, peak-hour notifications; balance reconciliation; currency conversion; a sidebar entry or panel; touching the `tokenUsage` or `modelSelection` projections.

## Tasks

- [ ] T1: pricing module (table, tier rule, cost math, formatting) with unit tests (depends: none)
- [ ] T2: custom-price policy over browser storage with validation and unit tests (depends: T1)
- [ ] T3: header cost pill and dashboard modal, registered in `apply`, with component tests (depends: T2)
- [ ] T4: per-turn cost in `TurnUsagePanel` and `TurnTailNodeView` with tests (depends: T1)
- [ ] T5: dictionary keys, README, changelog entry (depends: T3, T4)
- [ ] T6: verification — `test:gui`, typecheck, build, browser snapshot replay (depends: T5)

## [S4] Acceptance

- [ ] A session with billable tokens and a priced model shows the estimated cost in the session header; one without either shows no pill.
- [ ] The pill opens a dashboard listing every token bucket with cost, the active tier, and both built-in rates.
- [ ] A saved custom price changes the pill, the dashboard, and the per-turn cost that use that model.
- [ ] A completed turn's dialog shows its cost priced at that turn's route and end-time tier.
- [ ] Peak and off-peak windows are computed in UTC, Monday through Friday, with the peak factor of two.
- [ ] Malformed stored price data is ignored, never thrown.
- [ ] All copy is locale-owned; no literal product string ships in a component.
- [ ] `pnpm run test:gui`, the package typecheck, and the client build pass.
