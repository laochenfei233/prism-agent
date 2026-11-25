---
feature: prism-autonomy
status: designed
updated: 2026-11-23
branch: feat/prism-autonomy
commits: 26b7c472a5..HEAD # filled at delivery
---

# Autonomous Approval Presets

English | [中文](prism-autonomy.zh.md)

## Report

## [S1] Problem

Under the default `workspace-write` preset, every approval-raising action interrupts the user: the guardrails rails (repeated calls, the turn write budget, dependency-manifest writes) and sandbox escalations all land on the approval card. The only shipped way to run unattended is `danger-full-access`, which also removes sandbox confinement and never asks. There is no middle ground that keeps the sandbox and the red lines while auto-answering routine approvals.

## [S2] Design

### S2.1 The autonomous-guarded preset

One preset joins the base bundle's permission-presets table: `autonomous-guarded`, `workspace-write` + `ask`. Under it every approval ask is auto-answered except a configurable require-human list (default: sandbox escalations). Autonomy requires the `ask` policy — under `never` the approval service rejects before any answerer runs.

### S2.2 The plugin and the preset mapping

A new plugin `@prism/prism-autonomy` (`plugins/prism-autonomy`), composed by a bundle patch row like the other prism plugins. Its config:

```ts
// The plugin's config and its defaults.
interface AutonomyConfig {
  preset: 'autonomous-guarded' // the preset that engages autonomy
  requireHuman: { reasonPrefix: string }[] // the require-human list
}
```

The session's current preset is read from a session projection `autonomy` that folds the durable `permission/preset` events, so the derived state survives reload and restart (replay-safe). Any other preset means off. Misconfiguration fails loud at load: `preset` must exist in the permission-presets catalog.

### S2.3 The approval answerer

The plugin registers one answerer ahead of the remote client bridge (prepend on the `approval/request` waterfall):

- the session's current preset is not `preset` → delegate (`next()`); behavior unchanged.
- the request matches a require-human matcher (`toolName` and/or the human-readable `reason` prefix) → delegate.
- otherwise → `allowed-once`.

Deny rails are untouched (they never produce asks). The approval audit pair (`approval/asked` + `approval/decided`) still logs every auto-answer; the client approval card never appears for an auto-answered request because the remote bridge listener sits downstream.

### S2.4 Model notice on live changes

When the session's preset switches to or from the autonomous preset on a live session, the plugin injects one user message (source `prism-autonomy`) telling the model that approvals are now auto-granted except the guarded list — or that they are back to manual. Model-visible ⟺ logged: the notice is a logged user message. Replay does not re-inject.

### S2.5 Limits

- ACP-owned sessions are unaffected unless someone explicitly switches them to the autonomous preset (the default is off).
- The auto-answer is per request; the audit pair shows `allowed-once` exactly like a human allow. v1 adds no separate autonomy event type.
- No client UI in v1: switching happens through the existing `/permission` command and the Settings permission picker.

### S2.6 Tests

- Plugin unit tests: state derivation (off/guarded), the answerer ladder, prepend ordering, require-human matchers, fail-loud preset validation, the live-change notice, and replay safety.
- A recorded-session snapshot for the switch notice (a model-visible change).

## [S3] Scope

- In scope: the plugin package (source, tests, README pair, bundle patch row), the `autonomous-guarded` preset row in the base bundle patch, and the switch-notice snapshot.
- Out of scope: client UI, permission-presets core changes, new session event types, subagent/delegation propagation, and additional tiers (edit/yolo).

## Tasks

- [ ] T1: Plugin skeleton — package, tsconfig, config schema, session projection, fail-loud validation (depends: none)
- [ ] T2: The approval answerer (depends: T1)
- [ ] T3: The live-change model notice (depends: T1)
- [ ] T4: The `autonomous-guarded` preset row in the base bundle patch + the plugin's bundle patch row (depends: T1)
- [ ] T5: Unit tests + recorded-session snapshot (depends: T2, T3)
- [ ] T6: README pair + bilingual spec finalize (depends: T5)

## [S4] Acceptance

- [ ] An `autonomous-guarded` session auto-settles guardrails asks (write budget, repeated calls, dependency manifests) as `allowed-once`, and no approval card reaches the client.
- [ ] Sandbox-escalation asks still reach the human.
- [ ] Default sessions (any other preset) behave exactly as before.
- [ ] Deny rails (e.g. the `rm -rf` command guard) still deny.
- [ ] Switching to or from the autonomous preset injects exactly one model notice, covered by the snapshot.
