---
feature: plugin-seed-refresh
status: delivered
updated: 2026-11-02
branch: feat/plugin-seed-refresh
commits: c21408d0fb..cf85f0a33b
---

# 插件播种刷新

[English](plugin-seed-refresh.md) | 中文

## Report

**What was built** — 桌面壳现在让播种进 `$DSH_HOME/profiles/node_modules` 的插件副本跟随正在运行的安装包：安装包的清单变了、副本缺少自己清单声明的入口、或记录的安装包版本变了，都会替换副本；没有入口的构建既不新建也不替换副本，链接目标一概不碰；交换先暂存新构建，失败时恢复原副本。这正是 `@prism/prism-meeting` 显示「异常」的原因：profile 副本的 `package.json` 仍写着 0.1.7-rc.1 的 peer，尽管它的 `lib/` 与安装包中的逐字节相同，加载器仍跳过该 bundle。打包现在先经检出目录的 tsdown 构建每个 `plugins/*` bundle 再复制，构建没有产出声明入口时以包名报错，并先清空再跳过本检出无法构建的包（`plugins/prism-meeting`，其源码不在本仓库）。插件页对由应用提供文件的插件给出真正可行的补救：更新应用后重启，而不是卸载重装。

**Verification** — `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib seed_tests`（`CARGO_TARGET_DIR` 指向主检出的 target）→ 9 通过。`node --check apps/desktop/scripts/bundle-runtime.mjs` → 无问题。一个临时脚本调用导出的打包辅助函数：构建并复制 `prism-pocket`（32706 B）、`prism-local-models`（60033 B）、`prism-session-autoarchive`（7534 B）到 `apps/desktop/runtime/plugins/*/lib/index.js`；预先植入的 `runtime/plugins/prism-meeting` 被清掉并按包名跳过；构建不产出声明入口的样板以包名失败。`node node_modules/vitest/vitest.mjs run packages/client/ui-plugin-manager/tests` → 6 个文件、263 个测试。`pnpm run typecheck` → 5/5 门；`pnpm run build:check` → 2/2。`npx tsx scripts/run-oxlint.ts apps/desktop/scripts packages/client/ui-plugin-manager` → 0 错误。`verify-md-links` 通过，`verify-translation-pairing` 与 `verify-md-wrap` 对本改动涉及的文件无报告。其余为既有红灯、本改动未触碰：`verify-md-wrap`（`docs/compose/specs/appearance-themes.md`、`custom-theme-presets.md`）、`verify-translation-pairing`（`packages/client`、`ui-primitives`、`ui-theme`、`ui-settings-general` 的 README 记录）、`verify-repository-references`（既有 `.changelog` 片段与 `python/sdk/uv.lock`）、`verify-concrete-terms`（`plugins/prism-search/src/fusion.ts`）、`verify-package-readme-summaries`（`ui-chat`、`ui-conversation`、`sandbox-windows-acl`）、`verify-package-readme-model-experience`（`ui-sidebar-git`）、`scripts/doc-standard.spec.ts`（`packages/backup/prism-backup/README.zh.md`），以及全仓 `lint`（别处 383 条）。

**Journey log**

- profile 副本的 `lib/` 与安装包逐字节相同，所以失败看起来像播种字节问题；兼容性读的是清单里的 peer 范围，真正的因由是那份陈旧的 `package.json`。
- 本地 bundle 在 pnpm workspace 之外，仓库构建从不构建它们。让打包在不可构建的 bundle 上直接失败，也会让 `prism-meeting` 卡住失败——本仓库不跟踪它的源码，于是复制步骤改为先清空目标再按包名跳过。
- 原先在系统临时目录里开 scratch 的测试，在这台机器的 harness 下开始以 `EACCES` 失败；现在在 crate 的 `target/` 下开。
- junction 用例在 `mklink` 失败时会静默通过；现在它要求 junction 真的建成，评审又补了悬空链接的用例。

## [S1] Problem

应用升级之后，插件管理页把 `@prism/prism-meeting` 标为「异常」；同时 `@prism/prism-pocket`、`@prism/prism-local-models`、`prism-session-autoarchive` 三个随包插件根本没有构建出的 `lib/`。

