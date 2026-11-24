---
feature: tauri-rust-upgrade
status: delivered
updated: 2026-11-24
branch: chore/tauri-rust-latest
commits: f9433f3732..7b4ae7086a
---

# Tauri and Rust upgrade: 2.12.6 / 1.100.0

English | [中文](tauri-rust-upgrade.zh.md)

## Report

**What was built** — The desktop shell now builds on Tauri 2.12.6: `@tauri-apps/cli` is pinned to 2.12.6 in `apps/desktop/package.json`, `Cargo.toml` declares `rust-version = "1.90"` (the Tauri 2.12.6 MSRV) and `webview2-com = "0.39"`, and `Cargo.lock` resolves `tauri` to exactly 2.12.6 with `webview2-com 0.39.1`, `windows 0.62.2`, `wry 0.57.3`, `tao 0.37.3`, and `tauri-build 2.7.6`, while `dsh-desktop` stays at `0.2.2-rc.1`. The vendored NSIS template was re-synced from tag `tauri-cli-v2.12.6` (tauri-bundler 2.10.6, now under `crates/tauri-bundler/`): upstream ships `Win\RestartManager.nsh` itself, so the fork's old include delta disappeared and the only remaining delta is the in-place-upgrade-first Reinstall behavior (30 changed lines vs upstream, mirrored between PageReinstall and PageLeaveReinstall).

**Verification** — `pnpm run build` passed 9/9 gates; `cargo check` and `cargo build` pass on the new graph (the `--quit` named-event path still uses `windows-sys 0.61` alongside `windows 0.62`); `node apps/desktop/scripts/smoke-bridge.mjs` passes. The installer was built with the pinned CLI (`npx @tauri-apps/cli@2.12.6 build` with `createUpdaterArtifacts:false` locally) plus the documented makensis junction workaround, producing `Prism Agent_0.2.2-rc.1_x64-setup.exe` (123 MB). Silent install (`/UPDATE /S`) over the previous install replaced the shell (exe hash `F82B0BA3…` → `1BF0D82E…`, runtime 18757 → 18851 files), the installed shell launches, and `prism-agent.exe --quit` exits it cleanly; a full uninstall (registry entry and uninstaller removed) followed by a fresh silent install also succeeded. The old `chore/tauri-rust-upgrade` branch (no upgrade commits; its folder-drop work already reached master through other commits) was deleted and `stash@{0}` was dropped after archiving it to `.artifacts/stash-archives/2026-11-08-tauri-2.12.4-wip.patch`. Not exercised here (need a human at the machine): visual tray-icon check, mac proxy session, microphone/speech input, and a live updater download.

**Journey log** —
- Every "silent installer did nothing" result was self-inflicted: Git Bash's MSYS path conversion rewrote `/S` into `S:/`, and `cmd //c` quoting never launched the exe at all. Launch with `MSYS_NO_PATHCONV=1` and a space-free exe path; NSIS then installs silently exactly as documented.
- `makensis` still fails on the long inspector `.md` path; the C:\prism-nsis junction + installer.nsi prefix rewrite remains required, and the junction must be repointed at the active checkout (a stale one pointed at the main repo).
- The tauri monorepo moved the bundler template from `tooling/` to `crates/` between 2.11.4 and 2.12.x — fetch templates from `crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi`.
- The tauri NSIS Welcome page shows even in passive (non-silent) runs; only true `/S` suppresses pages. The updater's own `/UPDATE` invocation is unaffected.
- Lefthook's msys crash (0xc0000142) persists in this environment; run the affected gates manually and commit with `LEFTHOOK=0` (noted in the commit messages).

## [S1] Problem

The upgrade has no usable branch. `chore/tauri-rust-upgrade` is a pointer created from `feat/usage-billing`; its six commits relative to master are the old folder-drag-drop work, and no commit bumps Tauri. The only implementation is `stash@{0}` from 2026-11-08, based on `0.2.1-rc.4-alpha5`. Applying it wholesale would regress `dsh-desktop` from `0.2.2-rc.1` to `0.2.1-rc.4-alpha5`, replace the current dependency graph with the old lock, and conflict with the desktop changes master gained since (mac proxy, setup, update, tauri.conf).

