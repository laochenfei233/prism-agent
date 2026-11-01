---
feature: fork-upstream-divergence
status: delivered
updated: 2026-10-29
branch: 无，见 desktop-startup-latency.zh.md（S2）的工作区覆盖
commits: 未提交的工作区改动
---

# 与上游的偏离索引

[English](fork-upstream-divergence.md) | 中文

## Report

**What was built** — 为「本检出相对 `deepseek-ai/deepseek-harness` 的全部偏离」建立单一索引，使后续的上游更新不必先读功能文档就能逐处重放。索引分两半：每个偏离点上的 `PRISM-DIVERGENCE` 注释，以及本文档——它把这些点归入十个区域，并说明每个区域的重放动作（A8 与 A9 随 [install-isolation.md](install-isolation.zh.md) 加入；A10 随 [upstream-resync.md](upstream-resync.zh.md) 加入）。其中四个区域改写或删除上游拥有的内容：桌面应用（上游是 Electron 壳，本树是 Tauri 壳）、客户端品牌、启动解析器的目录列表门禁，以及 `pnpm-workspace.yaml` 中的 `@electron/osx-sign` 行（上游仍在声明，本树删掉它，因为 Tauri 壳让这个 patch 变成未被使用）；其余区域新增上游没有对应物的路径。标记文本为 `PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).`，因此 `rg -n PRISM-DIVERGENCE` 就是机器索引。

**Verification** — 交付时（2026-10-01）`rg -n PRISM-DIVERGENCE` 列出 17 个标记位置：其中 11 个指向本文档，6 个指向 [desktop-startup-latency.md](desktop-startup-latency.zh.md) 的 S5，而那一节又指回本文档；这对文档里另有 4 处行文提到该标记，但它们不是标记。截至 2026-10-15，索引中指向本文档的标记为 32 个，指向延迟文档的仍为 6 个，新增位点即 A8 与 A9 两个区域。S2 中的每一条路径断言都用同级检出 `bafb0f3abf` 探测过（该检出的 `upstream` 远端是 `deepseek-ai/deepseek-harness` 的 `46a7f68b09`）：那里 `apps/desktop` 是 408 个 Electron 文件且没有 `src-tauri`，`packages/boot/app-boot` 与 `packages/client` 与本检出基线的 blob 相同，`patchedDependencies` 仍含 `'@electron/osx-sign@1.3.3'`，而 `plugins`、`design-assets`、`docs/compose`、`CAPABILITY-PLAN.md`、`packages/cron`、`docs/subsystems/cron.md` 都不存在。`verify-md-wrap` 在新 pair 上通过，`verify-translation-pairing` 报告三个变更 pair 一致。

**Journey log**

- 仓库无法与上游合并——master 只有一条孤儿基线导入，也没有 `upstream` 远端，基线与 `deepseek-ai/deepseek-harness` 没有共同祖先——所以只存在于工作树的偏离，对下一个执行导入的人是不可见的。
- 桌面端工作不止存在于这里。同级检出 `../deepseek-harness`（`laochenfei233/deepseek-harness`，`origin` 与 `gitea` 指向该 fork，`upstream` 指向 `deepseek-ai/deepseek-harness`）的历史确实会合并上游，因此重放可以先在能合并的地方调和，再由本仓库重新导入结果。
- 工作树里自 2026-09-27 起躺着一批未完成的导入（cron、path-lock、speech-to-text-dashscope、ui-cron、cron-controller），它们既不在本仓库的基线提交里，也不在同级检出里；把它们标成 fork 偏离会把重放引向错误的文件，所以 S2 把它们列为进行中的导入。
- 品牌化深入上游拥有的文件，而不是只新增文件：本树删除 `FishLogo.tsx`、重写 `BrandWordmark.tsx` 与两份客户端语言字典、新增 `PrismLogo.tsx` 与 `PrismBadgeLogo.tsx`，因此只按目录复制客户端包的重放只能带上新增的那部分。
- `apps/desktop/README.md` 仍声称 fork 不修改任何上游 `packages/` 代码，而列表门禁与客户端品牌化已经让这句话不再成立；S2 是更正后的记录，那句话本身留给它的所有者处理。

## [S1] Problem