问题不在构建字节里。对已安装的 web profile 运行 `dsh --dump-config`，输出 `skipping profile bundle "@prism/prism-meeting": Error: Plugin @prism/prism-meeting@0.1.0 is incompatible with dsh 0.2.1-rc.4: requirements {"@deepseek-ai/dsh-llm":"0.1.7-rc.1","@deepseek-ai/dsh-speech-to-text":"0.1.7-rc.1","@deepseek-ai/dsh-storage-domain":"0.1.7-rc.1","@deepseek-ai/dsh-tools":"0.1.7-rc.1"}`；而 profile 里那份副本的 `lib/index.js` 与 `lib/client.js` 与安装包中的逐字节相同（SHA-256 相等）。兼容性读的是副本 `package.json` 的 peer 范围，那份清单仍写着 0.1.7-rc.1，加载器于是跳过该 bundle，`listBundles` 报出 `incompatible-version` —— 正是页面上渲染的那个标签。

造成这一状态的有两个缺陷：

1. 壳只在目标不存在时才把随包插件播种进 `$DSH_HOME/profiles/node_modules/<package>`（`ensure_local_bundles`、`ensure_market_bundle`）。升级因此会把旧清单、或一份不可用的副本永久留在原地。同一份陈旧让 `aegis`（2.10.8，peer 为 `^0.1.0-rc.6`）与 `@prism/prism-memory`（0.2.2 却带 0.1.7 的 peer）也被跳过，而 `@prism/prism-pocket` 的那份副本压根没有 `lib/index.js`。
2. `plugins/*` 不在 `pnpm-workspace.yaml` 里，`pnpm run build` 从不构建它们，`lib/` 又被 gitignore，`apps/desktop/scripts/bundle-runtime.mjs` 只复制检出目录里恰好存在的东西。上述三个包就这样在没有 `lib/` 的情况下随包发行，从它们播种出的每一份副本都无法加载。

## [S2] Design

### S2.1 壳持有的插件副本跟随安装包

`$DSH_HOME/profiles/node_modules/<package>` 是壳维护的扁平模块回退目录：已安装的运行时把本地 bundle 放在 `<resources>/runtime/plugins/<dir>`，位于自身模块闭包之外，加载器靠这个目录解析它们的裸包名。因此这份副本是安装包的投影，安装包的构建一变，它就被替换。

出现下列任一情况即替换已播种的副本：

- 目标不存在（首次启动；创建失败仍然中止启动，与今天一致）；
- 目标缺少它自己 `package.json` 声明的入口（`main`，否则 `index.js`）；
- 目标的 `package.json` 与安装包中的逐字节不同；
- 记录中的安装包版本与 `<resources>/runtime/prism/package.json` 里的不同，此时一次应用升级会刷新每一份已播种副本。

出现下列任一情况则保留副本，且不新建副本：

- 安装包自己那份缺少声明的入口。这个尚未构建的包既不得替换一份能用的副本，也不得播下一份无法加载的副本 —— 正是这条守卫让三个未构建包没有毁掉可用的 profile 副本，它保留下来；
- 目标是链接（pnpm 的 `link:` 投影或开发者做的 junction）。透过它写会落进另一个检出目录。

替换是分步的：先把安装包的构建复制到同级的暂存目录，再把现有副本改名让位，最后把暂存目录改名到位。换位失败会恢复原副本，因此任何失败都不会留下被删了一半或缺失的 bundle，新构建删掉的文件也不会残留。换位失败不阻断启动；安装包保持未记录，下次启动重试。`$DSH_HOME/profiles/.seeded-runtime` 记录最近一次整体对齐的安装包版本。

本地 bundle、市场 bundle（`dsh-plugin`）与 Windows 终端检测器副本共用一个辅助函数，因此「只复制一次」这个根因只修一处。

### S2.2 打包先构建每个本地 bundle，并拒绝缺入口的包

`bundle-runtime.mjs` 在复制之前构建本地 bundle：凡带 `tsdown.config.ts` 的 `plugins/<dir>`，都用检出目录自带的 tsdown 构建（`node_modules/tsdown`，工作目录设在该包）。构建没有产出声明入口时，打包以包名报错，三个未构建的 bundle 因此变成打包错误，而不是一次发行。

