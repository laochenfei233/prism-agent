---
feature: upstream-resync-rc4
status: designed
updated: 2026-10-29
branch: none (stage B runs on master in a dedicated worktree)
commits: pending
---

# 上游同步至 dsh 0.2.1-rc.4

[English](upstream-resync-rc4.md) | 中文

## [S1] 问题

本仓库停在 `dsh-v0.2.1-rc.2` 导入（master `c64d35c4`）。上游此后发布了 `dsh-v0.2.1-rc.3`（2026-10-23）、`dsh-v0.2.1-rc.4`（2026-10-26）与 `dsh-v0.2.2-alpha.2`（2026-10-28）。rc 线带有本 fork 没有的修复与功能：ACP stdout 隔离、tooltip 定位、侧栏导航固定、新的 entry-customization 包，以及合并后的 `llm-deepseek` listing 缓存。

`0.2.2-alpha.2` 比 rc.4 多 2161 个提交并开启下一发布线，本次不在范围内。目标是 `dsh-v0.2.1-rc.4`。

上一份交接（[upstream-resync.md](upstream-resync.zh.md)）把 stage A 记为同级 checkout `../deepseek-harness` 中的合并，并把 `3d5ad79dc0` 记为其合并提交。该提交在当前同级克隆中不存在：它的 `master` 是 `bafb0f3abf`，来自 `origin/master`，其历史在 `067493161b`（0.1.7-rc.1 时期）合并上游。同级库因此丢失了 rc.2 锚点；不重放 rc.2 就无法把它当作 stage A 来源。

## [S2] 设计

**D1——执行时重新测量。** 上游标签存在于同级对象库（`dsh-v0.2.1-rc.2`、`-rc.3`、`-rc.4`、`dsh-v0.2.2-alpha.2`）。用 `git -C ../deepseek-harness fetch upstream --tags` 获取（这些标签已获取），再执行 `git fetch ../deepseek-harness refs/tags/dsh-v0.2.1-rc.4:refs/tags/dsh-v0.2.1-rc.4`；应用前重新测量。若 rc.4 已移动，在同一次交付中更新本文的计数。

**D2——直接执行 stage B。** 本仓库已持有 rc.2 树，stage A 不必要：对 `dsh-v0.2.1-rc.2..dsh-v0.2.1-rc.4` 求差并把该增量重放到 master。测量到的增量为 11 个非合并提交、649 个文件、5917 行新增与 1041 行删除；其中 578 个非快照文件里 67 个是源码。其余大多是 `package.json` 版本号与 71 个一行的快照期望改动。

**D3——逐路径分类。** 非分歧路径取上游内容；当前文件含 `PRISM-DIVERGENCE` 的路径以上游为起点，再按标记指令重新应用，并以 rc.2 blob 作为合并基。完成后运行 `rg -n PRISM-DIVERGENCE` 并与 [fork-upstream-divergence.md](fork-upstream-divergence.zh.md) 对照。A1–A10 照旧重放；A2 客户端品牌面是主要冲突，因为本次增量触及 `ui-sidebar`、`ui-conversation`、`ui-settings-general`、`ui-primitives` 及其 locales。

**D4——结构性改动。** 增量新增 `packages/client/ui-entry-customization`，并把 `packages/llm/llm-deepseek-account` 的文件并入 `packages/llm/llm-deepseek`（`resolve-catalog.ts` → `listed-catalog.ts`、`catalog.ts` → `listing-cache.ts`、`listing.ts`，以及新的 `listing-config.ts`）。复制新包、移动被重命名的文件、更新 bundle 行与工作区依赖，并运行 tsconfig 别名/引用、config/client/plugin 目录与 lockfile 的生成器。

**D5——生成物与快照。** 运行 `pnpm install`，再按输入是否变化运行目录生成器与 `gen-cli-help`/`gen-persistence-catalog`。有 key 时用 `pnpm run test:snapshot:record` 重新录制 fork 自己的快照用例；否则只接受 fork 没有记录分歧的上游期望文件，并在最终报告里列出其余项。同一次交付中把每个包的版本字段更新为 `0.2.1-rc.4`，包括本仓库较新的包。

**D6——验证。** `pnpm run typecheck`、`pnpm run build`、被触及包的聚焦测试、无 key 快照重放与分歧索引检查。构建与至少聚焦测试通过前，交付不算完成；不能只改版本号而不改树。

**D7——已存在的失败（不是本次同步造成的）。** 2026-10-29 在 `c64d35c4` 的干净 worktree 上测得：`verify-cordis-catalog` 与 `verify-doc-graphs` 报告 24 个未分类的 cron/speech-to-text 类型；`doc-typecheck` 在 `packages/cron/cron/README.md` 与 `packages/util/path-lock/README.md` 失败；`project-doc-site.spec.ts` 期望 47 个中文子系统页而树中有 48 个；`verify-package-paths` 在归档 Agent Note 中报告两处 `packages/hooks/hooks-claude-code` 引用；`verify-cordis-config` 在 Windows 实体化的 `apps/cli/tests/profiles/acp/cordis.yml` 符号链接上失败。同步后逐项复查，只报告仍然存在的项。

## [S3] 范围

- 范围内：rc.2→rc.4 增量、A1–A10 重放、新的 entry-customization 包、`llm-deepseek` 文件合并、重新生成的产物、版本字段与分歧索引锚点。
- 范围外：`0.2.2-alpha.2` 及之后；重建丢失的同级 rc.2 合并；本仓库的任何历史改写；推送任一仓库。

## Tasks

- [ ] T1: 获取 rc.4 标签、重新测量增量并冻结路径清单（依赖：无）
- [ ] T2: 复制新增路径、删除移除路径，非分歧路径取上游内容（依赖：T1）
- [ ] T3: 对每个 PRISM-DIVERGENCE 路径做三方合并并重放 A1–A10（依赖：T2）
- [ ] T4: 复制 `ui-entry-customization`、合并 `llm-deepseek`、更新 bundle 行/依赖、重新生成产物并更新版本字段（依赖：T3）
- [ ] T5: 运行 typecheck、build、聚焦测试、无 key 快照与分歧索引检查（依赖：T4）

## [S4] 验收

- [ ] A1: 对每个非分歧改动路径，`git diff --stat dsh-v0.2.1-rc.4` 为空。
- [ ] A2: 每个 PRISM-DIVERGENCE 标记仍指向活的代码位置，分歧索引记录 rc.4 标签与新的同步点事实。
- [ ] A3: `pnpm run typecheck` 与 `pnpm run build` 通过，只留下 D7 的失败。
- [ ] A4: 版本字段为 `0.2.1-rc.4`，新包与被重命名的 `llm-deepseek` 文件通过生成的别名解析。
- [ ] A5: 会话导入与 session-log-export 的聚焦测试仍然通过，证明本 fork 自己的 Session 面在同步中幸存。