`master` 只有两个提交——把 harness 树导入为孤儿基线的那一条，以及其后的规格定稿——并且仓库没有 `upstream` 远端：`gitea` 与 `github` 指向 `laochenfei233/prism-agent-e`，`mimocode` 指向 `XiaomiMiMo/MiMo-Code`。因此基线与 `deepseek-ai/deepseek-harness` 没有共同祖先，`git merge` 无法对上游执行，上游更新只能以「整棵树被替换」的形式到来。凡是 fork 改过、而新树同样持有的文件，都会在替换中消失，除非有人手工重新施加；而 fork 确实改动了上游拥有的文件：桌面应用被换成了另一套框架，客户端品牌改写了上游组件，启动解析器带上了目录列表门禁。

没有书面索引时，这种重放等于考古。2026-10-01 的工作树有 197 个已修改的受跟踪文件、51 个未跟踪路径和 4 处删除——其中大部分来自一次未完成的上游导入以及与它无关的进行中改动——而对偏离点的唯一书面记录只是 [desktop-startup-latency.md](desktop-startup-latency.zh.md) 的一节，只覆盖那一个功能。重放者只有两个糟糕的选择：读完所有功能文档去找改动，或者在两棵没有共同历史的树之间做 diff，再自己分辨哪些是 fork 的改动、哪些是新上游自己的变化。

桌面端工作不止存在于这里。同级检出 `../deepseek-harness`（`laochenfei233/deepseek-harness`，`origin` 与 `gitea` 指向该 fork，`upstream` 指向 `deepseek-ai/deepseek-harness`）的历史会合并上游，其中带有 `apps/desktop/**`，所以桌面与品牌两个区域可以先在能合并的地方调和，再由本仓库重新导入结果。

## [S2] Design

### The marker

标记是偏离点上的一行注释，使用该文件自身的注释语法：`PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).` 完全由 fork 拥有的路径把它放在第 1 行；上游同样拥有的文件则把它放在偏离结构的上方，与 [desktop-startup-latency.md](desktop-startup-latency.zh.md) 标记其三个启动点的方式一致。用早先文本写下的标记指向那份文档，而它的 S5 又指回本文档。`rg -n PRISM-DIVERGENCE` 会打印完整索引；功能文档里提到该标记的句子本身不算标记，因此读者能把索引与对索引的引用区分开。

### How one path is classified

面对一棵候选上游树，每条路径只落入三类中的一类。第一条探测在路径于上游不存在时会把参数原样打印回来，这正是第一类的信号：

```sh
git -C ../deepseek-harness rev-parse <upstream-ref>:<path>
git hash-object <path>
git -C ../deepseek-harness rev-parse <upstream-ref>:<path>   # blob, when the path resolves
```

- 上游不存在：新增。整条复制本树的路径，没有需要对账的内容。
- 上游存在且 blob 相同：不是偏离。保留上游的文件，并在 fork 副本带有标记时去掉标记。
- 上游存在且 blob 不同：偏离。以上游的文件为起点，重新施加它的标记所指明的改动。

### Areas