复制步骤随后在控制台按包名跳过那些本检出压根产不出入口的包，而不是随包发行一个无人能导入的包；它还会先清掉上一次打包留在 `runtime/plugins` 里的东西。`plugins/prism-meeting` 就是这种情况：本仓库只跟踪它的清单、patch 与 README，只有当打包所用的检出本来就带着 `lib/` 时它才存在。

被跳过的包会让 profile 继续选中这个名字：升级过的 profile 保留早先安装包播下的副本，加载器把这个 bundle 当作不兼容而跳过，而插件页的「更新应用」补救也清不掉它 —— 因为本检出的任何发行都不再带这个包。恢复这些源码、或把该包安装进 profile，不在本次改动范围内。

不使用各包自己的 `build`/`bundle` 脚本：在 workspace 之外，`pnpm run` 找不到本地 `node_modules/.bin`，并会先自动安装该目录。两个脚本名跑的都是 tsdown，而它正是每个随包插件声明的构建器。

### S2.3 插件页给出随包插件真正可用的补救

`managementText` 新增 `appProvided` 输入。对文件不由 profile 拥有的 bundle（`installed === false`，只可能是安装包副本或一个 bundle 选择），`incompatible-version` 的结尾补救改为 `reasonIncompatibleAppProvided` —— 更新应用后重启即可加载随包的版本 —— 而不是「卸载后重新安装」；对 profile 无法安装的包，页面原先给的正是后者。逐包的版本要求句子保留。

## [S3] Scope

- 范围内：桌面播种（`apps/desktop/src-tauri/src/setup.rs`）、桌面运行时打包（`apps/desktop/scripts/bundle-runtime.mjs`）、插件管理页的不兼容补救（`packages/client/ui-plugin-manager`）、桌面 README 的打包说明。
- 范围外：改变 `evaluatePluginCompatibility` 或 bundle 解析顺序；刷新用户自己安装的包；插件页里「重新播种」的动作；市场自身的更新流程；把 `plugins/prism-meeting` 的源码恢复到本仓库。

## Tasks

- [x] T1: `setup.rs` 里一个播种/刷新辅助（`copy_is_stale`、`replace_dir`、`is_link`），供本地 bundle、市场 bundle 与终端检测器副本共用（covers: S2.1）
- [x] T2: 安装包版本记录，让升级刷新每一份已播种副本（covers: S2.1）
- [x] T3: 基于临时家目录的单元测试：陈旧清单、缺入口、未构建的源保留副本、绝不替换链接、版本记录强制刷新（covers: S2.1）
- [x] T4: `bundle-runtime.mjs` 复制前构建本地 bundle，并在缺声明入口时失败（covers: S2.2）
- [x] T5: `ui-plugin-manager` 的随包补救、词典条目与页面测试（covers: S2.3）
- [x] T6: 桌面 README 打包说明与验证轮（depends: T1, T2, T3, T4, T5）

## [S4] Acceptance

- [x] A1: 与安装包 `package.json` 不同的 profile 副本被整体替换，且被删掉的文件不再残留（T1, T3）
- [x] A2: 缺声明入口的 profile 副本，在安装包那份有入口时被替换（T1, T3）
- [x] A3: 安装包那份缺声明入口时，profile 副本原样保留，本没有副本的 bundle 也不新建副本，且该 bundle 名称仍被选中（T1, T3）
- [x] A4: junction 或符号链接目标绝不被替换（T1, T3）
- [x] A5: 安装包版本变化时刷新每一份已播种副本一次，并记录该版本（T2, T3）
- [x] A6: 打包为 `prism-pocket`、`prism-local-models`、`prism-session-autoarchive` 产出 `lib/index.js`，且复制步骤把它放进 `apps/desktop/runtime/plugins/`（T4）
- [x] A7: 构建没有产出声明入口时，打包以该包名失败（T4）
- [x] A8: 对 profile 不拥有的不兼容 bundle，页面渲染随包补救而非卸载补救（T5）
- [x] A9: `cargo test --lib setup::` 通过，`node --check apps/desktop/scripts/bundle-runtime.mjs` 通过，插件管理页测试通过（T6）
- [x] A10: 本检出产不出入口的包按包名跳过，且不被复制（T4）
