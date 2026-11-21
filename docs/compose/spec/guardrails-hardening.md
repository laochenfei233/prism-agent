---
feature: guardrails-hardening
status: delivered
updated: 2026-11-01
branch: feat/guardrails-hardening
commits: c22ec9f0b9..4c3d69444f
---

# Guardrails Hardening

English | [中文](guardrails-hardening.zh.md)

## Report

**What was built** — Three additions to `prism-guardrails`. A sensitive-read rail refuses a read whose path names a configured credential segment (`.env`, `.ssh`, `.aws`, `.gnupg`, `.npmrc`, `id_rsa`, `id_ed25519`), naming the path, the matched segment, and the alternative; it refuses rather than asks because the content would land in the session log permanently. A command guard sends a shell command matching a configured regular expression to approval, with the pattern and the deployment's reason; it asks rather than refuses because deleting a build directory is sometimes the intended action. `/guardrails` reports all twelve rails with their configured values, registered through `ctx.inject(['commands'])` so it also appears when the command runtime mounts after the bundle.

**Verification** — `npx vitest run tests/prism-guardrails.spec.ts tests/ponytail.spec.ts` PASS 141 (123 + 18); `npm run typecheck` PASS; `npm run build` PASS; `npm run smoke` PASS; `npx vitest run tests/capability.e2e.spec.ts` PASS 4/4 against the real headless profile.

**Journey log** — The review caught a shipped `credentials` segment that, because matching runs per path segment, refused this repository's own `packages/credentials/***` and `docs/subsystems/credentials.md`; `.aws` already covered the intended file, so the segment was dropped and a regression test pins both paths readable. The same review found the status command reading `ctx.get('commands')` once at apply time, which loses it whenever the command runtime mounts later; `ctx.inject` replaces it and a late-mount test pins the order. Separately, the worktree's e2e failed with zero session events for two rounds before the cause was found: `tsc -b` emits declarations only, and the profile needs the `tsdown` host bundles from `pnpm run build:lib:host`.

## [S1] Problem

`prism-guardrails` decides every rail from a tool's name, its argument fields, and the session log. Nothing reads a shell command's text, and nothing guards a read. Two consequences:

- `git push --force`, `git reset --hard`, and `rm -rf` run unguarded. The DSH sandbox cannot cover them: `SandboxMode` governs file effects, and network and process policy are outside its vocabulary (`packages/sandbox/sandbox-policy/README.md:147`). `bash` and `pwsh` are deliberately absent from the plan-mode rail for the same reason (`plugins/prism-guardrails/README.md:121`).
- `read`, `read_image`, and `grep` are listed as read-only tools by the routing contract, so `~/.ssh/id_rsa`, `.env`, and `~/.aws/credentials` are readable by any call. A read lands in the session log permanently, so the exposure outlives the turn.

A third gap is operational: every rail is off until its key names a value, and nothing reports which rails a running deployment actually has armed. An operator cannot tell a hardened session from an unconfigured one.

Prior art: `cc-safety-net` (kenryu42) ships exactly the first two checks, plus a GUI and a self-check. Its shell parsing is out of scope here — this bundle ships a raw-text denylist and records the ceiling.

## [S2] Design

### S2.1 Sensitive-read denial

Two keys, symmetric with the existing `writeTools` shape:

```ts ignore-check
readonly readTools?: readonly ReadTool[]        // { tool, pathArgument }
readonly sensitivePaths?: readonly string[]
```

A call to a configured read tool whose path argument names a path containing a configured segment is refused. A segment matches when it equals a configured name, ignoring case, or begins with that name followed by `.`, so `.env.local` matches `.env` while `environment.ts` does not.

The shipped defaults name `read` (`file_path`), `read_image` (`file_path`), and `grep` (`path`) — the three DeepSeek Harness tools that read by path. `credentials` is deliberately absent from the segment list: matching runs per path segment, so it would also refuse this repository's own `packages/credentials/…` and `docs/subsystems/credentials.md`, and `.aws` already covers the file it was meant for.

The decision is `deny`, not `ask`. Reading a credential writes it into the session log, which no later approval undoes, and the useful alternative never needs the file's contents. The refusal names the path, the matched segment, and the alternative:

