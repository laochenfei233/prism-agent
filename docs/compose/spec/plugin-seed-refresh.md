---
feature: plugin-seed-refresh
status: in-progress
updated: 2026-11-01
branch: feat/plugin-seed-refresh
commits: c21408d0fb..HEAD (filled at delivery)
---

# Plugin Seed Refresh

English | [中文](plugin-seed-refresh.zh.md)

## Report

Pending delivery.

## [S1] Problem

After an application upgrade the plugin manager marks `@prism-ai/prism-meeting` as 「异常」, and three shipped bundles (`@prism/prism-pocket`, `@prism/prism-local-models`, `prism-session-autoarchive`) ship without any built `lib/`.

The failure is not in the build bytes. `dsh --dump-config` on the installed web profile prints `skipping profile bundle "@prism-ai/prism-meeting": Error: Plugin @prism-ai/prism-meeting@0.1.0 is incompatible with dsh 0.2.1-rc.4: requirements {"@deepseek-ai/dsh-llm":"0.1.7-rc.1","@deepseek-ai/dsh-speech-to-text":"0.1.7-rc.1","@deepseek-ai/dsh-storage-domain":"0.1.7-rc.1","@deepseek-ai/dsh-tools":"0.1.7-rc.1"}`, while that profile copy's `lib/index.js` and `lib/client.js` are byte-identical to the installed ones (equal SHA-256). Compatibility is read from the copy's `package.json` peer ranges, and that manifest still names 0.1.7-rc.1, so the loader skips the bundle and `listBundles` reports `incompatible-version` — the tag the page renders.

Two defects produce that state:

1. The shell seeds bundled plugins into `$DSH_HOME/profiles/node_modules/<package>` only while the destination is absent (`ensure_local_bundles`, `ensure_market_bundle`). An upgrade therefore leaves an old manifest, or an unusable copy, in place forever. The same staleness skips `aegis` (2.10.8, peers `^0.1.0-rc.6`) and `@prism/prism-memory` (0.2.2 carrying 0.1.7 peers), and `@prism/prism-pocket`'s copy has no `lib/index.js` at all.
2. `plugins/*` are outside `pnpm-workspace.yaml`, so `pnpm run build` never builds them, `lib/` is gitignored, and `apps/desktop/scripts/bundle-runtime.mjs` copies whatever happens to exist in the checkout. The three packages above shipped with no `lib/`, so every copy seeded from them is unloadable.

## [S2] Design

### S2.1 Launcher-owned plugin copies track the installation

`$DSH_HOME/profiles/node_modules/<package>` is the launcher's flat module fallback: the installed runtime keeps local bundles under `<resources>/runtime/plugins/<dir>`, outside its own module closure, and the loader resolves their bare package names through this directory. The copy is therefore a projection of the installation, and it is replaced whenever the installation's build differs.

A seeded copy is replaced when any of these holds:

- the destination is absent (first launch; a failure to create it still fails startup, as today);
- the destination lacks the entry its own `package.json` declares (`main`, else `index.js`);
- the destination `package.json` and the installation's differ byte for byte;
- the recorded installation version differs from the one in `<resources>/runtime/prism/package.json`, which refreshes every seeded copy once per application upgrade.

A copy is kept, and none is created, when either holds:

- the installation's own copy lacks its declared entry. That unbuilt package must not replace a copy that works, nor seed one that cannot load — this is the guard that kept the three unbuilt bundles from destroying working profile copies, and it stays;
- the destination is a link (a pnpm `link:` projection or a developer junction). Rewriting through it would write into another checkout.

Replacement is wholesale — `remove_dir_all` then copy — so a file the new build dropped cannot linger. A replacement that fails leaves the existing copy and does not block startup: a second instance may hold a file, and the next launch retries. `$DSH_HOME/profiles/.seeded-runtime` records the installation version of the last full pass.

The local bundles, the market bundle (`dsh-plugin`), and the Windows terminal inspector copy share one helper, so the copy-once root cause is fixed once.

