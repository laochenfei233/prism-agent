---
feature: compose-next-mode
status: delivered
updated: 2026-11-25
branch: feat/prism-team
commits: 50ff54bd96..c4bd1a25a3
---

# Compose Next As A Mode

English | [中文](compose-next-mode.zh.md)

## Report

**What was built** — `plugins/prism-guardrails/src/compose.ts`: a mode entry structured like `ponytail.ts`. Levels `off | lite | full` (`lite` five phases, `full` nine), one system-prompt section resolved per session, one `/compose-next off|lite|full|auto` command, and an automatic rule that enters `lite` by cumulative steps (`autoLongTaskSteps` defaults to 20, `0` disables). The bundle patch gained a `prism-guardrails-compose` row, `package.json` a `./compose` export, and `tsdown` an entry. The default is `level: off`; long tasks enter through the automatic rule.

**Verification** — `tsc -p tsconfig.verify.json --noEmit` exit 0; `vitest`'s `compose.spec.ts` 9/9 pass, with the existing `ponytail.spec.ts` 18/18 and `prism-guardrails.spec.ts` 144/144 all green (171 total, the regression gate); `tsdown` produces `lib/compose.js` 9.51 kB; `oxlint` (staged) 0 warnings 0 errors.

**Journey log** —

- The spec draft made compose "a latch for team members pointing at the skill itself"; the user asked to turn the skill itself into a plugin capability, so it became the carrier of the phase text (the same way ponytail carries its rules), provided by `prism-guardrails` to every profile.
- The automatic entry conflicts with the skill's own "enter only on an explicit request" rule; per the user's request it defaults on, and the conflict and its opt-out are written in the README rather than silently changing the rule.

## [S1] Problem

`compose-next` is a skill: nine phases (Orient → Grill → Spec → Workspace → Implement → Verify → Review → Finalize → Finish), and its own first sentence says "enter only on an explicit user request; never infer it from how large a task looks".

The result is two concrete problems:

- A long task 30 steps in has no workflow constraint and nothing pulling it back; `ponytail` already switches levels automatically per session, and `compose-next` has no counterpart.
- The two mode capabilities have inconsistent homes: ponytail is a plugin (`prism-guardrails/src/ponytail.ts`, bundle-mounted into every profile), compose-next only a skill. The same user needs two different mechanisms.

The goal is to make compose-next a plugin capability like ponytail: one system-prompt section + one slash command + one automatic rule, entered automatically on long tasks.

## [S2] Design

### S2.1 Home: `prism-guardrails/src/compose.ts`

Structured like `ponytail.ts`: `level` (`off | lite | full`), `autoLongTaskSteps`, one section resolved per session, one `/compose-next` command. The bundle patch gains one more row, `prism-guardrails-compose`.

No second mode plugin: `ponytail` already proved the skill-to-plugin home is `prism-guardrails`; the same thing should not have two homes.

### S2.2 Levels and the section

`off` outputs no section. `lite` is the five phases (Orient → Spec → Implement → Verify → Review); `full` is the nine (adding Grill, Workspace, Finalize, Finish, and each step's gate). The section body is the phases' **contract**, not the skill's full text: the wording keeps `prism-guardrails`' style, using imperatives that state what each step does and which steps may not be skipped.

The section shares ponytail's stopping constraints: stop only for "a genuinely open product decision, a blocker that cannot be worked around, a destructive action requiring consent", and never otherwise; two failures of the same approach mean changing strategy; never describe a skipped phase as "already done".

### S2.3 The automatic rule and its price

`autoLongTaskSteps` defaults to `20` (matching ponytail), `0` disables. When a session's cumulative steps reach the threshold, the section switches to `lite`.

**This rule conflicts with the skill's own entry rule**: the skill says never to infer from a task's size, and the automatic rule infers exactly that. The user explicitly asked for automatic entry on long tasks, so it defaults on — but the price must be stated in the README: once on, a long task starts producing a spec document nobody asked for. To return to the skill's rule, set `autoLongTaskSteps` to `0`.

`/compose-next off|auto|lite|full` overrides the automatic rule; `auto` drops the explicit choice and returns to the rule.

### S2.4 State

Per session, a `WeakMap<Agent, ComposeLevel>` (the explicit choice) and a `WeakMap<Agent, number>` (the step count). A session running a long task does not affect neighboring sessions, matching ponytail's state model.

### S2.5 Configuration

```yaml
- id: prism-guardrails-compose
  name: 'prism-guardrails/compose'
  config:
    level: off            # default off; long tasks enter via the automatic rule
    autoLongTaskSteps: 20 # 0 = disable the automatic rule
```

Both keys are validated at load; an illegal value throws immediately and names the key.

## [S3] Scope

- In scope: `src/compose.ts`, one `cordis.patch.yml` row, the `./compose` export in `package.json`, the `tsdown.config.ts` entry, `tests/compose.spec.ts`, and the compose section of the `prism-guardrails` README.
- Out of scope: changing `prism-guardrails`' twelve rails; writing compose state into the session log; a Web UI; mode routing for the team plugin (a separate concern beyond `prism-team`).

## Tasks

- [x] T1: `src/compose.ts` (levels, the automatic rule, the section, the command) (depends: none)
- [x] T2: Loading (the `cordis.patch.yml` row, the `package.json` export, the `tsdown` entry) (depends: T1)
- [x] T3: `tests/compose.spec.ts` (depends: T1)
- [x] T4: The README's compose section and the conflict statement (depends: T2)

## [S4] Acceptance

- [x] A1 With the default configuration (`level: off`, threshold not reached) the section is empty.
- [x] A2 The `level: lite` section contains the five phases and not Grill; `level: full` contains the nine phases and Finish.
- [x] A3 With `autoLongTaskSteps: 3`, step 2 does not switch and step 3 switches to `lite`; set to `0`, it never switches.
- [x] A4 `/compose-next full` rewrites the section immediately, `off` empties it, `auto` returns to the automatic rule.
- [x] A5 An illegal `level` and an illegal step count throw at load with the key named in the message.
- [x] A6 `prism-guardrails`' existing ponytail and rail cases stay green (the regression gate).