```
Error: `read` targets "/home/u/.ssh/id_rsa", which this deployment treats as credential material (matched ".ssh"); reading it would write the secret into the session log permanently. Ask the user for the specific value if it is needed.
```

### S2.2 Dangerous-command denial

One key holding both halves:

```ts ignore-check
readonly commandGuard?: {
  readonly tools: readonly { tool: string; commandArgument: string }[]
  readonly deny: readonly { pattern: string; reason: string }[]
}
```

Each pattern is a regular expression compiled at load, matched case-insensitively against the raw command text. A match returns `ask`, not `deny`: deleting a build directory or force-pushing a personal branch is sometimes exactly the intended action, and only a human can tell that from the accident. With no approval channel the registry's fail-closed ladder refuses the call, which is the intended unattended outcome — the same reasoning as the repeat rail.

The approval reason names the matched pattern and the configured reason:

```
`bash` would run a command this deployment guards (matches `git\s+push\b[^\n]*(\s--force\b|\s-f\b)`): rewrites a remote branch history others may already have; approve only if the rewrite is intended
```

`shortcut:` raw-text denylist, not a shell parser: `bash -c "git push --force"` still matches because the text is present, but quoting or variable tricks can evade it. Upgrade to a parser when a consumer needs wrapper-proof matching.

### S2.3 Status command

`/guardrails` prints which rails the running deployment has armed, from the resolved configuration:

```
Guardrails: 4 of 12 rails armed.
plan-mode denial: write, edit, str_replace_editor
...
command guard: 2 tool(s), 3 pattern(s)
```

Registered through `ctx.inject(['commands'])`, so the report also appears when the command runtime mounts after this bundle; a deployment with no `commands` service keeps every rail and loses only the report.

### S2.4 Configuration validation

Every new key follows the package's existing rule: present but unusable fails plugin load, omission disables the rail, and the message names the key. The cross-field rule matches the existing one — a rail that reads a path owns no tool knowledge, so naming `sensitivePaths` without `readTools` fails at load.

### S2.5 Documentation

`README.md` and `README.zh.md` stay a pair: the rail count, the configuration table, the load-time rejection table, one section per new rail, and the known limitations (`rm -rf` inside the workspace is a legitimate action that now costs an approval; raw-text patterns are evadable; segment matching also refuses `id_rsa.pub`).

## [S3] Scope

- In scope: `plugins/prism-guardrails` — `src/config.ts`, `src/index.ts`, the tests, both READMEs, `cordis.patch.yml`.
- Out of scope: a shell parser, rule packs, a GUI, presets, cross-host packaging, and any change to `packages/`.

## Tasks

- [x] T1: `config.ts` — `readTools`, `sensitivePaths`, and `commandGuard` fields, resolution, and load-time rejections (depends: none)
- [x] T2: `index.ts` — sensitive-read rail (depends: T1)
- [x] T3: `index.ts` — command-guard rail (depends: T1)
- [x] T4: `index.ts` — `/guardrails` status command (depends: T1)
- [x] T5: tests — configuration validation, both rails end to end, and the status text (depends: T2, T3, T4)
- [x] T6: documentation and shipped defaults — both READMEs and `cordis.patch.yml` (depends: T5)
- [x] T7: verify — typecheck, unit suites, build, smoke (depends: T6)

## [S4] Acceptance

- [x] Reading `.env`, `~/.ssh/id_rsa`, or `~/.aws/credentials` through a configured read tool is refused with the matched segment named, and the tool never runs.
- [x] Reading `environment.ts`, `src/index.ts`, or a path with no configured segment is unaffected.
- [x] A `bash` call whose text matches a configured pattern returns `ask` with the pattern and reason; a non-matching command runs.
- [x] An unparsable `commandGuard.deny` pattern, an empty `sensitivePaths`, and `sensitivePaths` without `readTools` each fail plugin load with a message naming the key.
- [x] `/guardrails` reports every rail's state, and a deployment with no `commands` service still loads and enforces.
- [x] `npm run typecheck`, both unit suites, `npm run build`, and `npm run smoke` pass.