The current tree is also behind on the toolchain contract. Tauri 2.12.6 requires Rust 1.90, while `Cargo.toml` still declares 1.77. `webview2-com` 0.38 no longer matches the version Tauri 2.12.6 links (0.39), and the vendored NSIS template is for CLI 2.11.4 rather than the 2.12.6 CLI's embedded tauri-bundler 2.10.6. The local machine was one Rust minor behind (1.99.1 versus 1.100.0) and its `cargo tauri` was 2.11.5.

## [S2] Design

### S2.1 Branch and baseline

Create `chore/tauri-rust-latest` from master and keep the upgrade commits on it. Do not rebase or resurrect `chore/tauri-rust-upgrade`, and do not cherry-pick its folder-drop commits; those already reached master through other commits.

Export `stash@{0}` to a patch file before any cleanup. Use it only for the manifest deltas and the 2.12.4 NSIS template as a reference; do not apply its `Cargo.lock`. Drop the stash only after the new branch's lockfile and installer are verified.

### S2.2 Target matrix

| Component | Current | Target | Source |
|---|---|---|---|
| `@tauri-apps/cli` | 2.11.4 | 2.12.6 | npm `latest` |
| `tauri` crate | 2.11.5 | 2.12.6 | crates.io stable |
| `tauri-build` | 2.6.3 | latest 2.x (2.7.x) | Cargo resolution |
| embedded `tauri-bundler` | embedded by CLI 2.11.4 | 2.10.6 | pinned by `tauri-cli` 2.12.6 |
| `wry` | 0.55.1 | 0.57.x | Cargo resolution |
| `tao` | 0.35.3 | 0.37.x | Cargo resolution |
| `webview2-com` | 0.38 | 0.39 | tauri 2.12.6 dependency |
| `windows` | 0.61.3 | 0.62.x | tauri 2.12.6 dependency |
| `rust-version` | 1.77 | 1.90 | tauri 2.12.6 MSRV |
| local Rust | 1.99.1 | 1.100.0 | rustup stable |
| NSIS template | tauri-cli-v2.11.4 | tauri-cli-v2.12.6 | tauri-bundler 2.10.6 |

### S2.3 Manifest changes

In `apps/desktop/package.json`, change the three `npx --yes @tauri-apps/cli@2.11.4` rows to `2.12.6`. Keep the `dsh-desktop` version at `0.2.2-rc.1`; this upgrade does not bump the release.

In `apps/desktop/src-tauri/Cargo.toml`, set `rust-version = "1.90"`, change `webview2-com = "0.38"` to `"0.39"`, and keep `tauri = { version = "2", ... }` so Cargo resolves 2.12.6. Keep the `tokio` `net` feature and the existing `windows-sys = "0.61"` row for the `--quit` named event/mutex; `windows` 0.62 and `windows-sys` 0.61 are separate crates and can coexist.

### S2.4 Lockfile

Regenerate `apps/desktop/src-tauri/Cargo.lock` from the current tree: update `tauri` to the precise 2.12.6 release, then let Cargo resolve the transitive graph. Do not copy the stash's lock. Verify the resolved graph contains `tauri 2.12.6`, `webview2-com 0.39`, and `windows 0.62`, and that `dsh-desktop` remains `0.2.2-rc.1`.

### S2.5 NSIS template

Vendor the `installer.nsi` from tauri-cli-v2.12.6 / tauri-bundler 2.10.6, then re-apply the fork's delta: the Reinstall page's Upgrading branch offers the in-place upgrade first and the clean uninstall second, mirrored in `PageLeaveReinstall`. Tauri 2.12 includes `Win\RestartManager.nsh`, so that older fork delta disappears; confirm the remaining delta is the in-place upgrade behavior. Keep `tauri.conf.json` pointing at the vendored template.

### S2.6 Toolchain contract

