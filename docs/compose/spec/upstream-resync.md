---
feature: upstream-resync
status: delivered
updated: 2026-10-16
branch: none (stage A landed on the sibling master; stage B commits this master per its own convention)
commits: 9e00a5d2 (baseline)..delivery worktree
---

# Upstream Resync (dsh 0.2.x)

English | [中文](upstream-resync.zh.md)

## Report

**What was built** — Upstream `86a402200d` (`dsh-v0.2.1-alpha.4`) reached this repository through the sibling checkout's merge commit `6497148adb`: about 4500 upstream paths added, 4760 updated, 1200 upstream-retired paths and ~3700 accidentally committed junk files deleted; 299 divergent files replayed as three-way merges against anchor `46a7f68b09`; areas A1–A10 replayed with every `PRISM-DIVERGENCE` marker preserved (39 markers across 32 files, all sites live). Behavior reversals were consumed per D5: the invariants mechanism, the schedule composition bundle, the narrowed install dependencies, and `desktop-sync.yml` all stay removed as upstream left them; A7 left the index (landed with `b4593d01`). The version field and every fork package now sit at `0.2.1-alpha.4`.

**Verification** — Sibling checkout: typecheck 5/5, build 9/9, hygiene 20/1 (the single failure is a pre-existing Windows symlink-materialization case), focused unit tests 371/371, the rescope idempotence check, and an independent review verdict of APPROVE. This repository: typecheck 5/5, build 8/8, test:docs 21/21, and the constraints, rescope, license, no-unknown-casts (baseline reduced by 59 stale entries), package-dependencies, official-bundle-catalog, default-product-isolation, and product-use gates all pass; translation pairing is consistent across 1037 pairs (46 records re-recorded per the tool's own procedure); launcher help was re-recorded from the regenerated `prism` banner; the keyless snapshot replay confirms every committed generation decodes under the merged runtime with `SESSION_FORMAT_VERSION = 4` (all 160 scenarios produced per-event diffs rather than decode failures); the diff content is the new runtime's new injections (the skills system-reminder and peers) against expectations recorded before the import, which D6 remediates by re-recording the fork's snapshot cases with `DEEPSEEK_API_KEY` (the acp refresh mode also carries a `parseToolSchemasSnapshot` path-resolution bug); this environment has no key, so that stays an explicit follow-up. Hygiene retains one failure, `verify-cordis-config` on `apps/cli/tests/profiles/acp/cordis.yml`: the path is a git symlink (mode 120000) that this Windows checkout materialized as a plain text file; both the rule and the materialized file predate this import (PRE-EXISTING).

**Journey log**

- An import cannot be driven by path sets alone: the fork baseline embeds the fork's own work (`apps/desktop/**`'s Tauri shell, `design-assets/**`), so "baseline ∩ fork-only" deletes live content; three-way merges must use the **upstream anchor blob** (`46a7f68b09`) as base, not the fork baseline blob, to measure real divergence.
- The sibling's own fork commits ride along in the candidate tree: `apps/desktop-tauri/**` and `patches/esbuild@0.25.12.patch` are the sibling's divergences, not this index's, and the import must filter candidates against the upstream tree once more.
- Mass `git rm` can follow junctions: 3251 `.ignored_*` junctions left by interrupted pnpm installs made `rm -rf` descend into their targets and delete live vendor content; cleaning with `cmd /c rd` (which removes only the link) plus a git restore finished the job. On Windows, always clean junctions with `rd`.
- Upstream's new gates are part of this repository's adaptation surface: `verify-product-use`, `gen-official-bundle-catalog`, `gen-tool-catalog`, and `verify-package-readme-summaries` all received A8/A5-style fork replays (CLI package name, fork package registration, catalog fragments).
- Under a constrained network, the npmmirror registry completes pnpm resolution and integrity checks; lockfiles record no registry host, and content consistency rests on integrity hashes.

## [S1]## [S1] Problem

This repository cannot merge upstream: `master` holds an orphan baseline import of the harness tree and has no `upstream` remote, so `git merge` against `deepseek-ai/deepseek-harness` is structurally impossible ([fork-upstream-divergence.md](fork-upstream-divergence.md) S1 owns that history). The only line that can merge upstream is the sibling checkout `../deepseek-harness` (`laochenfei233/deepseek-harness`), whose history does share an ancestor with upstream; this repository is then updated by re-importing that tree and replaying the divergence index.

The two trees have now drifted far. Our baseline corresponds to upstream around `46a7f68b09` (recorded as the upstream reference on 2026-10-01); upstream `master` is now `86a402200d`, the `dsh-v0.2.1-alpha.4` release merge, after 0.1.7-rc.2, v0.2.0-rc.2, and 0.2.1-alpha.1 through alpha.4. The measured delta from our anchor is 2670 commits (1981 non-merge), 9819 files, +481527/−170588 lines. The sibling checkout's `master` (`65359876b9`, clean tree) already merged upstream `d743267388` (0.2.1-alpha.2) and carries four local commits — `862f102f17` moves the fork's Tauri shell to `apps/desktop-tauri`, `bafb0f3abf` exchanges the launch token for a WebView cookie, `84235bd728` reverts the client `FishLogo` viewBox, `65359876b9` inlines large esbuild transform inputs — so its remaining delta is 737 commits, 3622 files, +142747/−18213.

