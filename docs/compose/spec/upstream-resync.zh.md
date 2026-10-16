---
feature: upstream-resync
status: designed
updated: 2026-10-15
branch: none yet; the workspace gate is described in S2 (stage A runs in the sibling checkout)
commits: pending
---

# 上游再同步（dsh 0.2.x）

[English](upstream-resync.md) | 中文

## Report

交付时填充。

## [S1] 问题

本仓库无法合并上游：`master` 持有的是 harness 树的孤儿基线导入，也没有 `upstream` 远端，所以对它执行 `git merge` 结构上不可行（该历史由 [fork-upstream-divergence.md](fork-upstream-divergence.zh.md) S1 记录）。唯一能合并上游的是姊妹检出 `../deepseek-harness`（`laochenfei233/deepseek-harness`），它的历史与上游有共同祖先；本仓库随后通过重新导入该树并重放分叉索引来更新。

两棵树已经相距很远。我们的基线对应上游约 `46a7f68b09`（2026-10-01 记录的上游参照）；上游 `master` 现为 `86a402200d`，即 `dsh-v0.2.1-alpha.4` 的发布合并，其间经过 0.1.7-rc.2、v0.2.0-rc.2 与 0.2.1-alpha.1 到 alpha.4。自我们锚点测得的增量是 2670 个提交（1981 个非 merge）、9819 个文件、+481527/−170588 行。姊妹检出的 `master`（`65359876b9`，工作树干净）已经合入上游 `d743267388`（0.2.1-alpha.2），并带有四个本地提交——`862f102f17` 把 fork 的 Tauri 壳移到 `apps/desktop-tauri`、`bafb0f3abf` 换取 WebView cookie 的启动令牌、`84235bd728` 回退客户端 `FishLogo` 的 viewBox、`65359876b9` 内联大体积 esbuild 转换输入——因此它剩余 737 个提交、3622 个文件、+142747/−18213。

这次同步携带的行为变化深入到 fork 自己的记录。上游 v0.2.0-rc.2 **整体移除运行时不变式插件**（`@deepseek-ai/dsh-invariants`、每个 `<package>/invariant` 子路径导出，以及 `sdk-minimal` 的五条行），反转了本仓库仍在陈述的一条规则，并删除了其文档计数的不变式文件。`agent-instructions` **移除 `dshHome` 配置字段**，改为通过 `resolveDshHome()` 解析 harness home——正是本 fork A9 改动所编辑的同一个解析点。CLI 与 Python 运行时**收窄安装依赖**（hook 桥与 webhook 包对离开默认安装），`schedule` 组合包退役，另有一个子路径插件展示清单与账号登录改动落地。会话格式**不变**：三棵树里 `SESSION_FORMAT_VERSION` 都是 `4`，已提交的代际仍然可读，本次同步不要求持久化迁移。

## [S2] 设计

**阶段 A 在姊妹检出 `../deepseek-harness` 执行；阶段 B 在本仓库执行。** 本文档是两阶段共同的交接件：阶段 A 的任务（T1、T2）写成一个在该项目中工作、没有其他上下文的 agent 可直接执行的形式；阶段 B（T3–T7）在阶段 A 报告合并 SHA 后于本仓库执行。

**D1 — 合并前重新测量。** 记录的靶标 `86a402200d` 是设计时快照。执行时在姊妹检出 `git fetch upstream` 并重算增量（`git rev-list --count <last-sync>..upstream/master`）；若上游已越过 alpha.4，则刷新合并靶标与下文的碰撞计数，并在同一次交付里更新本文档的实测事实。

**D2 — 阶段 A：在姊妹仓合并。** 把 `upstream/master` 合并进姊妹仓的 `master`（向前合并，不是 rebase——姊妹分支是共享的）。设计时干跑（`git merge-tree --write-tree master upstream/master`，2026-10-15）恰好报告四个冲突文件；执行时的重跑是第一个任务，任何新增冲突都按同样的两条规则处理：

