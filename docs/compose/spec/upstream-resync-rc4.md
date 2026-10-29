---
feature: upstream-resync-rc4
status: designed
updated: 2026-10-29
branch: none (stage B runs on master in a dedicated worktree)
commits: pending
---

# Upstream Resync to dsh 0.2.1-rc.4

English | [中文](upstream-resync-rc4.zh.md)

## [S1] Problem

This repository is at the `dsh-v0.2.1-rc.2` import (master `c64d35c4`). Upstream has since published `dsh-v0.2.1-rc.3` (2026-10-23), `dsh-v0.2.1-rc.4` (2026-10-26), and `dsh-v0.2.2-alpha.2` (2026-10-28). The release-candidate line carries fixes and features this fork does not have: ACP stdout isolation, tooltip placement, sidebar navigation pins, a new entry-customization package, and a consolidated `llm-deepseek` listing cache.

`0.2.2-alpha.2` is 2161 commits past rc.4 and opens the next release line; it stays out of scope for this sync. The target is `dsh-v0.2.1-rc.4`.

The previous handoff ([upstream-resync.md](upstream-resync.md)) records stage A as a merge in the sibling checkout `../deepseek-harness` and names `3d5ad79dc0` as its merge commit. That commit does not exist in the current sibling clone: its `master` is `bafb0f3abf`, fetched from `origin/master`, whose history merges upstream at `067493161b` (the 0.1.7-rc.1 era). The sibling therefore lost the rc.2 anchor; it cannot be used as the stage A source without replaying rc.2 as well.

## [S2] Design

**D1 — Measure at execution.** Upstream tags are present in the sibling object store (`dsh-v0.2.1-rc.2`, `-rc.3`, `-rc.4`, `dsh-v0.2.2-alpha.2`). Fetch them into this repository with `git -C ../deepseek-harness fetch upstream --tags` (already done for these tags) and then `git fetch ../deepseek-harness refs/tags/dsh-v0.2.1-rc.4:refs/tags/dsh-v0.2.1-rc.4`; re-measure before applying. If rc.4 moved, update this document's counts in the same delivery.

**D2 — Stage B runs directly.** Because this repository already holds the rc.2 tree, stage A is unnecessary: diff `dsh-v0.2.1-rc.2..dsh-v0.2.1-rc.4` and replay that delta onto master. The measured delta is 11 non-merge commits, 649 changed files, 5917 insertions and 1041 deletions; 578 files are non-snapshot, of which 67 are source files. Most of the remainder are `package.json` version bumps and 71 one-line snapshot expectation changes.

**D3 — Classify every path.** Non-divergent paths take upstream content; a path whose current file contains `PRISM-DIVERGENCE` starts from upstream and re-applies the marker's instruction, using the rc.2 blob as the merge base. Run `rg -n PRISM-DIVERGENCE` afterwards and compare against [fork-upstream-divergence.md](fork-upstream-divergence.md). Areas A1–A10 replay as before; the A2 client-branding surface is the main collision because this delta touches `ui-sidebar`, `ui-conversation`, `ui-settings-general`, `ui-primitives`, and their locales.

**D4 — Structural changes.** The delta adds `packages/client/ui-entry-customization` and renames `packages/llm/llm-deepseek-account` files into `packages/llm/llm-deepseek` (`resolve-catalog.ts` → `listed-catalog.ts`, `catalog.ts` → `listing-cache.ts`, `listing.ts`, plus a new `listing-config.ts`). Copy the new package, move the renamed files, update bundle rows, workspace dependencies, and run the generators for tsconfig aliases/references, config/client/plugin catalogs, and the lockfile.

**D5 — Generated artifacts and snapshots.** Run `pnpm install`, then the catalog generators and `gen-cli-help`/`gen-persistence-catalog` only when their inputs changed. Re-record the fork's snapshot cases with `pnpm run test:snapshot:record` when a key is available; otherwise accept upstream's expectation files only where the fork has no recorded divergence and list the rest in the final report. Update every package version field to `0.2.1-rc.4` in the same delivery, including this repository's newer packages.

**D6 — Verification.** `pnpm run typecheck`, `pnpm run build`, focused tests for the touched packages, the keyless snapshot replay, and the divergence index check. The delivery is incomplete until the build and at least the focused tests pass; no version bump without the matching tree.

**D7 — Known pre-existing failures (not caused by this sync).** Measured on 2026-10-29 in a clean worktree at `c64d35c4`: `verify-cordis-catalog` and `verify-doc-graphs` report 24 unclassified cron/speech-to-text types; `doc-typecheck` fails on `packages/cron/cron/README.md` and `packages/util/path-lock/README.md`; `project-doc-site.spec.ts` expects 47 Chinese subsystem pages while the tree has 48; `verify-package-paths` reports two `packages/hooks/hooks-claude-code` references in archived agent notes; `verify-cordis-config` fails on the Windows-materialized `apps/cli/tests/profiles/acp/cordis.yml` symlink. Re-check each after the sync and report only the ones that remain.

## [S3] Scope

- In scope: the rc.2→rc.4 delta, A1–A10 replay, the new entry-customization package, the `llm-deepseek` file consolidation, regenerated artifacts, version fields, and the divergence index anchor.
- Out of scope: `0.2.2-alpha.2` and later; re-creating the lost sibling rc.2 merge; any history rewrite of this repository; pushing either repository.

## Tasks

- [ ] T1: fetch the rc.4 tag, re-measure the delta, and freeze the path list (depends: none)
- [ ] T2: copy added paths, delete removed paths, and take upstream on non-divergent paths (depends: T1)
- [ ] T3: three-way merge every PRISM-DIVERGENCE path and replay areas A1–A10 (depends: T2)
- [ ] T4: copy `ui-entry-customization`, consolidate `llm-deepseek`, update bundle rows/dependencies, regenerate artifacts, and update version fields (depends: T3)
- [ ] T5: run typecheck, build, focused tests, keyless snapshots, and the divergence index check (depends: T4)

## [S4] Acceptance

- [ ] A1: `git diff --stat dsh-v0.2.1-rc.4` for every non-divergent changed path is empty.
- [ ] A2: every PRISM-DIVERGENCE marker still names a live site, and the divergence index records the rc.4 tag plus the new sync-point facts.
- [ ] A3: `pnpm run typecheck` and `pnpm run build` pass, with only the D7 failures remaining.
- [ ] A4: version fields read `0.2.1-rc.4`, and the new package plus the renamed `llm-deepseek` files resolve through the generated aliases.
- [ ] A5: imported-session and session-log-export focused suites still pass, proving the fork's own Session surfaces survived the sync.