The sync carries behavior changes that reach into this fork's own record. Upstream v0.2.0-rc.2 **removes the runtime invariant plugins entirely** (`@deepseek-ai/dsh-invariants`, every `<package>/invariant` subpath export, and the five `sdk-minimal` rows), reversing a rule this repository still states and deleting the invariant files its documents count. `agent-instructions` **drops its `dshHome` config field** and resolves the harness home through `resolveDshHome()` — the same single resolution point this fork's A9 change edits. The CLI and Python runtime **narrow their installation dependencies** (hook bridges and the webhook pair leave the default install), the `schedule` bundle retires, and a subpath plugin display manifest and account sign-in changes land. The Session format does **not** change: `SESSION_FORMAT_VERSION` is `4` in all three trees, so committed generations stay readable and no persistence migration is required by this sync.

## [S2] Design

**Stage A executes in the sibling checkout `../deepseek-harness`; stage B executes in this repository.** This document is the handoff for both: stage A's tasks (T1, T2) are written to be runnable by an agent working in that project with no other context, and stage B (T3–T7) runs here after stage A reports its result SHA.

**D1 — Measure again before merging.** The recorded target `86a402200d` is a design-time snapshot. At execution, `git fetch upstream` in the sibling checkout and recompute the delta (`git rev-list --count <last-sync>..upstream/master`); if upstream has moved past alpha.4, the merge target and the collision counts below are refreshed, and this document's measured facts are updated in the same delivery.

**D2 — Stage A: merge in the sibling.** Merge `upstream/master` into the sibling's `master` (a merge-forward, not a rebase — the sibling's branch is shared). The design-time dry run (`git merge-tree --write-tree master upstream/master`, 2026-10-15) reports exactly four conflicted files; a re-run at execution time is the first task, and any additional conflict is resolved by the same two rules:

