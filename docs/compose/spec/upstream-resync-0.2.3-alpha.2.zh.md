---
feature: upstream-resync-0.2.3-alpha.2
status: in-progress
updated: 2026-11-24
branch: resync/upstream-0.2.3-alpha.2
commits: pending
---

# 上游同步 0.2.3-alpha.2

[English](upstream-resync-0.2.3-alpha.2.md) | 中文

## Report

**交付内容** —— 本 fork 从上游 `dsh-v0.2.2-rc.1` 到 `dsh-v0.2.3-alpha.2`（提交 `4b399c39a6`）的内容级同步：`git merge-tree --write-tree --merge-base dsh-v0.2.2-rc.1 master dsh-v0.2.3-alpha.2` 一次性算出合并树（上游 3935 个提交、9508 个变更路径、451 个碰撞路径），碰撞与分歧区域正在 `.worktrees/upstream-resync-0.2.3-alpha.2` 的 `resync/upstream-0.2.3-alpha.2` 分支上解决，最终以单亲提交落地——上游提交不进入 fork 历史。下一次同步以 `dsh-v0.2.3-alpha.2` 作为显式 `--merge-base` 锚点。

**待办事项** —— 本文档随落地提交一起交付；完整的解决清单、验证结果与 divergence index 锚点更新在交付时补记于此。

## Journey log

- merge-tree 的输出本身是干净的；几乎全部手工工作量来自整图 `tsc -p tsconfig.host.json` 编译暴露的测试侧漂移——它能看见逐包 `tsc -b` 编译看不见的跨包类型漂移。逐包结果互相矛盾时，用 `-p` 编译当仲裁。
- 上游在 alpha 窗口里重构了多个包的家（credentials→account、experimental→interaction/extensions/team、subagent 拆分）。别名行与 workspace 依赖对着合并后的树校验（只有目标仍存在的行才保留），生成的别名区域由 `gen-tsconfig-paths` 重新生成。
- alpha.2 的 typert 分析器为合并接口增加了 face-purity 检查：每个声明部分必须住在已注册的贡献包里。fork 的 cron 服务包成为贡献者（`@typert service cron` + `./typert` 导出 + `files` 行）；wiki 与 autonomy 包保持未注册，因为宿主图里没有东西导入它们，遍历永远不会到达它们的声明。
- cron/wiki/autonomy/meeting/microcompact 的服务在各自的包加入宿主图后变得对 catalog 与 doc-graph 投影可见；它们的 SERVICE_PAGE 行与服务角色被（重新）加入，陈旧的遍历豁免被移除。
- fork 2026-11-05 的持久化记录写于 alpha.2 之前的内联格式，新的历史解析器会拒绝它；已按当前清单以规范的 keyed-node 布局重新生成，其确认过的 digest 也更新到当前 schema。

## [S1] 问题

fork 跟随上游的内核、包与文档，但其历史是孤儿导入：上游提交永远无法合并，因此上游的每个版本都必须以内容级树合并的方式重放，并手工重放 fork 的分歧区域。上游已推进到 `0.2.3-alpha.2`，而每个触及上游变更代码的 fork 面——client UI 包、生成的目录、门禁、CLI 身份、桌面壳的排除项——都需要在不丢失 fork 身份与特性的前提下拿到这份增量。

## [S2] 设计

### S2.1 —— 合并方法

`git merge-tree --write-tree --merge-base dsh-v0.2.2-rc.1 master dsh-v0.2.3-alpha.2` 一次算出完整内容合并；结果落地到 `resync/upstream-0.2.3-alpha.2`，在树内解决冲突，再以单亲提交合入。非碰撞路径自动取胜出方。451 个路径的碰撞集是手工工作量：241 个 modify/delete 路径（fork 已删除的树——Electron 链、`apps/desktop-host`、`apps/desktop-publisher`、上游 workflows）裁决为保持删除，208 个 modify/modify 路径按内容解决。

### S2.2 —— 碰撞解决规则

1. 带 `PRISM-DIVERGENCE` 标记的路径：以 `dsh-v0.2.2-rc.1` blob 为合并基准做三方内容合并，把标记指示重放到上游内容上。
2. 无标记的 fork 侧改动（README 双语对、生成目录、bundle 行、spec 页）：内容合并，然后重跑所属生成器，让生成文件落在「上游生成器输出 + fork 输入」上。
3. `.github/workflows/*`：fork 只保留自己的三条 Prism 桌面管线（`desktop-release.yml`、`desktop-publish.yml`、`windows-package.yml`）；每条导入的上游 workflow 裁决为删除，包括上游新增的（A10）。
4. 上游删除：接受删除；悬空的 fork 引用重新指向（bundle 行、目录、tsconfig 别名）。
5. `pnpm-lock.yaml`：取上游的，随后在 fork 的工作区包恢复后用 `pnpm install` 重新对账。
6. 别名行与工作区依赖对着合并树校验：目标包已不存在的行删除；生成别名区域由 `gen-tsconfig-paths` 重新生成。

### S2.3 —— 版本字段与生成产物

所有工作区 `package.json` 的版本字段统一到 `0.2.3-alpha.2`，包括 fork 自己的 `@prism/*` 包；`plugins/*` 保留自己的版本方案，但其 `@deepseek-ai/dsh-*` 精确 pin 移到 `0.2.3-alpha.2`，让精确版本门禁能安装它们。合并之后：`pnpm install`，然后 `gen-tsconfig-paths`、`gen-cordis-catalog`、`gen-tool-catalog`，以及输入发生变化的其余生成器。

### S2.4 —— 分歧重放

A1（Tauri 桌面替换上游 Electron 壳；`apps/desktop-host/**`、`apps/desktop-publisher/**` 与 Electron notes 保持删除）、A4（`@electron/osx-sign` 与 `app-builder-lib` 补丁行及文件保持删除）、A8（CLI 安装身份保持 `prism-agent` / bin `prism`）、A10（workflow 套件保持删除）在合并树上重放；divergence index 记录新锚点。

## Tasks

- [x] T1: 拉取上游 refs 并确认目标（`upstream/master` = `dsh-v0.2.3-alpha.2` = `4b399c39a6`）(depends: none)
- [x] T2: 把 merge-tree 输出落地到 resync 分支 (depends: T1)
- [x] T3: 删除 fork 删除树及其内的上游洁净新增（327 个路径）(depends: T2)
- [x] T4: 解决机械文件（lockfile、workspace 补丁、根与 CLI manifest、tsconfig、快照夹具、归档 notes）(depends: T3)
- [ ] T5: 按目录分批解决 208 个 modify/modify 碰撞 (depends: T4)
- [ ] T6: fork 面收敛——版本字段、插件 pin、生成器、divergence index (depends: T5)
- [ ] T7: 跑验证门禁并记录结果 (depends: T6)
- [ ] T8: 定稿本文档对、changelog 与单亲提交 (depends: T7)

## [S4] 验收

- [ ] resync 分支不含冲突标记，也不含 A1/A10 排除集的文件。
- [ ] 触及的 manifest 中每条别名行与工作区依赖都能解析到树内存在的包。
- [ ] `pnpm install` 携带 fork 的补丁依赖成功；插件 pin 通过源码级 profile 检查安装。
- [ ] `pnpm run typecheck` 通过其已知良好的聚合；既有失败记为 `PRE-EXISTING`，绝不臆断。
- [ ] divergence index 锚点指向 `dsh-v0.2.3-alpha.2`。
- [ ] 落地提交为单亲；上游提交不进入 fork 历史。
