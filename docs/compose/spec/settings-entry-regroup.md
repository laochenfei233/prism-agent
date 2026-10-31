---
feature: settings-entry-regroup
status: delivered
updated: 2026-10-31
branch: feat/settings-entry-regroup (worktree .worktrees/settings-entry-regroup)
commits: 421ebe5731..4481fd6089
---

# Settings Entry Regroup

English | [中文](settings-entry-regroup.zh.md)

## Report

**What was built** — The signed-out sidebar launcher is the plain 设置 button: a gear-icon button that opens the settings dialog through the existing `openSettings`, with no menu; the signed-in launcher keeps the avatar menu, which now lists exactly 设置 (with the shell's key combination) and 退出登录. Sign-in moved onto the Models page's DeepSeek card: the account package registers `settings.models.provider-card` under the key `llm-deepseek`, and the card shows a 登录 action in every posture while signed out, starting the same launcher-hosted dialog. Feedback closes the General settings column as a `settings.general.item` row (id `feedback`, order 110) that opens `ContactConfig.issuesUrl` — a new validated bootstrap field defaulting to `https://github.com/laochenfei233/prism-agent/issues` — in a new tab, and the replaced Feishu questionnaire path (`contactUs` operation, `contact-url.ts`, `contactFormUrl`/`contactSource`) is deleted. The reused feedback label key is renamed `contactUs` → `feedback`; the unrelated `more` key stays for the Account settings balance row.

**Verification** — `pnpm run typecheck`: 5 gates PASS. `pnpm exec vitest run packages/client/ui-settings-account`: 378/378 across 24 files. Web e2e (`vitest.web.config.ts`): onboarding-native 2 (models golden refreshed: the DeepSeek card gains the 登录 button; the signed-out-menu golden deleted), account-login 1 (signs in through the DeepSeek card), menu-material 1 (panel More menu replaces the account menu as the measured surface; session-menu golden refreshed), shortcuts 7, collapse-timing + agent-team-panel 7, settings-chrome 18 (dialog goldens refreshed), workspace-management 17, bonus-notice 1, window-drag-coverage 1 + 5 platform-skipped. Pre-commit staged hooks (lint of changed files, translation pairing, whitespace): PASS. `verify-md-wrap`: PASS (the pre-existing duplicate Report paragraph in the divergence index pair was removed). `gen-config-catalog` re-recorded the deployment reference. Known pre-existing failures on this machine, verified identical on master: full-repo oxlint (285 errors on the touched paths; type-aware rules mis-resolving locally), duplication (13 clones; master 14), `verify-package-readme-summaries` (ui-chat/ui-conversation), doc-standard (prism-backup README.zh), `verify-repository-references` (uv.lock pin).

**Journey log** — The account-login e2e initially found no Sign in button: the web scaffold disables `llm-deepseek` in keyless replays unless `deepSeekMissingCredential: true` (the flag that also masks ambient keys), and the masked key then triggered the first-run credential dialog over the workspace, so the fixture also sets `credentialOnboarding: false`. A tsgolint panic (`slice bounds out of range`) on `src/client/index.ts` was root-caused to a marker-insertion script that wrote `PRISM-DIVERGENCE:` without the `//` comment prefix — a labeled-statement syntax mess — not a tool bug; the same slip would have broken the CSS build, so marker-adding scripts must assert the comment syntax they write.

## [S1] Problem

The signed-out bottom-left launcher shows 更多, a menu that hides 设置, 意见反馈, and 登录 behind one click. The three destinations do not belong together: settings is the primary entry, sign-in belongs where the account is used (the DeepSeek model card on the Models page), and feedback belongs with the other preferences in General settings.

## [S2] Design

**S2.1 — The signed-out launcher is the plain 设置 button.** `AccountMenu` renders a gear-icon button labeled 设置 that opens the settings dialog directly through the existing `openSettings`; collapsed sidebar geometry shows the icon alone. The signed-in launcher keeps the avatar menu, which now lists exactly 设置 and 退出登录. The signed-out menu and its width class are removed; the `more` dictionary key stays for the Account settings balance row.

**S2.2 — Sign-in lives on the DeepSeek model card.** The account package registers the Models page's `settings.models.provider-card` slot under the key `llm-deepseek` and contributes a 登录 action shown while signed out. Clicking it starts the shared sign-in flow (`start()`), whose dialog the launcher already hosts; a stored credential removes the button, and the signed-in DeepSeek 账号 row reports 已登录 as before. No `ui-settings-models` source changes: the slot is consumed as declared.

**S2.3 — Feedback is the last General row.** The account package registers `settings.general.item` with id `feedback` at order 110, after the version row (100). The row renders 意见反馈 with an external-link glyph and opens the configured GitHub issues URL in a new tab; the reused label key is named `feedback`.

**S2.4 — The issues URL is a validated bootstrap field.** `ContactConfig` gains `issuesUrl` (HTTPS pattern) defaulting to `https://github.com/laochenfei233/prism-agent/issues`, injected into the row through the package's existing `__DSH_CONTACT_CONFIG__` bootstrap, so a deployment can repoint it.

**S2.5 — The replaced questionnaire path is deleted.** With the menu item gone, the Feishu questionnaire is unreachable: the `contactUs` operation, `contact-url.ts`, its test, and the `contactFormUrl`/`contactSource` fields are removed; `bonusAckRetryDelayMs`/`bonusAckRetryMaxDelayMs` stay. Unreachable code would fail the per-file coverage gate.

**S2.6 — Fork bookkeeping.** Every divergent site carries `PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2), area A13.`, and the index gains the A13 area. Both affected package READMEs update in both languages.

## [S3] Scope

- In scope: the launcher reshape, the DeepSeek-card sign-in registration, the General feedback row, the `ContactConfig` field change, the questionnaire deletion, and their tests, snapshots, READMEs, and divergence index entry.
- Out of scope: the signed-in avatar-menu visual design, relocating sign-out, the desktop onboarding flow, and any `ui-settings-models` behavior change.

## Tasks

- [x] T1: Signed-out launcher renders the 设置 button; menu keeps only 设置/退出登录 (depends: none)
- [x] T2: Register the DeepSeek-card sign-in action (`settings.models.provider-card`, key `llm-deepseek`) (depends: none)
- [x] T3: Register the General feedback row (order 110) opening `ContactConfig.issuesUrl` (depends: none)
- [x] T4: Delete the questionnaire path and its fields; clean the package tests (depends: T1, T3)
- [x] T5: Update expected snapshots, the onboarding-native e2e and its goldens (depends: T1-T3)
- [x] T6: Update READMEs, add divergence markers and the index area (depends: T1-T4)

## [S4] Acceptance

- [x] Signed out, the bottom-left launcher is one 设置 button whose activation opens the settings dialog; no menu renders.
- [x] Signed in, the bottom-left menu lists exactly 设置 and 退出登录.
- [x] Signed out, the Models page's DeepSeek card offers 登录; activating it opens the sign-in dialog, and a stored credential removes the button.
- [x] General settings ends with the 意见反馈 row, which opens `https://github.com/laochenfei233/prism-agent/issues` in a new tab and follows an overridden `issuesUrl`.
- [x] `rg -n "contactFormUrl|contactSource|contactUs|contactUrl"` reports no source remnants, and the package's focused tests pass.
- [x] The bilingual spec pair and both README pairs pass the pairing gate; the divergence index names the new area.
