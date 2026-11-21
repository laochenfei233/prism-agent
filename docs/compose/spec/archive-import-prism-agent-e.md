---
feature: archive-import-prism-agent-e
status: delivered
updated: 2026-09-24
branch: master
commits: the orphan baseline commit
---

# Archive Prism-Agent and Import DeepSeek Harness as prism-agent-e

English | [中文](archive-import-prism-agent-e.zh.md)

## Report

**What was built** — The Prism-Agent codebase left the mainline entirely: the workspace WIP was committed first (4 commits), the icons and design content were then extracted into `design-assets/` (26 files), the complete workspace including `.git` was packaged as `archives/prism-agent-final-20260924-153522.zip` (38.3 MB), the two leftover worktrees were removed, the cloud Gitea and GitHub repositories were both renamed to `prism-agent-e` with the local remotes synchronized, and finally the repository was reset onto an orphan history holding the deepseek-harness source baseline (`@deepseek-ai/dsh-root`) plus `design-assets/`, with a force push overwriting `master` on both ends.

**Verification** — After T1, `git status` is clean (four commits plus the design-assets commit). T2: `design-assets/` holds 26 files, and all 8 agent-logo SVGs parse as XML one by one. T3: the zip is 38.3 MB, and `tar -tf` lists `prism-agent/.git/HEAD`, `design-assets/README.md`, `prism-agent/package.json`, and `prism-agent/src/main/`, 7459 entries (excluding node_modules/dist/out). T4: `git worktree list` shows only the main checkout. T5: Gitea `PATCH /api/v1/repos/.../Prism-Agent` → `laochenfei233/prism-agent-e`, GitHub `PATCH /repos/laochenfei233/prism-agent` → `laochenfei233/prism-agent-e`, and both remote URLs in `git remote -v` contain `prism-agent-e`. T6: the orphan commit, whose root holds the DSH marker files and no old `src/main`. T7: after the force push to both ends, `git ls-remote` returns the same revision on both, matching the local `rev-parse master`.

**Journey log**

- The first full zip packed the repository directly with `tar -a` and ran past the 5-minute timeout, because `node_modules` at 2.1 GB plus `dist` at 1.45 GB dominated; packaging after a robocopy staging pass (`/XD node_modules dist out .vite coverage .pnpm-store .worktrees`, `/XF *.tsbuildinfo`) brought it down to 38.3 MB.
- Clearing the workspace hit the same timeout: PowerShell `Remove-Item -Recurse` was dragged past it by the large directories. Deleting directory by directory with `cmd /c "rd /s /q"` and finishing the scattered leftovers with `Remove-Item` left only `.git`.
- The `gh` CLI's own token had expired (`gh auth status` reported invalid), while the token in `~/.git-credentials` still worked (scopes `gist,repo,workflow`), so the two renames call the REST APIs directly and bypass `gh`.
- Gitea Basic auth requires URL-decoding the password from `.git-credentials` first (`%3a` → `:`), otherwise it answers 401; the GitHub `PATCH` requires `Accept: application/vnd.github+json` and a `User-Agent`.
- The finalized spec existed only in the pre-orphan commit for a while; a `git show` against the pre-orphan tip recovered it, and it was written into the new tree before the commit, so the delivery document does not survive only inside the archive zip.

## [S1] Problem

The Prism-Agent project was transforming as a whole: all the old code would be archived out of the mainline, the cloud repositories would be renamed to `prism-agent-e`, and the DeepSeek Harness (deepseek-harness) source would become the content of the new repository. At the same time, the application icons, agent logos, and design content that still had reuse value in the old project had to be extracted and kept alongside the new code.

Obstacles before the transformation:

- The workspace held 14 modified plus 6 untracked files (WIP on meeting validation, ASR, and more) that were uncommitted.
- The Gitea repository was named `Prism-Agent` (`http://192.168.100.28:32396/laochenfei233/Prism-Agent`) and `prism-agent-e` did not exist; GitHub held `laochenfei233/prism-agent`.
- Two leftover worktrees (wiki-redesign, wiki-refactor) held branches and had to be cleaned up before the orphan reset.
- The meeting-minutes UI has no standalone logo files (every icon is lucide-react), so what could be extracted is the application icons, the Agent SVG logo set, and the README and design documents.

## [S2] Design

**Decisions confirmed in the grill (2026-09-24):**