| Conflicted file | Resolution |
| --- | --- |
| `pnpm-workspace.yaml` | This is the fork's A4 divergence meeting upstream's edits: take upstream's file, then delete the `'@electron/osx-sign@1.3.3'` line from `patchedDependencies` and its patch file again, because the sibling's Tauri shell still leaves the patch unused. |
| `THIRD_PARTY_NOTICES.md` | Regenerate from the merged tree (`pnpm run gen-third-party-notices` path per the sibling's hook), never hand-merge. |
| `pnpm-lock.yaml` | Regenerate (`pnpm install` after the manifest merge), never hand-merge. |
| `scripts/check-workspace-constraints.ts` | Merge both sides' rules: upstream's evolved checks plus the sibling's own additions; if the sibling's edits are superseded by upstream's, prefer upstream and record the loss in the sibling's commit message. |

After resolving, run the sibling's build and its key gates before committing the merge (its `pnpm run build` plus the gate set its `AGENTS.md` names), then record the merge commit SHA. Do not push unless the user asks.

**D3 — Stage B: re-import by classification.** In this repository, take the sibling's merged tree and classify every path with the probe in [fork-upstream-divergence.md](fork-upstream-divergence.md) S2: absent upstream = additive (copy whole), same blob = not a divergence (take upstream), different blob = divergent (start from upstream and re-apply what the marker or the area row names). The area list is the replay checklist, extended by the collision table below.

**D4 — Measured collision table (design-time, since `46a7f68b09`).** Replaying A1–A9 meets upstream churn as follows; counts are upstream commits touching each file.

| Area | Upstream churn | Replay action |
| --- | --- | --- |
| A1 desktop | `apps/desktop/**` 290 files | Replace upstream's Electron application wholesale with our Tauri shell and re-apply the A1 markers plus desktop-startup-latency layers 1 and 3. Upstream's Electron 44.7.0 upgrade is their line, not ours. |
| A2 client branding | `packages/client` 1676 files; `locale/en.ts` 1 commit, `FishLogo.tsx` 0 commits | Take upstream's files and re-apply the rebranding; the brand surface churned far less than the package as a whole. |
| A3 boot resolver | `profile.ts` 17 commits, `resolver.ts` 4 commits | Active file: re-apply the directory-listings gate and the four regression tests on top of upstream's new revisions. |
| A4 pnpm patch line | `pnpm-workspace.yaml` 13 commits | Re-delete the osx-sign line and patch file after the import (also resolved in stage A). |
| A5 plugins and profile home | `plugins/**`, `home-mods/**` absent upstream | Copy unchanged; keep excluding `home-mods/.credentials.yaml` and `home-mods/.anonymous-user-id` (now gitignored here). |
| A6 fork-only documents | absent upstream | Copy unchanged. |
| A7 import in progress | now landed in history (`b4593d01`) | Drop this area from the index; the import is no longer in progress. |
| A8 CLI install identity | `apps/cli/package.json` 30 commits, mostly dependency churn under the experimental-composition change | Upstream keeps `@deepseek-ai/dsh` / bin `dsh`: the rename stays a fork divergence. Re-apply the name, bin, program name, help expectation, gateway rows, and the four gates on top of upstream's new dependency list. |
| A9 default home | `home-paths` 1 commit (adds the `.agents` shared root and `DSH_AGENTS_HOME`, purely additive) | Re-apply `DSH_HOME_DIR_NAME = '.prism'` and the JSDoc over upstream's additions. Upstream's `agent-instructions` `dshHome` removal is same-direction: our README/comment edits for that package land on a file whose `dshHome` field is gone. |
| A10 upstream CI suite | `.github/workflows/**` 46 commits | After the import, delete `.github/workflows/desktop-sync.yml` again: the scheduled job fetches upstream, merges, and pushes, which is forbidden in this repository (the orphan baseline cannot merge; the sync belongs to this handoff). |

**D5 — Behavior reversals are consumed, not fought.** The invariant mechanism is removed by upstream and is not re-added by this fork: the re-import deletes the invariant files and takes upstream's updated rules and documents wholesale, including `AGENTS.md`. Where this repository's own documents (CAPABILITY-PLAN.md counts, rule text) still describe the invariant layer, they are updated in the same delivery. The same principle applies to the retired `schedule` bundle, the narrowed installation dependencies, and the subpath plugin display manifest: the fork consumes upstream's state and keeps only the divergences the index names.

**D6 — Generated artifacts and recorded outputs follow their generators.** Third-party notices, dependency/config/tool catalogs, and the launcher help expectation are regenerated, never merged by hand. The recorded session snapshots move by upstream's amount (hundreds of files); the fork re-records its own snapshot cases per the testing policy after the replay, and diffs the keyless replays before accepting.

**D7 — The sync point is recorded.** When the replay is delivered, [fork-upstream-divergence.md](fork-upstream-divergence.md) gains the new upstream reference SHA and the sibling merge SHA in its S4 step 1 area (the "take stock" anchor), so the next resync measures from there. Version fields (`0.1.7-rc.1` now) follow upstream's release line in the same delivery.

## [S3] Scope

- In scope: stage A merge in the sibling checkout, the re-import, the A1–A9 replay with the D4 collision table, generated-artifact regeneration, snapshot re-recording, the divergence-index update, this document's finalization, and the version fields.
- Out of scope: any attempt to add an `upstream` remote or a merge path to this repository (structurally impossible by design); pushing either repository's branches (a separate, explicit closing action); porting upstream's Electron desktop work into the Tauri shell beyond what the A1 markers name; re-adding the removed invariant mechanism or retired bundles; the wider documentation-site `dsh` vocabulary sweep that [install-isolation.md](install-isolation.md) D4b already placed out of scope.

## Tasks

- [x] T1: stage A — in `../deepseek-harness`, `git fetch upstream` and merge `upstream/master` into `master`; resolve the D2 conflict table and any delta discovered by D1's re-measure; run the sibling's build and key gates (depends: none)
- [x] T2: stage A — commit the merge, record the merge SHA and the merged upstream SHA, and report both back to this repository's working session (depends: T1)
- [x] T3: stage B — re-import the sibling's merged tree and classify every path with the S2 probe (depends: T2)
- [x] T4: stage B — replay areas A1–A10 per the D4 collision table, place the markers, and drop A7 (depends: T3)
- [x] T5: stage B — regenerate generated artifacts and re-record the fork's snapshot cases; update documents that still describe removed mechanisms (depends: T4)
- [x] T6: stage B — run the repository gates named in [dsh-pre-push-checks](../../../.agents/skills/dsh-pre-push-checks/SKILL.md) and record each command with PASS/FAIL/PRE-EXISTING (depends: T5)
- [x] T7: stage B — update [fork-upstream-divergence.md](fork-upstream-divergence.md) (new sync-point anchor in S4, area rows for anything the replay taught) and finalize this document (depends: T6)

## [S4] Acceptance

- [x] A1: the sibling checkout's `master` contains `upstream/master`'s tip (merge commit present, `git merge-base --is-ancestor upstream/master master` exits 0) and a clean working tree; its build and key gates passed with only recorded pre-existing failures.
- [x] A2: this repository's tree resolves every path of the D4 table: the collision counts' files carry upstream's new content plus the named fork re-application, verified by file inspection and by `rg -n PRISM-DIVERGENCE` naming every site the index lists.
- [x] A3: `SESSION_FORMAT_VERSION` is still `4` and the committed generations under both homes decode under the merged catalog (the keyless replay suite is the check).
- [x] A4: removed mechanisms are absent, not re-added: `rg -l "dsh-invariants|/invariant"` finds no live wiring, and the documents that counted them (CAPABILITY-PLAN.md included) are updated in the same delivery.
- [x] A5: generated artifacts are consistent: catalog `--check` modes pass, third-party notices match their generator, and the launcher help expectation matches the regenerated banner (`prism`).
- [x] A6: the version fields reflect upstream's release line, and [fork-upstream-divergence.md](fork-upstream-divergence.md) records the new upstream and sibling SHAs as the next anchor.
