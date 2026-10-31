---
feature: settings-entry-regroup
status: in-progress
updated: 2026-10-31
branch: feat/settings-entry-regroup (worktree .worktrees/settings-entry-regroup)
commits: 421ebe5731..
---

# Settings Entry Regroup

English | [中文](settings-entry-regroup.zh.md)

## [S1] Problem

The signed-out bottom-left launcher shows 更多, a menu that hides 设置, 意见反馈, and 登录 behind one click. The three destinations do not belong together: settings is the primary entry, sign-in belongs where the account is used (the DeepSeek model card on the Models page), and feedback belongs with the other preferences in General settings.

## [S2] Design

**S2.1 — The signed-out launcher is the plain 设置 button.** `AccountMenu` renders a gear-icon button labeled 设置 that opens the settings dialog directly through the existing `openSettings`; collapsed sidebar geometry shows the icon alone. The signed-in launcher keeps the avatar menu, which now lists exactly 设置 and 退出登录. The unused signed-out menu, its width class, and the `more` dictionary key are removed.

**S2.2 — Sign-in lives on the DeepSeek model card.** The account package registers the Models page's `settings.models.provider-card` slot under the key `llm-deepseek` and contributes a 登录 action shown while signed out. Clicking it starts the shared sign-in flow (`start()`), whose dialog the launcher already hosts; a stored credential removes the button, and the signed-in DeepSeek 账号 row reports 已登录 as before. No `ui-settings-models` source changes: the slot is consumed as declared.

**S2.3 — Feedback is the last General row.** The account package registers `settings.general.item` with id `feedback` at order 110, after the version row (100). The row renders 意见反馈 with an external-link glyph and opens the configured GitHub issues URL in a new tab.

**S2.4 — The issues URL is a validated bootstrap field.** `ContactConfig` gains `issuesUrl` (HTTPS pattern) defaulting to `https://github.com/laochenfei233/prism-agent/issues`, injected into the row through the package's existing `__DSH_CONTACT_CONFIG__` bootstrap, so a deployment can repoint it.

**S2.5 — The replaced questionnaire path is deleted.** With the menu item gone, the Feishu questionnaire is unreachable: the `contactUs` operation, `contact-url.ts`, its test, and the `contactFormUrl`/`contactSource` fields are removed; `bonusAckRetryDelayMs`/`bonusAckRetryMaxDelayMs` stay. Unreachable code would fail the per-file coverage gate.

**S2.6 — Fork bookkeeping.** Every divergent site carries `PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).`, and the index gains an area for this regroup. Both affected package READMEs update in both languages.

## [S3] Scope

- In scope: the launcher reshape, the DeepSeek-card sign-in registration, the General feedback row, the `ContactConfig` field change, the questionnaire deletion, and their tests, snapshots, READMEs, and divergence index entry.
- Out of scope: the signed-in avatar-menu visual design, relocating sign-out, the desktop onboarding flow, and any `ui-settings-models` behavior change.

## Tasks

- [ ] T1: Signed-out launcher renders the 设置 button; menu keeps only 设置/退出登录 (depends: none)
- [ ] T2: Register the DeepSeek-card sign-in action (`settings.models.provider-card`, key `llm-deepseek`) (depends: none)
- [ ] T3: Register the General feedback row (order 110) opening `ContactConfig.issuesUrl` (depends: none)
- [ ] T4: Delete the questionnaire path and its fields; clean the package tests (depends: T1, T3)
- [ ] T5: Update expected snapshots, the onboarding-native e2e and its goldens (depends: T1-T3)
- [ ] T6: Update READMEs, add divergence markers and the index area (depends: T1-T4)

## [S4] Acceptance

- [ ] Signed out, the bottom-left launcher is one 设置 button whose activation opens the settings dialog; no menu renders.
- [ ] Signed in, the bottom-left menu lists exactly 设置 and 退出登录.
- [ ] Signed out, the Models page's DeepSeek card offers 登录; activating it opens the sign-in dialog, and a stored credential removes the button.
- [ ] General settings ends with the 意见反馈 row, which opens `https://github.com/laochenfei233/prism-agent/issues` in a new tab and follows an overridden `issuesUrl`.
- [ ] `rg -n "contactFormUrl|contactSource|contactUs|contactUrl"` reports no source remnants, and the package's focused tests pass.
- [ ] The bilingual spec pair and both README pairs pass the pairing gate; the divergence index names the new area.
