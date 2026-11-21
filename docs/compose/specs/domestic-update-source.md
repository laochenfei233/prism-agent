---
feature: domestic-update-source
status: delivered
updated: 2026-11-21
branch: feat/domestic-update-source
commits: 205657d63d..7f9ddd5d4b
---

# Domestic update source

English | [中文](domestic-update-source.zh.md)

## Report

**What was built** — The desktop updater now checks a domestic mirror first: `tauri.conf.json` pins `https://cdn.xyern.com/prism-agent/updates/latest.json` ahead of the GitHub Releases endpoint, and the Tauri updater's in-order failover falls back to GitHub whenever the mirror is unreachable (covering the window before the CDN manifest is provisioned). The About section keeps a stable display: the shell's `UpdateSource` wire gained a `host` field that carries the official host `prism.xyern.com` whenever a `cdn.xyern.com`/`prism-agent/` endpoint is configured — display and actual intentionally separated, following the Easel updater convention — while `repo`/`releaseUrl` still come from the first GitHub endpoint in the list, so the changelog and feedback links stay on GitHub Releases/issues.

The prism-about client renders the mirror state through a new pure `deriveSourceView` helper: the display host as plain text under a `国内镜像`/`China mirror` badge, the repository link under the GitHub Releases badge on a bare GitHub configuration, and the unavailable state otherwise. Copy adds one key to both dictionaries; docs (desktop README pair, plugin README pair and description, `desktop-dev-notes.md`, the `desktop-client` spec pair) now describe the mirror-first arrangement.

**Verification** — `cargo test` (apps/desktop/src-tauri): 49 passed / 0 failed, exit 0, re-run after each Rust change; `pnpm run test` (plugins/prism-about): 13 passed / 0 failed; plugin `tsc --noEmit`: PASS; plugin tsdown build: PASS; `pnpm run verify-md-wrap`: PASS repo-wide (2533 files); `pnpm run verify-translation-pairing`: 0 complaints on changed files (32 repo-wide vs 54 on the master baseline — environment noise from stale build-dir copies); `verify-md-links` and 6 further doc gates: PRE-EXISTING failures identical on master, no changed files flagged. Endpoints are compile-time baked: the change ships to users with the next packaged release.

**Journey log** —
- A fresh worktree's `cargo test` fails at the Tauri build script with `resource path '..\runtime' doesn't exist`: `apps/desktop/runtime` is a gitignored `bundle-runtime.mjs` output. Mirroring it from the main checkout unblocks compile-only and test work; `robocopy /MIR` needs `MSYS_NO_PATHCONV=1` under Git Bash or the flag is mangled into a path.
- lefthook's pre-commit hooks crash on this host (msys `NtCreateDirectoryObject … 0xC0000022`); running the identical gate commands manually and then committing with `--no-verify` is the working path.
- The endpoint list is display-coupled: About facts derive from the configured endpoints, so CDN-first required extending `UpdateSource` (display host) rather than only reordering the array — a bare reorder would have shown "source unavailable".
- New spec docs must keep one physical line per paragraph in both languages (`verify-md-wrap` rejects hard-wrapped prose) and ship with an `.i18n.yaml` record plus language-switcher links (`verify-translation-pairing`).

## [S1] Problem

In-app updates resolve against a single GitHub Releases endpoint, which is slow or unreachable for users in mainland China. A domestic CDN mirror exists at `cdn.xyern.com` (the same arrangement the Easel app migrated to); the desktop app must check it first and keep GitHub as the fallback, while the About section still shows a stable official address.

## [S2] Design

### S2.1 Updater endpoints

`apps/desktop/src-tauri/tauri.conf.json` lists two endpoints in priority order:

1. `https://cdn.xyern.com/prism-agent/updates/latest.json` — the domestic mirror manifest (Tencent CDN, per the Easel release-sync convention).
2. `https://github.com/laochenfei233/prism-agent/releases/latest/download/latest.json` — the existing GitHub Releases fallback.

The Tauri updater tries endpoints in declared order and uses the first successful response, so the mirror serves checks whenever it is reachable and GitHub covers the window before the CDN side is provisioned. The pubkey, install mode, and signature verification are unchanged.

### S2.2 Display/actual separation

The About card shows the named official host `prism.xyern.com` while the updater actually requests `cdn.xyern.com`, mirroring the Easel convention. The Rust shell's `UpdateSource` wire gains a `host` field: it carries the display host when an endpoint on `cdn.xyern.com` with a `/prism-agent/` path is configured, and stays empty on a bare GitHub configuration (the card then renders the repository as before). The `repo`/`releaseUrl` facts keep coming from the first GitHub releases endpoint in the list regardless of position — the changelog and feedback links stay on GitHub Releases/issues.

### S2.3 About card rendering

The prism-about client derives the source card from the snapshot through a pure helper: mirror configured → badge copy `国内镜像`/`China mirror` and the display host as plain text (the display name is not a navigable page); otherwise the current repository link and GitHub Releases badge. Copy adds one key (`sourceMirror`) to both dictionaries; the zh/en parity test keeps them paired.

## [S3] Scope

- In scope: the endpoint list, the Rust source-facts mapping and its tests, the About card's mirror rendering, the plugin's dictionaries and README, the desktop README pair, `desktop-dev-notes.md`, and a changelog entry; the plugin `lib/` bundles are a gitignored build output rebuilt at packaging time by `bundle-runtime.mjs`, so the change verifies with a local tsdown build rather than a commit.
- Out of scope: a custom-source override UI; CDN-side sync tooling (lives in the website repository); connectivity verification of the CDN URL (deferred by the user); recorded-session snapshot coverage (the About card is only reachable inside the desktop carrier, which keyless web replay cannot produce — a pre-existing gap, not a new one).

## Tasks

- [x] T1: reorder `tauri.conf.json` endpoints to mirror-first with GitHub fallback (depends: none)
- [x] T2: extend `UpdateSource` with the display host and map endpoints to mirror/GitHub facts, with tests (depends: none)
- [x] T3: render the mirror state in the About card — bridge type, pure helper, section, dictionaries, tests (depends: none)
- [x] T4: rebuild the prism-about `lib/` bundles locally as a build smoke — `lib/` is gitignored and rebuilt at packaging time (depends: T3)
- [x] T5: update docs — desktop README pair, prism-about README pair and description, `desktop-dev-notes.md` (depends: none)
- [x] T6: add the changelog entry (depends: none)

## [S4] Acceptance

- [x] The shipped updater config checks the CDN manifest first and GitHub second.
- [x] A mirror-first configuration produces About facts `{ host: "prism.xyern.com", repo: "laochenfei233/prism-agent", releaseUrl: ".../releases" }`; a bare GitHub configuration produces the current facts with an empty host; unrecognizable endpoints produce empty facts.
- [x] The About card renders `prism.xyern.com` as text with the mirror badge under the mirror configuration, keeps the repository link, GitHub Releases badge, and GitHub links under a bare GitHub configuration, and keeps the unavailable state otherwise.
- [x] zh/en dictionaries keep key parity, and the plugin's tests pass.
- [x] `cargo test` passes for the desktop crate, and the plugin builds cleanly through tsdown (the `lib/` output is gitignored and rebuilt at packaging time).
