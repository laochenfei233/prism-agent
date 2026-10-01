---
feature: fork-upstream-divergence
status: delivered
updated: 2026-10-01
branch: none, see the Workspace override in desktop-startup-latency.md (S2)
commits: uncommitted working tree
---

# Fork Upstream Divergence

English | [中文](fork-upstream-divergence.zh.md)

## Report

**What was built** — One index of the places where this checkout leaves `deepseek-ai/deepseek-harness`, so a later upstream update can replay them without reading the feature documents first. The index has two halves: a `PRISM-DIVERGENCE` comment at each site, and this document, which groups the sites into seven areas and states for each area what a replay must do. Four areas rewrite or delete content upstream owns — the desktop application (upstream ships an Electron shell; this tree ships a Tauri shell), the client branding, the boot resolver's listing gate, and the `@electron/osx-sign` line in `pnpm-workspace.yaml`, which upstream still declares and this tree drops because the Tauri shell leaves the patch unused — and the rest add paths upstream has no counterpart for. The marker text is `PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).`, so `rg -n PRISM-DIVERGENCE` prints the machine index.

**Verification** — `rg -n PRISM-DIVERGENCE` lists 17 marker sites: 11 name this document and 6 name [desktop-startup-latency.md](desktop-startup-latency.md) S5, which points back here; the four prose mentions of the marker inside that pair are not markers. Every path claim in S2 was probed against the sibling checkout at `bafb0f3abf`, whose `upstream` remote is `deepseek-ai/deepseek-harness` at `46a7f68b09`: `apps/desktop` exists there as 408 Electron files and has no `src-tauri`, `packages/boot/app-boot` and `packages/client` match this checkout's baseline blobs, `patchedDependencies` still carries `'@electron/osx-sign@1.3.3'`, and `plugins`, `design-assets`, `docs/compose`, `CAPABILITY-PLAN.md`, `packages/cron` and `docs/subsystems/cron.md` are absent. `verify-md-wrap` passes over the new pair, and `verify-translation-pairing` reports the three changed pairs consistent.

**Journey log**

- The repository cannot merge upstream — master holds an orphan baseline import and no `upstream` remote, so the baseline and `deepseek-ai/deepseek-harness` share no ancestor — which is why a divergence recorded only in the working tree is invisible to whoever performs the next import.
- The desktop work also exists in the sibling checkout `../deepseek-harness` (`laochenfei233/deepseek-harness`, with `origin`, `gitea`, and an `upstream` remote at `deepseek-ai/deepseek-harness`), whose history does merge upstream; a replay can reconcile there and then re-import.
- An unfinished import sat in the working tree since 2026-09-27 (cron, path-lock, speech-to-text-dashscope, ui-cron, cron-controller), and it exists in neither this repository's baseline commit nor the sibling checkout; marking it as a fork divergence would send a replay to the wrong files, so S2 lists it as an import in progress instead.
- Rebranding reaches into files upstream owns rather than staying in added files: this tree deletes `FishLogo.tsx`, rewrites `BrandWordmark.tsx` and both client locale dictionaries, and adds `PrismLogo.tsx` and `PrismBadgeLogo.tsx`, so a replay that copies the client directories carries only the additions.
- `apps/desktop/README.md` states that the fork modifies no upstream `packages/` code, which the listing gate and the client branding have since made false; S2 is the corrected record, and the sentence itself is left to its owners.

## [S1] Problem

`master` holds two commits — the orphan baseline import of the harness tree and the spec finalization that followed it — and the repository has no `upstream` remote: `gitea` and `github` point at `laochenfei233/prism-agent-e`, and `mimocode` points at `XiaomiMiMo/MiMo-Code`. The baseline therefore shares no ancestor with `deepseek-ai/deepseek-harness`, `git merge` cannot run against it, and an upstream update arrives as a replaced tree. Every fork edit to a file that tree also carries disappears unless someone re-applies it by hand, and the fork does edit files upstream owns: the desktop application is replaced by a different framework, the client branding rewrites upstream components, and the boot resolver carries a listing gate.