| Area | Paths | What a replay must do |
| --- | --- | --- |
| A1 桌面应用 | `apps/desktop/**`——Tauri 壳、`src-tauri/**`、`ui/dist` 打包产物、`scripts/bundle-runtime.mjs`，以及带标记的 README 对 | 用本目录整体替换上游的 Electron 应用，然后重新施加 [desktop-startup-latency.md](desktop-startup-latency.zh.md) 的第 1、3 层与标记所指名的壳改动；导入还要剔除由卫星目录自身拥有的 Electron 卫星——不上 `apps/desktop-host/**` 与它的 `apps/cli/tests/desktop-host.e2e.ts` 测试，`desktop-test-auth-popup` 升级指南与 `.agents/notes/**` 下的 Electron 打包、更新与公证笔记保持删除，更早的再同步正是这样处理它们的；检查项是 `apps/desktop/src-tauri` 下的 `cargo test` 与壳脚本的 `node --check` |
| A2 上游包内的客户端品牌 | `packages/client/locale/src/locales/en.ts` 与 `zh.ts`、`packages/client/ui-primitives/**`（删除 `FishLogo.tsx`，重写 `BrandWordmark.tsx` 与图标测试，新增 `PrismLogo.tsx` 与 `PrismBadgeLogo.tsx`）、`packages/client/ui-brand-official/**`、`packages/client/ui-theme/**`（含新增的 `builtin-themes.ts` 与 `client/gallery.ts`）、`packages/client/ui-sidebar/**`、`packages/client/ui-layout/**`、`packages/client/ui-conversation/**`、`packages/client/web/**`，以及 `apps/web/**`（页面标题、manifest、favicon、PWA 测试） | 每个被改写的文件都以上游副本为起点重新施加品牌化，保留新增的 Prism 文件，并以客户端各包的单元测试与快照测试作为检查；这些品牌面不带标记，在此点名：`apps/web` 的页面标题、manifest、scaffold、vite 配置、boot-page 期望与 PWA 测试；`ui-brand-official` 的 README 对、`Brand.tsx` 与桶导出索引；`ui-primitives` 的 README 对与桶导出索引；`ui-sidebar` 的 README 对、`SidebarRoot.tsx`、`SidebarRoot.module.css`，以及提到 Prism 资产的渲染快照行；`ui-theme` 的 README 对；`ui-conversation` 的 `EmptyHero.tsx` |
| A3 启动解析器的目录列表门禁 | `packages/boot/app-boot/src/profile.ts`、`packages/boot/app-boot/src/profile-resolution/resolver.ts`、`packages/boot/app-boot/tests/profile.spec.ts` | 以上游文件为起点重新施加 `DirectoryListings` 代码块、`packageDirFromAnchor` 内的门禁，以及返回 `realModuleDirectory(path)` 的 `canonicalPath`；[desktop-startup-latency.md](desktop-startup-latency.zh.md) 的 S5 逐行列出这些内容，少传 `listings` 参数编译器会直接报错，四条回归测试就是检查 |
| A4 pnpm workspace 的 patch 行 | `pnpm-workspace.yaml` 与它删除的 patch 文件：`patches/@electron__osx-sign@1.3.3.patch`，以及自 2026-10-16 再同步起的 `patches/app-builder-lib@26.17.0.patch` | 从 `patchedDependencies` 中删掉 `'@electron/osx-sign@1.3.3'` 与 `app-builder-lib@26.17.0`，并删掉它们指向的 patch 文件；两者都属于 Electron 打包链，Tauri 壳替换后 pnpm 会判为未使用而硬失败（`ERR_PNPM_UNUSED_PATCH`）；每次导入后、任何 `pnpm install` 之前都要重做，检查项是安装能读到 store 而不是因未使用 patch 失败 |
| A5 树外插件与 profile home | `plugins/**`（`aegis`、`dsh-agent-progress`、`prism-about`、`prism-guardrails`、`prism-meeting`、`prism-memory`）与 `home-mods/**` | 原样复制插件目录与该 profile home，但不要复制 `home-mods/.credentials.yaml`：它保存凭据且未被忽略 |
| A6 Prism 独有的文档与资产 | `design-assets/**`、`docs/compose/spec/**`、`CAPABILITY-PLAN.md`、`MIMOCODE-REFERENCE.md` | 原样复制；上游没有对应物，这里不会有冲突 |
| A7 进行中的导入 | `packages/cron/**`、`packages/api/cron-controller/**`、`packages/client/ui-cron/**`、`packages/util/path-lock/**`、`packages/experimental/speech-to-text-dashscope/**`、`docs/subsystems/cron.*`、`apps/cli/config/examples/cron/**`、`.agents/notes/proposed/feature/2026-09-26-cron-scheduled-tasks.*` | 不是 fork 偏离：先让这次导入落地，再在合并后的树上重新施加 A3 与 A4，并标注新树自身带来的变化 |
| A8 CLI 安装身份 | `apps/cli/package.json` 与 `apps/cli/tests/expected/launcher-help.txt`（JSON 与录制期望没有注释语法，所以本行是它们的帐目）、在程序名与入口文档处标记的 `apps/cli/src/args.ts` 与 `apps/cli/src/bin.ts`、`apps/cli/src/plugin.ts` 里的风险接受指令、`packages/sdk/client/package.json` 与 `src/launch.ts`（resolve 处标记）、`python/sdk-runtime/package.json` 与 `src/deepseek_harness_runtime/__init__.py`（载体路径处标记）、`apps/desktop/scripts/bundle-runtime.mjs`（部署过滤处标记）、`python/sdk-runtime/pyproject.toml`（控制台脚本，其上方标记），以及四个以名字匹配 CLI 的仓库门禁（`scripts/verify-application-entrypoints.ts`、`scripts/verify-default-product-isolation.ts`、`scripts/check-workspace-constraints.ts`、`scripts/verify-dsh-package-licenses.ts`，各自在规则处标记）、`README.md`（含中文对照件）的 npm 运行小节（HTML 注释里标记）、`tsconfig.base.json` 的源码面别名（其上方标记）、`scripts/release/families.ts`（命名守卫与 `installedEntry`，两处均标记），以及 `scripts/publish-npm-baseline.ts`（条目钉住处标记） | 把 CLI 包名改为 `prism-agent`，bin 与程序名改为 `prism`，并随动横幅、usage、示例、风险接受命令、消费端依赖行与 `import.meta.resolve` 规格、部署过滤、载体的 `node_modules/prism-agent/lib/bin.js` 路径；`scripts/dependency-catalog/` 里录制的解析保持上游（`prism-agent` 未发布）；harness 内核的 `dsh` 词汇（内核 JSDoc、包 README、它们喂出的目录行、stderr 诊断、应用内帮助横幅）保持上游拼写；只有安装面与用户键入的命令名（含风险接受命令）跟随 `prism`；重录 `launcher-help.txt`：运行 `node --import tsx/esm apps/cli/src/bin.ts --help`；Python wheel 的控制台脚本改为 `prism`，PyPI 载体包名保持不变；特性文档是 [install-isolation.md](install-isolation.zh.md)，其 D4b 拥有该边界；安装重命名还触及了没有注释语法的文件，在此点名：`apps/cli` 的 `dump-config-schema.ts`、`dump-config.ts`、`profile-boot.ts`、`plugin.spec.ts`、`web-agent-presets.e2e.ts`；`.github/workflows/desktop-release.yml`；`docs/user/guide/network-proxy.*`、`docs/user/guide/python-sdk.*` 与 `docs/cookbook/adding-a-session-format-version.*`；`python` 的 README 对、`development.*`、`sdk/README.*`、`sdk/examples/README.*`、`sdk/tests/test_release_version.py`；`packages/{attachment/attachment-local,credentials/credentials-local,identity/anonymous-user-id,shell/shell-env,skill/skill-filesystem}/` 的 README 对与各自偏离的 `src/` 或 spec 文件；`packages/sdk/client` 的 README 对与 `launch.spec.ts`；`packages/util/home-paths` 的 README 对；以及钉住重命名命令的 `scripts/*.spec.ts` 期望（`build-exe-for-python-sdk`、`check-workspace-constraints`、`gen-official-bundle-catalog`、`release/families`、`translation-pairing`、`verify-default-product-isolation`） |
| A10 上游 CI 套件 | `.github/workflows/**` | 导入的 workflow 套件归上游所有；本仓库每次导入后删除 `desktop-sync.yml`，因为该定时任务会拉取 `deepseek-ai/deepseek-harness`、合并并推送——在本仓库被禁止：孤儿基线不可能合并，同步由 [upstream-resync.md](upstream-resync.zh.md) 的交接件负责。其余 workflow 按导入保留；它们的去留是待定决策（GitHub 仓库当前启用 Actions，下次推送即会运行它们） |
| A9 默认 harness home | `packages/util/home-paths/src/index.ts`（`DSH_HOME_DIR_NAME` 上方标记）、其 `tests/home-paths.spec.ts`，以及 `apps/desktop/src-tauri/src/setup.rs` 与 `apps/desktop/src-tauri/src/dsh_runner.rs` 里的 home 注释（`setup.rs` 在 `dsh_home` 处标记） | 默认 home 改为 `~/.prism` 而非 `~/.dsh`；优先级（配置路径、然后 `$DSH_HOME`、然后默认值）与 `DSH_HOME` 变量名不变；桌面端已显式传 `DSH_HOME`，行为不受影响；对应规格是 [install-isolation.md](install-isolation.zh.md) |