| 冲突文件 | 解决方式 |
| --- | --- |
| `pnpm-workspace.yaml` | 这是 fork 的 A4 偏离与上游编辑相遇：取上游文件，然后再次从 `patchedDependencies` 删除 `'@electron/osx-sign@1.3.3'` 行并删除其 patch 文件，因为姊妹仓的 Tauri 壳仍然让该 patch 未被使用。 |
| `THIRD_PARTY_NOTICES.md` | 从合并后的树重新生成，绝不手工合并。 |
| `pnpm-lock.yaml` | 重新生成（清单合并后跑 `pnpm install`），绝不手工合并。 |
| `scripts/check-workspace-constraints.ts` | 合并两侧规则：上游演进出的检查加上姊妹仓自己的新增；若姊妹的编辑已被上游取代，以上游为准并在姊妹的合并提交信息里记录这次取舍。 |

解决后，在提交合并之前运行姊妹仓的构建与关键门禁（其 `AGENTS.md` 点名的 `pnpm run build` 与门禁集），然后记录合并提交 SHA。除非用户要求，不要推送。

**D3 — 阶段 B：按分类重新导入。** 在本仓库，取姊妹仓合并后的树，用 [fork-upstream-divergence.md](fork-upstream-divergence.zh.md) S2 的探测对每条路径分类：上游没有 = 新增（整条复制），blob 相同 = 不是偏离（取上游），blob 不同 = 偏离（以上游为起点重放标记或区域行点名的内容）。区域清单就是重放清单，并由下文碰撞表扩展。

**D4 — 实测碰撞表（设计时，自 `46a7f68b09` 起）。** 重放 A1–A9 遇到的上游改动如下；计数是触及各文件的上游提交数。

| 区域 | 上游改动量 | 重放动作 |
| --- | --- | --- |
| A1 桌面 | `apps/desktop/**` 290 个文件 | 用我们的 Tauri 壳整体替换上游的 Electron 应用，重新施加 A1 标记与 desktop-startup-latency 的第 1、3 层。上游的 Electron 44.7.0 升级属于它们的线，不属于我们。 |
| A2 客户端品牌 | `packages/client` 1676 个文件；`locale/en.ts` 1 个提交、`FishLogo.tsx` 0 个提交 | 取上游文件并重新施加品牌化；品牌面相对整个包动得少得多。 |
| A3 启动解析器 | `profile.ts` 17 个提交、`resolver.ts` 4 个提交 | 活跃文件：在上游新版本之上重新施加目录列表门禁与四个回归测试。 |
| A4 pnpm patch 行 | `pnpm-workspace.yaml` 13 个提交 | 导入后重新删除 osx-sign 行与 patch 文件（阶段 A 也已处理）。 |
| A5 插件与 profile home | `plugins/**`、`home-mods/**` 上游不存在 | 原样复制；继续排除 `home-mods/.credentials.yaml` 与 `home-mods/.anonymous-user-id`（现已在 gitignore 中）。 |
| A6 fork 独有文档 | 上游不存在 | 原样复制。 |
| A7 进行中的导入 | 已落地进历史（`b4593d01`） | 从索引中移除该区域；导入不再进行中。 |
| A8 CLI 安装身份 | `apps/cli/package.json` 30 个提交，多数是实验组合变化下的依赖变动 | 上游保持 `@deepseek-ai/dsh` / bin `dsh`：改名仍是 fork 偏离。在上游新的依赖列表之上重新施加包名、bin、程序名、帮助期望、网关行与四个门禁。 |
| A9 默认 home | `home-paths` 1 个提交（新增 `.agents` 共享根与 `DSH_AGENTS_HOME`，纯增量） | 在上游新增之上重新施加 `DSH_HOME_DIR_NAME = '.prism'` 与其 JSDoc。上游对 `agent-instructions` 的 `dshHome` 移除与我们是同向的：我们对该包的 README/注释编辑会落在字段已消失的新文件上。 |
| A10 上游 CI 套件 | `.github/workflows/**` 46 个提交 | 导入后再次删除 `.github/workflows/desktop-sync.yml`：该定时任务拉取上游、合并并推送，在本仓库被禁止（孤儿基线无法合并；同步属于本交接件）。 |

**D5 — 行为反转是被消费的，不是被对抗的。** 不变式机制由上游移除，本 fork 不重新加入：重新导入会删除不变式文件，并整体采用上游更新的规则与文档，包括 `AGENTS.md`。本仓库自己的文档（CAPABILITY-PLAN.md 的计数、规则文本）凡仍在描述不变式层的，在同一次交付里更新。同一原则适用于退役的 `schedule` 组合包、收窄的安装依赖与子路径插件展示清单：fork 消费上游状态，只保留索引点名的偏离。