Without a written index that replay is archaeology. The working tree on 2026-10-01 holds 197 modified tracked files, 51 untracked paths, and 4 deletions — most of them from an unfinished upstream import and from unrelated in-progress work — and the only written account of divergent sites was one section of [desktop-startup-latency.md](desktop-startup-latency.md), which covers that feature alone. A replay had two bad options: read every feature document to find the edits, or diff two trees that share no history and separate the fork's edits from the newer upstream's own changes.

The desktop fork work is not only here. The sibling checkout `../deepseek-harness` (`laochenfei233/deepseek-harness`, remotes `origin` and `gitea` at that fork plus `upstream` at `deepseek-ai/deepseek-harness`) carries `apps/desktop/**` in a history that does merge upstream, so the desktop and branding areas can be reconciled where merging works and this repository can then re-import the result.

## [S2] Design

### The marker

A marker is one comment line at the site, in the file's own comment syntax: `PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).` A path the fork owns completely carries it on line 1; a file upstream also owns carries it on the line above the divergent construct, the way [desktop-startup-latency.md](desktop-startup-latency.md) marks its three boot sites. Markers written with the earlier text name that document instead, and its S5 points here. `rg -n PRISM-DIVERGENCE` prints the whole index, and the sentence inside the feature documents that names the marker is not one, so a reader can tell the index from the references to it.

### How one path is classified

Against a candidate upstream tree, every path falls into exactly one class. The first probe prints its argument back when the path is absent upstream, which is the signal for the first class:

```sh
git -C ../deepseek-harness rev-parse <upstream-ref>:<path>
git hash-object <path>
git -C ../deepseek-harness rev-parse <upstream-ref>:<path>   # blob, when the path resolves
```

- Absent upstream: additive. Copy this tree's path whole; there is nothing to reconcile.
- Present upstream with the same blob: not a divergence. Keep upstream's file and drop the marker if the fork's copy had one.
- Present upstream with a different blob: divergent. Start from upstream's file and re-apply the change its marker names.

### Areas

| Area | Paths | What a replay must do |
| --- | --- | --- |
| A1 Desktop application | `apps/desktop/**` — the Tauri shell, `src-tauri/**`, the `ui/dist` bundle, `scripts/bundle-runtime.mjs`, and the marker-bearing README pair | replace upstream's Electron application wholesale with this directory, then re-apply layers 1 and 3 from [desktop-startup-latency.md](desktop-startup-latency.md) and the shell edits the markers name; `cargo test` under `apps/desktop/src-tauri` and `node --check` on the shell scripts are the checks |
| A2 Client branding inside upstream packages | `packages/client/locale/src/locales/en.ts` and `zh.ts`, `packages/client/ui-primitives/**` (`FishLogo.tsx` deleted, `BrandWordmark.tsx` and the icon tests rewritten, `PrismLogo.tsx` and `PrismBadgeLogo.tsx` added), `packages/client/ui-brand-official/**`, `packages/client/ui-theme/**` including the added `builtin-themes.ts` and `client/gallery.ts`, `packages/client/ui-sidebar/**`, `packages/client/ui-layout/**`, `packages/client/ui-conversation/**`, `packages/client/web/**`, and `apps/web/**` (page title, manifest, favicons, PWA test) | take upstream's copy of each rewritten file and re-apply the rebranding, keep the added Prism files, and run the client packages' unit tests and snapshot tests as the check |
| A3 Boot resolver listing gate | `packages/boot/app-boot/src/profile.ts`, `packages/boot/app-boot/src/profile-resolution/resolver.ts`, `packages/boot/app-boot/tests/profile.spec.ts` | take upstream's files and re-apply the `DirectoryListings` block, the gate inside `packageDirFromAnchor`, and `canonicalPath` returning `realModuleDirectory(path)`; [desktop-startup-latency.md](desktop-startup-latency.md) S5 lists them row by row, the compiler rejects a dropped `listings` argument, and the four regression tests are the check |
| A4 pnpm workspace patch line | `pnpm-workspace.yaml` | delete `'@electron/osx-sign@1.3.3'` from `patchedDependencies`, which pnpm rejects as unused once the Electron shell is gone (`ERR_PNPM_UNUSED_PATCH`); re-apply after every import and before any `pnpm install`, and check that an install reaches the store instead of failing on the unused patch |
| A5 Out-of-tree plugins and profile home | `plugins/**` (`aegis`, `dsh-agent-progress`, `dsh-tauri`, `prism-guardrails`, `prism-meeting`) and `home-mods/**` | copy the plugin directories and the profile home unchanged, but leave out `home-mods/.credentials.yaml`, which holds a credential and is not ignored |
| A6 Prism-only documents and assets | `design-assets/**`, `docs/compose/spec/**`, `CAPABILITY-PLAN.md`, `MIMOCODE-REFERENCE.md` | copy unchanged; upstream has no counterpart, so nothing here can conflict |
| A7 Import in progress | `packages/cron/**`, `packages/api/cron-controller/**`, `packages/client/ui-cron/**`, `packages/util/path-lock/**`, `packages/experimental/speech-to-text-dashscope/**`, `docs/subsystems/cron.*`, `apps/cli/config/examples/cron/**`, `.agents/notes/proposed/feature/2026-09-26-cron-scheduled-tasks.*` | not a fork divergence: land the import first, then re-apply A3 and A4 on the merged tree and mark whatever the newer tree itself changed |