## [S3] Scope

- 范围内：每个偏离点上的一处标记、本索引，以及两种语言里加到 [desktop-startup-latency.md](desktop-startup-latency.zh.md) S5 的全仓索引行。
- 范围外：任何提交——在收尾动作被选定前，改动都留在工作树里；让进行中的导入落地；与本次无关的工作树改动；`apps/desktop/README.md` 中那句过时的话；以及 `design-assets/` 下既有的配对缺口。

## Tasks

- [x] T1: 在 A1 的桌面各点、A2 的品牌点与 A4 的 workspace 行加上标记
- [x] T2: 本文档、其中文对照件与配对记录
- [x] T3: 在 `desktop-startup-latency.md` 及其对照件中加上全仓索引行
- [x] T4: 对变更的 pair 重跑文档门禁
- [ ] T5: 本索引的收尾动作（见 S3，待定）

## [S4] Replay checklist

**同步锚点（2026-10-29）：** 上一次再同步把上游 `dsh-v0.2.1-rc.2..dsh-v0.2.1-rc.4` 增量（发布提交 `504a01a957`）以测定的 stage-B 重放直接落到 master（[upstream-resync-rc4](upstream-resync-rc4.zh.md)）：11 个非合并提交、649 个路径，逐路径以 rc.2 blob 为合并基分类。它重放了 A1 的 `apps/desktop-host` 卫星排除与 A2 在 `ui-sidebar`、`ui-primitives` 的品牌行，并确认 A3、A4、A9、A10 的文件未被此次增量触及、无需重放。下一次再同步从 rc.4 tag 起测量；tag 从 `laochenfei233/deepseek-harness` 的 gitea 镜像获取，因为姊妹检出的对象库是 `blob:none` 部分克隆，无法打包传输。