### S2.2 Packaging builds every local bundle and refuses an entry-less one

`bundle-runtime.mjs` builds the local bundles before copying them: for every `plugins/<dir>` shipping a `tsdown.config.ts`, it runs the checkout's own tsdown (`node_modules/tsdown`, cwd at the package). A build that produces no declared entry fails packaging with the package's name, so the three unbuilt bundles become a packaging error instead of a release.

The copy step then skips, on the console and by name, a package whose entry this checkout cannot produce at all — `plugins/prism-meeting` holds only metadata and a build output here, because its sources live outside this checkout — rather than shipping a package nothing can import. A skipped package is absent from `runtime/plugins`, which is the honest state: the profile cannot resolve it.

The packages' own `build`/`bundle` scripts are not used: outside the workspace, `pnpm run` finds no local `node_modules/.bin` and auto-installs the directory first. tsdown is what both script names run, and it is the same builder every bundled plugin declares.

### S2.3 The plugin page names the remedy an app-provided bundle actually has

`managementText` gains an `appProvided` input. For `incompatible-version` on a bundle whose files the profile does not own (`installed === false`, so it can only be an installation copy or a bundle selection), the trailing remedy becomes `reasonIncompatibleAppProvided` — update the app and restart to load its bundled copy — instead of 「卸载后重新安装」, which the page offered for a package the profile cannot install. The per-package requirement sentences stay.

## [S3] Scope

- In scope: desktop seeding (`apps/desktop/src-tauri/src/setup.rs`), desktop runtime packaging (`apps/desktop/scripts/bundle-runtime.mjs`), the plugin manager's incompatibility remedy (`packages/client/ui-plugin-manager`), and the desktop README packaging line.
- Out of scope: changing `evaluatePluginCompatibility` or the bundle resolution order; refreshing user-installed packages; a plugin-manager action that re-seeds a bundle; the marketplace's own update flow.

## Tasks

- [ ] T1: one seed/refresh helper in `setup.rs` (`copy_is_stale`, `replace_dir`, `is_link`) used by local bundles, the market bundle, and the terminal-inspector copy (covers: S2.1)
- [ ] T2: installation-version marker so an upgrade refreshes every seeded copy (covers: S2.1)
- [ ] T3: unit tests over scratch homes: stale manifest, missing entry, unbuilt source keeps the copy, never replace a link, version marker forces a refresh (covers: S2.1)
- [ ] T4: `bundle-runtime.mjs` builds local bundles before copying and fails on a missing declared entry (covers: S2.2)
- [ ] T5: `ui-plugin-manager` app-provided remedy, dictionary entries, and a page test (covers: S2.3)
- [ ] T6: desktop README packaging line and the verification round (depends: T1, T2, T3, T4, T5)

## [S4] Acceptance

- [ ] A1: a profile copy whose `package.json` differs from the installation's is replaced wholesale, and no dropped file survives (T1, T3)
- [ ] A2: a profile copy missing its declared entry is replaced when the installation copy has it (T1, T3)
- [ ] A3: when the installation copy lacks its declared entry, the profile copy is untouched, no copy is created for a bundle that has none, and the bundle name is still selected (T1, T3)
- [ ] A4: a junction or symlink destination is never replaced (T1, T3)
- [ ] A5: a changed installation version refreshes every seeded copy once and records the version (T2, T3)
- [ ] A6: the packaging build produces `lib/index.js` for `prism-pocket`, `prism-local-models`, and `prism-session-autoarchive`, and the copy step places it under `apps/desktop/runtime/plugins/` (T4)
- [ ] A7: packaging fails naming the package when its build produced no declared entry (T4)
- [ ] A8: an incompatible bundle the profile does not own renders the app-provided remedy, not the uninstall one (T5)
- [ ] A9: `cargo test --lib setup::` passes, `node --check apps/desktop/scripts/bundle-runtime.mjs` passes, and the plugin-manager specs pass (T6)
- [ ] A10: a package whose entry this checkout cannot produce is skipped by name and not copied (T4)