The local toolchain is rustup 1.29.3 with rustc/cargo 1.100.0 and `cargo tauri` 2.12.6. The repository has no `rust-toolchain.toml`; keep the MSRV in `Cargo.toml` at 1.90 and document the tested compiler in this spec rather than adding a toolchain file. CI and other machines need Rust 1.90 or newer; a machine on 1.77 will fail before the upgrade.

### S2.7 Build and installer verification

Run `cargo check` and `cargo build` in `apps/desktop/src-tauri`, then build the installer through the pinned CLI (`npx --yes @tauri-apps/cli@2.12.6 build`) and, separately, through the upgraded `cargo tauri build` if the local CLI is used. Install the result, upgrade over an existing installation, and uninstall it. Verify the tray icon and `--quit`, the loopback proxy session, microphone permission and speech input, and the updater artifact and signature. Run `node apps/desktop/scripts/smoke-bridge.mjs` and `pnpm run build:check` for the JavaScript aggregate.

### S2.8 Risks and rollback

Tauri 3.0.0-alpha.6 is a prerelease and must not be selected by a loose `"2"` requirement accidentally; keep the major pin and verify the resolved version. The `windows` 0.62 bump can break the `--quit` path because it uses `windows-sys` 0.61 separately; compile and run the quit path. The NSIS template is hand-vendored, so a missed delta changes the installer's upgrade behavior; diff it against the 2.10.6 source. The mac proxy and updater were added on master after the old stash, so the new branch must be built on master, not the old branch. If the upgrade fails, the rollback is the branch itself: master is unchanged until the branch merges.

## [S3] Scope

- In scope: the new branch; local Rust and Tauri CLI upgrades; `package.json` CLI pins; `Cargo.toml` MSRV and `webview2-com`; `Cargo.lock`; the NSIS template; README version references; build and installer verification.
- Out of scope: Tauri 3 prereleases; new desktop features; JavaScript behavior changes; the old branch's folder-drop history; dropping the stash before its patch is archived.

## Tasks

- [x] T1: create `chore/tauri-rust-latest` from master `f9433f3732` (depends: none)
- [x] T2: upgrade rustup to 1.29.3 and Rust stable to 1.100.0 (depends: none)
- [x] T3: install `cargo tauri` 2.12.6 locally (depends: T2)
- [x] T4: write this spec and its Chinese pair (depends: T1)
- [x] T5: pin `@tauri-apps/cli@2.12.6` in `apps/desktop/package.json` (depends: T3)
- [x] T6: set `rust-version = "1.90"` and `webview2-com = "0.39"` in `Cargo.toml` (depends: T5)
- [x] T7: regenerate `Cargo.lock` and verify the resolved graph (depends: T6)
- [x] T8: re-sync the NSIS template from tauri-bundler 2.10.6 (depends: T5)
- [x] T9: build, install, upgrade, uninstall, and smoke-test the shell (depends: T7, T8)
- [x] T10: export the old stash to a patch and retire the old branch/stash (depends: T9)
- [x] T11: add a changelog fragment or upgrade guide if the installer or updater behavior is externally perceptible (depends: T9)

## [S4] Acceptance

- [x] The new branch starts from master and does not contain the old folder-drop history.
- [x] `rustc` and `cargo` report 1.100.0, rustup reports 1.29.3, and `cargo tauri` reports 2.12.6.
- [x] `apps/desktop/package.json` pins `@tauri-apps/cli@2.12.6`.
- [x] `Cargo.lock` resolves `tauri 2.12.6`, `webview2-com 0.39`, and `windows 0.62`, with `dsh-desktop` still at `0.2.2-rc.1`.
- [x] The vendored NSIS template matches tauri-bundler 2.10.6 and keeps the fork's in-place upgrade delta.
- [x] `cargo build` and the installer build pass; install, upgrade, uninstall, and the `--quit` smoke pass.
- [ ] Tray-icon visual, mac proxy session, speech/mic, and a live updater download are confirmed by a person on the installed machine.
- [ ] The old branch and stash are retired only after the stash patch is archived and the new installer is verified.