## [S3] Scope

- In scope: one marker at each divergent site, this index, and the fork-wide index line added to [desktop-startup-latency.md](desktop-startup-latency.md) S5 in both languages.
- Out of scope: committing anything — the change stays in the working tree until the closing action is chosen; landing the import in progress; the unrelated working-tree edits; the stale sentence in `apps/desktop/README.md`; and the pre-existing pairing gap under `design-assets/`.

## Tasks

- [x] T1: markers at the A1 desktop sites, the A2 brand site, and the A4 workspace line
- [x] T2: this document, its Chinese counterpart, and the pairing record
- [x] T3: the fork-wide index line in `desktop-startup-latency.md` and its counterpart
- [x] T4: the doc gates re-run over the changed pairs
- [ ] T5: the closing action for the index (see S3, decision pending)

## [S4] Replay checklist

1. Take stock here: `git status --porcelain` and `rg -n PRISM-DIVERGENCE`, and decide the fate of the import in progress (A7) before touching anything else.
2. Reconcile where merging works: in `../deepseek-harness`, `git fetch upstream` and merge `upstream/master`, re-applying A1 through A4 there, where they are ordinary commits.
3. Re-import that tree into this repository, then classify every path from A1, A2, A3, A5, and A6 with the probe in S2: copy the additive paths and re-apply the divergent ones by hand.
4. Re-apply A4 before running any install, or `pnpm install` fails with `ERR_PNPM_UNUSED_PATCH`.
5. Re-apply A3 last, because the newer tree may have changed the same resolver file; then run the `tsc` and app-boot commands recorded in [desktop-startup-latency.md](desktop-startup-latency.md) S4.
6. Re-apply the markers: `rg -n PRISM-DIVERGENCE` must name every site in A1 through A4, and no marker may point at a path the new tree dropped.
7. Copy A5 and A6 unchanged, then re-run `verify-md-wrap`, `verify-translation-pairing` over the changed pairs, `verify-md-links`, and `cargo test` under `apps/desktop/src-tauri`.

## [S5] Related documents

- [desktop-startup-latency.md](desktop-startup-latency.md) — the boot gate and the hub adoption, and the per-file list for A3.
- [desktop-client.md](desktop-client.md), [desktop-port-resilience.md](desktop-port-resilience.md), [cli-pnpm-resolution.md](cli-pnpm-resolution.md) — the desktop features whose code A1 carries.
- `archive-import-prism-agent-e.md` — how the orphan baseline was produced and pushed.