1. 先在本仓库盘点：`git status --porcelain` 与 `rg -n PRISM-DIVERGENCE`，并在动其他东西之前决定进行中的导入（A7）怎么办。
2. 在能合并的地方调和：在 `../deepseek-harness` 中 `git fetch upstream` 并合并 `upstream/master`，在那里重新施加 A1 到 A4——在那里它们都是普通提交。
3. 把该树重新导入本仓库，然后用 S2 的探测对 A1、A2、A3、A5、A6、A8、A9 的每条路径分类：新增的整条复制，偏离的以上游文件为起点手工重新施加。
4. 在跑任何安装之前先重做 A4，否则 `pnpm install` 会以 `ERR_PNPM_UNUSED_PATCH` 失败。
5. A3 放到最后重做，因为新树可能改过同一个解析器文件；然后运行 [desktop-startup-latency.md](desktop-startup-latency.zh.md) S4 记录的 `tsc` 与 app-boot 命令。
6. 重新施加标记：`rg -n PRISM-DIVERGENCE` 必须列出 A1 到 A4 以及 A8 与 A9 中可注释文件的每一处，且没有任何标记指向新树已删除的路径；A8 的 `package.json` 与帮助期望两处只存在于索引行。
7. 原样复制 A5 与 A6，然后重跑 `verify-md-wrap`、对变更 pair 的 `verify-translation-pairing`、`verify-md-links`，以及 `apps/desktop/src-tauri` 下的 `cargo test`。

## [S5] Related documents

- [install-isolation.md](install-isolation.zh.md) — A8 与 A9 的特性文档（CLI 安装身份与默认 home）。
- [upstream-resync.md](upstream-resync.zh.md) — 下一次上游再同步的交接件（在姊妹检出合并、重新导入、重放 A1–A9）。

- [desktop-startup-latency.md](desktop-startup-latency.zh.md)——启动门禁与 hub 采纳，以及 A3 的逐文件清单。
- [desktop-client.md](desktop-client.zh.md)、[desktop-port-resilience.md](desktop-port-resilience.zh.md)、[cli-pnpm-resolution.md](cli-pnpm-resolution.zh.md)、[desktop-single-hub-sweep.zh.md](desktop-single-hub-sweep.zh.md)——A1 所承载的桌面功能。
- `archive-import-prism-agent-e.md`——孤儿基线是如何产生并推送的（该文档只有英文版）。