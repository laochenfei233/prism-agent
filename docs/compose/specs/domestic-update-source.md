---
feature: domestic-update-source
status: in-progress
updated: 2026-11-21
branch: feat/domestic-update-source
commits: 205657d63d..
---

# Domestic update source

English | [中文](domestic-update-source.zh.md)

## Report

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

- [ ] T1: reorder `tauri.conf.json` endpoints to mirror-first with GitHub fallback (depends: none)
- [ ] T2: extend `UpdateSource` with the display host and map endpoints to mirror/GitHub facts, with tests (depends: none)
- [ ] T3: render the mirror state in the About card — bridge type, pure helper, section, dictionaries, tests (depends: none)
- [ ] T4: rebuild the prism-about `lib/` bundles locally as a build smoke — `lib/` is gitignored and rebuilt at packaging time (depends: T3)
- [ ] T5: update docs — desktop README pair, prism-about README pair and description, `desktop-dev-notes.md` (depends: none)
- [ ] T6: add the changelog entry (depends: none)

## [S4] Acceptance

- [ ] The shipped updater config checks the CDN manifest first and GitHub second.
- [ ] A mirror-first configuration produces About facts `{ host: "prism.xyern.com", repo: "laochenfei233/prism-agent", releaseUrl: ".../releases" }`; a bare GitHub configuration produces the current facts with an empty host; unrecognizable endpoints produce empty facts.
- [ ] The About card renders `prism.xyern.com` as text with the mirror badge under the mirror configuration, keeps the repository link, GitHub Releases badge, and GitHub links under a bare GitHub configuration, and keeps the unavailable state otherwise.
- [ ] zh/en dictionaries keep key parity, and the plugin's tests pass.
- [ ] `cargo test` passes for the desktop crate, and the plugin builds cleanly through tsdown (the `lib/` output is gitignored and rebuilt at packaging time).