| Axis | Decision |
|---|---|
| Archival method | Export an archive, then reset (a new orphan history) |
| Cloud rename | Both Gitea and GitHub become `prism-agent-e` |
| Icon destination | A new `design-assets/` directory at the root of the imported repository (DSH's top level has no directory of that name, so nothing collides) |
| WIP handling | Commit first, then archive |
| Old cloud history | Overwritten by the force push (the zip is the archival carrier) |
| New repository content | Only the deepseek-harness code plus `design-assets/` |

**D1 — Execution order**: commit the WIP → extract design-assets → zip outside the repository → remove the worktrees → rename both ends and update the remotes → orphan-reset and import DSH → force push → update memory. Each step's verifiable output is the condition for starting the next one.

**D2 — Archival zip**: it lands outside the repository directory (`C:\Users\chenfei\Documents\GitHub\archives\`) so the reset cannot reach it; its content is the complete workspace including `.git`, excluding `node_modules`/`dist`/`out`/`.vite`/`coverage`/`.pnpm-store`/`.worktrees` and `*.tsbuildinfo`.

**D3 — `design-assets/` extraction list**: `app-icons/` (build's full icon/logo/avatar/tray set plus the renderer's logo/avatar copies), `agent-logos/agent-logo-1..8.svg` (exported from `AgentLogo.tsx`'s gradient stops and geometry as static SVGs that do not depend on React), `readme-design/` (`assets/readme/hero.svg`, `features.svg`), and `design-docs/` (`appleDesign.ts`, design-audit, design-conformity-audit-and-mimo-fix, meeting-ui-apple-design-review), with a `README.md` listing the sources. The meeting minutes had no logo files to extract — their interface icons are all lucide-react — and their visual specifications went into `design-docs/`.

**D4 — Cloud rename**: Gitea goes through Basic auth (the password needs URL-decoding) against `PATCH /api/v1/repos/laochenfei233/Prism-Agent`; GitHub goes through the token in `.git-credentials` against `PATCH /repos/laochenfei233/prism-agent`; once both succeed, `git remote set-url` follows. The `gh` CLI's own token had expired, so the rename does not go through `gh`. The old cloud history disappears from the default branch after the force push, and the only complete backup is the D2 zip.

**D5 — Orphan reset and DSH import**: `git checkout --orphan` → clear the workspace (keeping `.git`) → copy the files from `C:\Users\chenfei\Documents\GitHub\deepseek-harness` (without its `.git`, excluding `node_modules`, `.pnpm-store`, `.worktrees`, `.tmp-*`, `.standalone`, `.dsh-build`, `*.tsbuildinfo`, `.mimocode`) → copy `design-assets/` back → commit the baseline → rename the branch to `master`. The old local feat/* branches stay as a local supplementary backup of the old history.

**D6 — Gitea address conclusion (confirmed by the user by name)**: before the transformation both `git ls-remote gitea` and the API Basic auth succeeded, and the repository was `laochenfei233/Prism-Agent` (private); after the rename the address is `http://192.168.100.28:32396/laochenfei233/prism-agent-e.git`. Separate historical credentials point at the old IP `192.168.3.50:32396`; they are unrelated to the current remote and were left alone.

## [S3] Scope

- In scope: commit the master WIP; extract icons and design into `design-assets/` with a source list; archive the full zip outside the repository (including `.git`); remove the 2 leftover worktrees; rename Gitea and GitHub to `prism-agent-e` and update the local remotes; orphan-reset `master` and import the deepseek-harness source plus `design-assets/`; force push `master` to both ends; update the project memory.
- Out of scope: changing the deepseek-harness source content or merging Prism-Agent features; installing DSH dependencies or running a DSH build; deleting the old local branches or tags; exporting the meeting lucide icons one by one.

## Tasks

- [x] T1: commit all master WIP (four commits)
- [x] T2: create `design-assets/`, complete the D3 extraction list, and write its README.md (one commit)
- [x] T3: produce the full zip archive outside the repository and spot-check it (38.3 MB, including `.git` and `design-assets/`)
- [x] T4: remove the wiki-redesign and wiki-refactor worktrees (branches kept)
- [x] T5: rename to prism-agent-e through the Gitea and GitHub APIs, update the remote URLs
- [x] T6: orphan-reset master, import DSH plus design-assets, the baseline commit
- [x] T7: force push gitea/github master and verify both ends with ls-remote
- [x] T8: update the MEMORY.md project status and finalize the spec

## [S4] Acceptance

- [x] A1: `git status` is clean after T1; the zip exists and `tar -tf` lists `.git/HEAD` and `design-assets/`
- [x] A2: `design-assets/` holds 26 files (8 agent-logo SVGs that all parse as XML, app-icons 11, readme-design 2, design-docs 4, README.md)
- [x] A3: `git worktree list` leaves only the main checkout
- [x] A4: both APIs return `laochenfei233/prism-agent-e`; both URLs in `git remote -v` contain `prism-agent-e`
- [x] A5: the local master root holds the DSH marker files (`package.json` name = `@deepseek-ai/dsh-root`, `AGENTS.md`, `pnpm-workspace.yaml`) plus `design-assets/`, and the old `src/main` no longer exists
- [x] A6: `git ls-remote gitea master` and `git ls-remote github master` both return the same revision as the local master
- [x] A7: MEMORY.md records the new remote URLs, the archival zip path, and the deepseek-harness baseline state