**D6 — 生成物与录制输出跟随各自的生成器。** 第三方声明、依赖/配置/工具目录与启动器帮助期望都重新生成，绝不手工合并。录制的会话快照按上游的量移动（数百个文件）；重放后 fork 按测试政策重录自己的快照用例，并在接受前 diff 无密钥回放。

**D7 — 记录同步点。** 重放交付时，[fork-upstream-divergence.md](fork-upstream-divergence.zh.md) 在其 S4 第 1 步区域（"take stock" 锚点）新增新的上游参照 SHA 与姊妹合并 SHA，使下一次再同步从那里测量。版本字段（现为 `0.1.7-rc.1`）在同一次交付中跟随上游发布线。

## [S3] 范围

- 范围内：姊妹检出的阶段 A 合并、重新导入、按 D4 碰撞表的 A1–A9 重放、生成物重生成、快照重录、分叉索引更新、本文档定稿与版本字段。
- 范围外：任何为本仓库添加上游远端或合并路径的尝试（按设计结构上不可行）；推送任一仓库分支（属于单独的、显式收尾动作）；把上游 Electron 桌面工作搬进 Tauri 壳（超出 A1 标记点名的部分）；重新加入已移除的不变式机制或退役组合包；[install-isolation.md](install-isolation.zh.md) D4b 已列为范围外的文档站 `dsh` 词汇清扫。

## Tasks

- [ ] T1: 阶段 A——在 `../deepseek-harness` 中 `git fetch upstream` 并把 `upstream/master` 合并进 `master`；按 D2 冲突表解决，并处理 D1 重新测量发现的任何增量；运行姊妹仓的构建与关键门禁（depends: none）
- [ ] T2: 阶段 A——提交合并，记录合并 SHA 与合并进的上游 SHA，并把两者回报给本仓库的工作会话（depends: T1）
- [ ] T3: 阶段 B——重新导入姊妹仓合并后的树，用 S2 探测对每条路径分类（depends: T2）
- [ ] T4: 阶段 B——按 D4 碰撞表重放 A1–A10，放置标记，并移除 A7（depends: T3）
- [ ] T5: 阶段 B——重新生成生成物并重录 fork 的快照用例；更新仍在描述已移除机制的文档（depends: T4）
- [ ] T6: 阶段 B——运行 [dsh-pre-push-checks](../../../.agents/skills/dsh-pre-push-checks/SKILL.md) 点名的仓库门禁，逐条记录命令与 PASS/FAIL/PRE-EXISTING（depends: T5）
- [ ] T7: 阶段 B——更新 [fork-upstream-divergence.md](fork-upstream-divergence.zh.md)（S4 的新同步锚点、重放中学到的区域行）并定稿本文档（depends: T6）

## [S4] 验收

- [ ] A1: 姊妹检出的 `master` 包含 `upstream/master` 的尖端（合并提交存在，`git merge-base --is-ancestor upstream/master master` 退出 0）且工作树干净；其构建与关键门禁通过，仅剩已记录的基线失败。
- [ ] A2: 本仓库的树满足 D4 表的每条路径：碰撞计数涉及的文件携带上游新内容加点名的 fork 重放，经文件检查与 `rg -n PRISM-DIVERGENCE` 列出索引点名的每个位点验证。
- [ ] A3: `SESSION_FORMAT_VERSION` 仍为 `4`，两个 home 下的已提交代际都能被合并后的目录解码（无密钥回放套件即为检查）。
- [ ] A4: 已移除机制缺席而非被重新加入：`rg -l "dsh-invariants|/invariant"` 找不到活跃接线，且计数过它们的文档（含 CAPABILITY-PLAN.md）在同一次交付中更新。
- [ ] A5: 生成物自洽：目录 `--check` 模式通过、第三方声明与其生成器一致、启动器帮助期望与重生成的横幅一致（`prism`）。
- [ ] A6: 版本字段跟随上游发布线，且 [fork-upstream-divergence.md](fork-upstream-divergence.zh.md) 记录新的上游与姊妹 SHA 作为下一次锚点。
