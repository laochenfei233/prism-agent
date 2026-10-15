---
feature: install-isolation
status: in-progress
updated: 2026-10-15
branch: feat/install-isolation
commits: pending (filled at delivery)
---

# 安装隔离

[English](install-isolation.md) | 中文

## Report

交付时填充。

## [S1] 问题

整个 harness 家族的每种构建共享同一个命令面：CLI 的 npm 包名是 `@deepseek-ai/dsh`，bin 名是 `dsh`，默认 harness home 是 `~/.dsh`（`packages/util/home-paths/src/index.ts` 先解析 `$DSH_HOME`，再回落 `~/.dsh`）。一台机器上如果本 fork 与任何其他 harness 构建并存——官方发布版、`deepseek-ai/deepseek-harness` 的自建检出、或本 fork 的源码运行——两者就会混在一起：一次全局 `npm i -g` 会顶掉另一个构建的 bin，而源码运行读写的是同一批 profiles、凭据、`.env`、插件档案与会话存储。fork 的桌面端已经隔离（Tauri 产品 "Prism Agent" / bundle id `ai.prism.agent.desktop`，home 为 `$PRISM_HOME` 或 `~/.prism`，NSIS 单用户安装），所以当前的碰撞集中是安装面与数据根。

下方决策在早前会话（2026-10-15）中提出，并已在本会话由用户确认；没有一条是推断的。

## [S2] 设计

**D1 — 范围：安装产物加数据根。** 更名的面是 CLI 的 npm 包名、bin 名、CLI 默认 home，以及被这些名字改变后变假的引用。内部 workspace 命名空间 `@deepseek-ai/*` 不动——几百个包经由 tsconfig paths 与 `workspace:*` 图解析，把它们全部改名会整体作废可重放的 fork 分叉清单。桌面应用、桌面 bundled runtime 布局、`package.json` 的 `dsh.` 前缀清单键（`dsh.bundle`、`dsh.client`）、`DSH_HOME` 环境变量协议都保留原名。

**D2 — 命名。** bin `prism`，npm 包 `prism-agent`，默认 home `~/.prism`。home 与桌面端一致，一个数据根同时服务两端；`PRISM_HOME` 仍是桌面壳的覆盖变量，`DSH_HOME` 仍是子进程协议变量，所以 `~/.prism` 是两端的零配置根。

**D3 — 唯一的行为变更是默认 home。** `DSH_HOME_DIR_NAME` 变为 `.prism`；`DEFAULT_DSH_HOME_DISPLAY`、`resolveDshHome` 的 JSDoc 与 `dshHomeDisplay` 的标签一并跟随。每个入口（含桌面子进程 spawn）都已经路由到 `resolveDshHome`，源码运行的 CLI 因此不再碰 `~/.dsh`，且不存在需要第二个传参缝的问题。优级不变：显式配置路径，然后 `$DSH_HOME`，然后默认。

**D4 — 改名包周围的身份环。** CLI 包名出现在四个必须跟随的消费点：`packages/sdk/client/package.json`（导入 `./profile-boot`）与 `python/sdk-runtime/package.json` 的 `workspace:*` 依赖行；`apps/desktop/scripts/bundle-runtime.mjs` 里 bundled runtime 部署的 `--filter`；以及 `python/sdk-runtime/src/deepseek_harness_runtime/__init__.py` 的 bundled 载体 node_modules 路径拼接，其资产查找解析为 `node_modules/prism-agent/lib/bin.js`。commander 程序名 `apps/cli/src/args.ts` 的 `.name('dsh')` 变为 `prism`，录制的帮助期望 `apps/cli/tests/expected/launcher-help.txt` 随之重录，让横幅说出真实 bin 名。Python 运行时 wheel 的控制台脚本 `python/sdk-runtime/pyproject.toml` 同样由 `dsh` 改为 `prism`，其运行时解析路径跟随到 `node_modules/prism-agent/lib/bin.js`。根 README 的安装行变为 `npx prism-agent web`，CLI 包的 `repository` 指向本 fork。

**D4b — 改名的边界。** 由 fork 启动器（`apps/cli`）拥有的字符串以及本次改动触及的文档跟随 `prism`：帮助横幅与示例、风险接受命令、CLI 包自身的 README 双语文档、本改动触及的 CLI 使用指南页面、Python wheel 的控制台命令及其文档。由 harness 内核拥有的字符串——stderr 诊断前缀、应用内帮助横幅、内核 JSDoc 与包 README（以及它们喂给生成物 `config-catalog` 的行）、内核包内的指令字面量，以及更广的文档站示例——保留上游的 `dsh` 拼写；重命名那套词汇属于 harness 级品牌化而非安装拆分，已在下文列为范围外。

