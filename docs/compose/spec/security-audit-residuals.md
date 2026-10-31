---
feature: security-audit-residuals
status: delivered
updated: 2026-10-31
branch: fix/security-audit-residuals
commits: 609ccc3887..fa45014585
---

# Security Audit Residuals

English | [中文](security-audit-residuals.zh.md)

## Report

**What was built** — Shell confinement now excludes the harness home from every writable profile that would otherwise reach it: Seatbelt appends a denying subpath rule, bwrap rebinds the home read-only after the workspace bind, Landlock refuses the policy with `SANDBOX_UNAVAILABLE`, and the Windows ACL grant adds a standing Deny ACE for the workspace capability SID. Imported attachment members are republished `0400` after the copy, and the release workflow leaves `latest.json` to `tauri-action` while still uploading `.sig` and `.app.tar.gz`.

**Verification** — `packages/sandbox/sandbox-windows-acl/tests/acl.spec.ts`: 13 passed, including the new deny test. `engine.spec.ts`: 13 passed, including the copied-mode assertion. A direct behavior check of the three profile builders (a workspace containing `$DSH_HOME`, and a home outside every writable root) passed; the package's own specs are excluded on Windows by `vitest.config.ts` and run on the POSIX lanes. `pnpm run typecheck`: 5/5 gates. Translation pairs, `verify-md-links`, and `verify-concrete-terms`: pass. The coverage lane could not run in this checkout (`ast-v8-to-istanbul` TypeError while remapping), though the tests themselves ran. `pnpm run doc-sync` still fails on baseline artifacts unrelated to this change (custom-theme-presets wrap, stale generated catalogs, ui-chat/ui-conversation summaries, removed hooks package paths), and `verify-package-dependencies` fails only on `prism-transfer` imports; this change adds no new failure.

**Journey log** — Landlock's allow-list forced a fail-closed branch rather than a deny rule, which is the one behavior difference between the POSIX profiles. The sandbox-local spec lane is Windows-excluded, so local verification used the profile builders directly and left the spec run to the POSIX lanes. The home exclusion is gated on the home lying inside a granted root, which keeps every existing profile byte-identical outside that overlap. The ACL deny reuses the existing standing grant instead of adding a second grant lifecycle.

## [S1] Problem

`security-audit-fixes` closed the six audit leads and recorded four residuals. Three of them are fixable in the same surfaces: the shell sandbox backends still derive writable roots from the workspace alone, so a workspace that contains `$DSH_HOME` grants it to sandboxed commands even though the tool filesystem fence refuses it; imported attachment members rely on the source store's publication mode instead of being republished read-only; and the release workflow uploads a `latest.json` glob that the Tauri CLI never writes, because `tauri-action` owns that manifest. The fourth, an imported-content marker, needs a session-format and product decision and stays deferred.

## [S2] Design

### [S2.1] Harness-home exclusion in every shell profile

The exclusion applies only when the harness home lies inside a root the `workspace-write` policy would otherwise grant; outside that overlap the ordinary read-only bind or deny already covers it. The home comes from `resolveDshHome()` (`$DSH_HOME`, then `~/.prism`), the same source the shipped composition resolves.

- Seatbelt appends an inheritable `(deny file-write* (subpath "<home>"))` after the allows; Seatbelt evaluates deny rules before allow rules.
- bwrap appends `--ro-bind <home> <home>` after the workspace bind; a later mount wins over the earlier writable bind.
- Landlock is an allow-list and cannot exclude a subpath, so the launcher profile refuses the policy with `SandboxUnavailableError` and the command never runs unconfined.
- The Windows ACL rung adds a standing Deny ACE for the workspace capability SID on the home directory; Windows evaluates deny ACEs before inherited allows, so the home stays unreachable inside the granted workspace.

No core sandbox protocol, policy type, or updater runtime changes: each provider resolves the same home with its own dialect.

### [S2.2] Read-only publication of imported attachments

After the import copies the source home's `attachments/` tree, every copied regular file is republished with mode `0400`. `fs.cp` preserves the source mode and a DSH source store already publishes `0400`, but the copy is a foreign tree and its mode must not depend on how that tree was written.

### [S2.3] Updater manifest ownership

The release workflow uploads `.sig` and `.app.tar.gz` artifacts, which `tauri build` produces with `createUpdaterArtifacts`. `latest.json` is generated and attached by `tauri-action`, not written under `target/`, so the artifact globs no longer claim it.

### [S2.4] Deferred: imported-content marker

The event vocabulary has no marker distinguishing imported history, and adding one changes persisted session data, the readers, the TypeScript and Python SDK projections, snapshots, and the way the UI and model attribute imported text. That is a product and session-format decision rather than a mechanical fix; it stays deferred.

## [S3] Scope

- In scope: the shell home exclusion (Seatbelt, bwrap, Landlock fail-closed, Windows ACL deny), read-only imported attachment members, and the release manifest ownership.
- Out of scope: the imported-content marker, any change to the DSH core sandbox protocol or policy type, and the desktop updater runtime.

## Tasks

- [x] T1: exclude the harness home in the Seatbelt, bwrap, and Landlock profiles (depends: none, covers: S2.1)
- [x] T2: deny the harness home on the Windows ACL workspace grant (depends: none, covers: S2.1)
- [x] T3: republish imported attachment members read-only (depends: none, covers: S2.2)
- [x] T4: leave `latest.json` to `tauri-action` (depends: none, covers: S2.3)
- [x] T5: run the affected tests, typecheck, coverage, and documentation gates (depends: T1, T2, T3, T4)

## [S4] Acceptance

- [x] A workspace-write policy whose workspace contains `$DSH_HOME` yields a Seatbelt deny line and a bwrap read-only rebind after the writable bind; a home outside the workspace leaves both profiles unchanged.
- [x] Landlock refuses that policy with `SandboxUnavailableError` instead of granting the home.
- [x] The Windows ACL workspace grant denies the capability SID on a nested harness home and does not deny an outside one.
- [x] Imported attachment members are mode `0400` after the copy.
- [x] The release workflow uploads `.sig` and `.app.tar.gz` and no longer uploads `latest.json` itself.
- [x] The affected package tests, typecheck, coverage, and documentation gates pass, or each failure is a recorded baseline failure with evidence.