**D5 — 录制的解析保持上游。** `docs/dependency-catalog.json` 及其生成器（`scripts/gen-dependency-catalog.ts`、`scripts/dependency-catalog/`）记录的是已发布 `@deepseek-ai/dsh` 的 npm 闭包，且需对公共 registry 重放生成。fork 尚未发布 `prism-agent`，prism 侧无法重放录制物，它就保持为上游故事的复刻；下方区域行明确记录"刻意不动"。

**D6 — 分叉清单。** 新偏离点进入 `docs/compose/spec/fork-upstream-divergence.md` 的 A8（CLI 安装身份：包名、bin、程序名、帮助期望、README 安装行、消费端依赖行、部署 `--filter`、载体路径）与 A9（默认 harness home `.prism`）两个区域。上游同样拥有的文件在偏离构造上一行携带 `PRISM-DIVERGENCE` 标记；`package.json` 与帮助期望文件没有注释语法，这两处不设标记而只在索引中点名——单独 `rg -n PRISM-DIVERGENCE` 找不到它们，索引行会说明这一点。

## [S3] 范围

- 范围内：CLI 包身份变更、默认 home 变更、D4 的消费环、A8/A9 索引行与标记、本文档。
- 范围外：内部 `@deepseek-ai/*` 包命名空间；根 `pnpm dsh` 源码启动脚本别名（对外无名字，即 `node --import tsx/esm apps/cli/src/bin.ts`）；`docs/dependency-catalog.json` 及其生成器（见 D5）；桌面产品身份、安装器和 `runtime/dsh` 闭包目录名；Python PyPI 载体包名（`deepseek-harness-runtime-bin`）及其 SDK profile 语法（其控制台脚本随 D4 改名）；按 D4b 的 harness 内核 `dsh` 词汇，包括内核包 README、内核 JSDoc、它们喂出的生成目录行，以及本次改动触及文件之外的文档站示例（记为后续跟进，而非缺陷）；`package.json` 的 `dsh.` 前缀清单键改名；存量 `~/.dsh` 用户的数据搬迁（fork 未发布；已交付的跨 home 会话导入计划显式点名候选 home，落地时必须把 `~/.dsh` 保留为可选来源）；`plugins/` 与 `home-mods/` 下的配置与布置。

## Tasks

- [x] T1: 默认 home——`DSH_HOME_DIR_NAME` 改 `.prism`，显示与 JSDoc 文案，常量上方 A9 标记，home-paths 规格测试期望（depends: none）
- [x] T2: CLI 身份——`apps/cli/package.json` 的 name、bin、description、repository；`args.ts` 程序名加标记；重录 `launcher-help.txt`（depends: none）
- [x] T3: 消费环——`packages/sdk/client` 与 `python/sdk-runtime` 的 workspace 依赖行、`bundle-runtime.mjs` 部署过滤、`deepseek_harness_runtime` 路径拼接与报错文案、根 README 安装行（depends: T2）
- [x] T4: 分叉索引——`fork-upstream-divergence.md` 与 `.zh.md` 的 A8/A9 行、标记放置核查、`setup.rs`/`dsh_runner.rs` 注释的真实性（depends: T1, T2）
- [x] T5: 验证——逐条命令与结果记录在 [S4]（depends: T3, T4）
- [x] T6: 评审整改——Python wheel 控制台脚本、四个以旧名匹配 CLI 的仓库门禁（`verify-application-entrypoints`、`verify-default-product-isolation`、`check-workspace-constraints`、`verify-dsh-package-licenses`）、经 `dshHomePath` 的会话迁移语料默认根、各包 README 的默认 home 表述、CLI 使用指南中的命令示例（depends: T5）

## [S4] 验收

- [ ] A1: 既无 `$DSH_HOME` 也无显式配置时，构建产物中的 `resolveDshHome()` 解析为 `~/.prism`；设置了 `$DSH_HOME` 仍然优先。
- [ ] A2: 对 `apps/cli`（已构建 `lib/`）`npm pack` 产出 `prism-agent-<version>.tgz`，清单声明 bin `prism → lib/bin.js`。
- [ ] A3: 源码启动 `node --import tsx/esm apps/cli/src/bin.ts --help` 打印的横幅 usage 行写 `prism`。
- [ ] A4: `rg -n PRISM-DIVERGENCE` 报告 A8 中可标记的位点，且没有残留旧标记；`fork-upstream-divergence.md` 列出 A8 与 A9，并写明 JSON 无标记例外。
- [ ] A5: `packages/util/home-paths` 与 `args.ts` 单元段通过 vitest；双语 pair 通过 `verify-translation-pairing` 与 `verify-md-wrap`；`verify-md-links`、`verify-doc-budgets` 对本改动路径无新增失败。
- [ ] A6: 桌面 spawn 路径在代码层不被触及：`dsh_runner.rs` 传 `DSH_HOME = setup::dsh_home()`，采纳记录键仍是 bin 文件身份，因此永远不会采纳另一构建的 hub。
