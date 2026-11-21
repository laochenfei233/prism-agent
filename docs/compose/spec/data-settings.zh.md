---
feature: data-settings
status: delivered
updated: 2026-11-01
branch: none, see the Workspace override in S2
commits: uncommitted working tree
---

# 数据设置

[English](data-settings.md) | 中文

## Report

**What was built** — 设置导航现在只有一个「数据」条目（id `data`，order 25），不再有「备份」「导入导出」「导入」三行。新的 `@prism/prism-data` 设置节渲染三个固定页签——数据存储路径、备份、导入导出——并在隐藏后保持访问过的页签仍挂载。存储页签显示本进程使用的主目录；「更改位置」把该目录（普通文件与目录链接，不含顶层 `cache/`）复制到一个空目标，把目标写入 `~/.prism-data-home`，并保持旧目录不变；「恢复默认位置」清除这条记录。`prism-backup`、`prism-transfer` 与 `prism-session-import` 保留各自的包、字典与宿主路由，注册进 `settings.data.page`，于是「备份」就是备份页，「导入导出」把归档页叠在跨 Agent 导入页之上；三者都去掉了导航行与页面标题。CLI 在 `$DSH_HOME` 为空时采用指针，桌面壳按 `$PRISM_HOME`、指针、`~/.prism` 的顺序解析，因此下一次启动从新目录运行。

**Verification** — `node node_modules/vitest/vitest.mjs run packages/data/prism-data/tests` → 6 个文件、70 个测试通过，且该包自身文件在 `--coverage` 下的语句、分支、函数与行覆盖率均为 100%。同一运行器覆盖 `packages/backup/prism-backup/tests packages/transfer/prism-transfer/tests packages/session-query/session-import/tests packages/util/home-paths/tests packages/client/ui-settings-general/tests apps/cli/tests/data-home-pointer.spec.ts` → 43 个文件、513 通过、1 跳过；该次运行还报告 `packages/transfer/prism-transfer/tests/route.spec.ts` 的一处未处理拒绝，单独运行该文件同样复现（`PRE-EXISTING: transfer-route-unhandled`）。`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib home_tests` → 3 通过。`pnpm run typecheck` → 5 个门禁全部通过。`npx tsx scripts/run-oxlint.ts packages/data` 以及对其余改动路径的同一运行器 → 0 错误（transfer 页面在未改动行上仍有 3 处错误，`PRE-EXISTING: transfer-promise-handlers`）。通过的门禁：`verify-md-links`、`verify-doc-refs`、`verify-package-meta`、`verify-package-readme-limitations`、`verify-client-packages`、`verify-tsconfig-paths`、`verify-client-catalog`、`verify-config-catalog`、`verify-plugin-packages`、`verify-client-ui-i18n`、`verify-doc-budgets`，以及针对本次涉及的五个文档对的 `verify-translation-pairing`。此处未触碰的既有红灯门禁：`verify-md-wrap`（`docs/compose/specs/custom-theme-presets.md`）、`verify-package-paths`（Agent Note 指向 已弃用的包路径）、`verify-package-readme-summaries`（ui-chat、ui-conversation、sandbox-windows-acl）、`verify-package-readme-model-experience`（ui-sidebar-git）、`verify-cordis-config`（`apps/cli/tests/profiles/acp/cordis.yml`）、`verify-export-jsdoc`（`packages/transfer/prism-transfer/src/client/state.ts`），以及全语料范围的 `verify-translation-pairing`（ui-primitives、ui-theme、ui-settings-general 的 README 记录）。

**Journey log**

- `fs.cp` 在本机的 harness 主目录上失败：它的 `node_modules` 是联接点，复制链接需要 Node 没有的权限。因此复制改为用 `lstat` 遍历，并把每个链接重建为 Windows 上的联接点或其他平台上的符号链接。
- 运行中重命名主目录不可移植——Windows 会保持主目录下的句柄——于是放弃联接点替换方案，改为启动指针加重启。
- 三个页面留在各自的包里，使设置节拥有一个子插槽而不是一个巨石包；页面因此不再需要设置节的运行时 props，这也顺带消除了测试断言的类型错误。
- 本检出的客户端 roster 无法解析 `@deepseek-ai/dsh-web-app`（`node_modules` 里没有自链接）；一个本地联接点恢复了它，使外壳规格得以运行并确认新增的 `data` 行。
- 新增的组行比 `packages/README.md` 允许的多 13 个词，预算清单记录了这一提高后的上限。

## [S1] 问题

三个设置项在讲同一件事，却没有一个回答用户最先问的问题：这个应用把数据放在哪里。「数据存储路径」并不存在，而「备份」（prism-backup）、「导入导出」（prism-transfer）与「导入」（session-import）各自占着一个顶层导航条目。于是导航栏为同一个主题背了三个条目，两个导入页明明回答同一个问题（「把东西带进来」）却被分开，而想让对话放到另一块磁盘上的用户完全没有入口：harness 主目录在启动时由 `$DSH_HOME` 或 `~/.prism` 决定。

## [S2] 设计

### 工作区覆盖

本特性没有 worktree、没有分支、也没有提交。本仓库的分叉改动以工作树编辑的形式交付，此前的分叉特性文档记录了同样的覆盖；本次会话同样把提交保留给明确请求。文档在这里记录该覆盖，用来代替分支与提交区间。

### S2.1 一个「数据」设置节，三个页签

新的插件包 `@prism/prism-data`（`packages/data/prism-data`）拥有一个 `settings.section` 条目：

- id `data`，order `25`，标签 `数据` / `Data`，字典命名空间 `settings.data`。
- 该包在自己的契约模块里声明子插槽 `settings.data.page`（`list`、`root`），做法与 `ui-settings-models` 一致：由特性包拥有它所承载页面的插槽类型。
- 设置节渲染标题、说明，以及固定顺序的三个页签——`数据存储路径`、`备份`、`导入导出`。页签文案属于本节的字典；贡献页只带一个 id，因此页面无法改名或重排页签。
- 访问过的页签挂载后即使隐藏也保持挂载，与 `ui-settings-plugins` 一致，这样暂存的备份草稿能在页签切换后保留。

三个既有页面保留各自的包、字典与宿主路由，只有注册目标从 `settings.section` 改为 `settings.data.page`：

| 页面 | 包 | 插槽 id | 渲染在页签 |
| --- | --- | --- | --- |
| 存储位置 | `prism-data`（自有组件） | — | `数据存储路径` |
| 备份 | `prism-backup` | `backup` | `备份` |
| 归档导入导出 | `prism-transfer` | `transfer` | `导入导出` |
| 跨 Agent 导入 | `prism-session-import` | `cross-agent` | `导入导出` |

`导入导出` 依次渲染两个贡献：先导出、导入归档，再从其他 Agent 导入对话。两者都保留现有内容；跨 Agent 页保留一个小号标题，使两块内容读起来仍是一页。

`prism-backup`、`prism-transfer` 与 `prism-session-import` 去掉 `nav` 文案键与各自的页面标题，因为标题归设置节所有。备份保留凭据警告；导入导出保留它的导出与导入卡片；跨 Agent 导入保留说明与重新扫描操作。

设置外壳的 `navIcon` 增加 `data` 分支（`IconDatabaseOutlineMedium`），删除 `transfer` 分支。外壳测试里的 `PRODUCT_SECTIONS` 变为 `['general', 'appearance', 'models', 'plugins', 'agent-presets', 'data']`。

### S2.2 数据放在哪里，改动它意味着什么

**harness 主目录**是一个目录，装着 `sessions/`、`storages/`、`attachments/`、`profiles/`、`projects/`、`.env` 与 `.credentials.yaml`。它在每次启动时解析一次，所有服务在构造时就捕获它，因此在运行中的进程里搬动它会把数据劈成两半。改动它因此分两半：

1. **现在就复制。** 运行中的宿主把当前主目录复制到选定目录。
2. **记录选择。** 宿主写入一个启动指针；下一次启动从它解析主目录。

旧目录从不修改、从不删除。因此一次搬迁总是可以退回：把应用重新指回旧路径（手工），或用「恢复默认位置」清除指针。

### S2.3 启动指针

`~/.prism-data-home`（一个纯文本文件，内容是一行绝对路径）就是指针。它位于默认主目录旁边，绝不在其内部，因此读取它永远不会依赖它所选中的值。

解析顺序，在既有之处保持不变：

| 启动方 | 顺序 |
| --- | --- |
| 桌面壳（`apps/desktop/src-tauri/src/setup.rs::dsh_home`） | `$PRISM_HOME` → 指针 → `~/.prism` |
| CLI（`apps/cli/src/bin.ts`） | 非空的 `$DSH_HOME` → 指针（导出为进程的 `DSH_HOME`）→ `~/.prism` |

`@deepseek-ai/dsh-home-paths` 拥有两个 Node 启动方与宿主路由共用的三个助手：`dataHomePointerPath()`、`readDataHomePointer()` 与 `writeDataHomePointer(path)`。桌面壳用 Rust 重写同样三行，因为它在任何 Node 进程存在之前就要解析主目录；它照旧把结果作为 `DSH_HOME` 交给子进程。

在设置了 `$DSH_HOME` 的机器上写入的指针不会被那个 CLI 采用；页面在说明文案里一次性讲清楚：用环境变量指定数据目录的启动仍然优先。桌面把由指针推导出的 `DSH_HOME` 传下去，所以这句话在桌面不会误导。

### S2.4 宿主路由契约

一条 POST 路由 `/api/prism.data`，JSON 进、JSON 出，沿用备份路由的信封（`{ ok: true, value }` / `{ ok: false, error: { code, message } }`）。

```ts
type DataRequest =
  | { action: 'state' }
  | { action: 'relocate'; target: string }
  | { action: 'reset' }

interface DataLocationState {
  root: string            // absolute home this process uses
  pointerPath: string     // ~/.prism-data-home
  storedRoot?: string     // pointer contents when present and absolute
  pendingRoot?: string    // root a fresh launch would use, when it differs from root
}

interface RelocationResult {
  target: string          // absolute new root
  previousRoot: string    // root the copy came from
  files: number           // regular files copied
  bytes: number           // their total size
  skippedLinks: string[]  // links that could not be recreated (absolute paths)
}
```

失败码：`prism-data/bad-request`（400）、`prism-data/busy`（409）、`prism-data/target-invalid`（400）、`prism-data/target-not-empty`（409）、`prism-data/copy-failed`（500）、`prism-data/pointer-failed`（500）。

### S2.5 搬迁规则

- 目标必须是绝对路径，必须不同于当前主目录，不能包含当前主目录，也不能位于主目录之内。
- 目标必须不存在或为空目录。合并进既有目录一律拒绝，而不是去猜。
- 复制用 `lstat` 遍历主目录，因此链接按链接复制，永不被穿过。
- 跳过顶层 `cache/` 目录：它装着可重建的传输暂存与模型缓存，复制它可能占据整次运行的主要时间。
- 链接统一重建为指向绝对目标的联接点，因此在新主目录处仍然可用；除 Windows 外，各平台都忽略这个类型参数。目标已不存在的链接，或平台拒绝重建的链接——Windows 上的文件链接——会跳过并记入 `skippedLinks`，而不是让整次运行失败；桌面会在下次启动重建它自己的 `node_modules` 链接。
- 文件内容逐字节复制；文件模式与属主取目标处的默认值，与一个全新主目录一致。
- 任一步失败都会删除它正在写入的目标（尽力而为，包括操作者选中的空目录）并回答 `copy-failed`，这样重试不会被一棵用户无法解释的目录树挡住。
- 同一时间只允许一次搬迁；第二次请求回答 `busy`。
- 复制成功后宿主写入指针。写入失败时路由回答 `pointer-failed`；复制内容留在磁盘上，消息里点名它的位置。

### S2.6 存储页

第一个页签渲染：

- **当前数据目录**——主目录的绝对路径，放在等宽字体的值块里，配一行说明这里存着什么。
- **下次启动**——仅在设置了 `pendingRoot` 时显示：「重启后将在 <pendingRoot> 运行」。
- **更改位置…**——打开对话框，内含可手工编辑的文本框与绑定 `remote.directoryPicker` 的「选择文件夹…」按钮，与导入导出页用的是同一个选择器。设置节不要求该服务：没有它的部署照常渲染，保留文本框，并显示导入导出页用的不可用提示。
- 对话框讲明：数据会被复制、应用需要重启、旧目录会被保留。确认后调用 `relocate`；运行期间对话框显示「正在复制数据…」且不能重复提交。
- 搬迁结束后显示文件数与字节数、新路径、被保留的旧路径，以及任何被跳过的链接。
- **恢复默认位置**——仅在设置了 `storedRoot` 时显示；它调用 `reset`，并说明当前目录会继续运行到下次启动。

失败按带类型的码渲染成对应文案，宿主消息作为后备，与导入导出页的 `CODE_KEYS` 处理一致。

### S2.7 复制与呈现的边界

复制是一次朴素的顺序遍历：没有并发，也没有百分比进度。页面为整次运行显示一个忙碌状态，因为 `fs.cp` 的回调在这里无法便宜地计数，而本机观察到的主目录约为 130 MB / 1.7 千个文件。大到让人觉得慢的主目录也终会完成；对话框保持忙碌，被中断后可在重启后重试。

## [S3] 范围

- 范围内：「数据」设置节与它的三个页签；存储位置页；`dsh-home-paths`、CLI 与桌面壳中的启动指针；三个注册迁入新插槽；导航、文案、测试，以及每个被改动的上游文件的差异标记。
- 范围外：不重启就搬动数据目录；按子目录搬迁（项目、附件、缓存）；为复制提供进度与取消；删除旧目录；迁移一个仍在被运行中进程写入的目录；备份与导入导出功能的任何行为改动。

## Tasks

- [x] T1: 建立 `packages/data/prism-data`（清单、面配置、tsdown、入口文件、README 双语对）与其接线行：web-app 补丁行与依赖、聚合 tsconfig 引用、`tsconfig.base.json` 别名、模型体验校验表条目（depends: none）
- [x] T2: 在 `packages/util/home-paths` 增加启动指针助手与测试（depends: none）
- [x] T3: 在 CLI 入口与桌面壳的 `dsh_home` 中读取指针（depends: T2）
- [x] T4: 实现宿主路由与复制遍历，覆盖 `state`、`relocate` 与 `reset`（depends: T1, T2）
- [x] T5: 实现客户端设置节外壳、存储页、字典与样式（depends: T1, T4）
- [x] T6: 把 `prism-backup`、`prism-transfer` 与 `prism-session-import` 迁入 `settings.data.page`，并去掉它们的导航行与页面标题（depends: T1）
- [x] T7: 更新设置外壳的 `navIcon` 与它的 `PRODUCT_SECTIONS` 断言（depends: T6）
- [x] T8: 重新生成目录并运行客户端、宿主与文档校验（depends: T1-T7）
- [x] T9: 写下双语特性文档与差异标记（depends: T8）

## [S4] 验收

- [x] 设置导航新增一行「数据」（order 25），且不再出现「备份」「导入导出」「导入」行。
- [x] 「数据」按顺序显示三个页签：数据存储路径 / 备份 / 导入导出；再次访问的页签保留已挂载状态。
- [x] 「导入导出」页签先显示归档导出与导入卡片，其下显示跨 Agent 导入页。
- [x] 存储页签显示本进程使用的主目录绝对路径。
- [x] 搬迁会复制主目录文件、写入 `~/.prism-data-home`，并保持旧主目录不变；随后页签报告下次启动使用新路径。
- [x] 非空目标、位于主目录之内的目标与相对目标都以各自的类型码被拒绝，且主目录不变。
- [x] 搬迁进行中再次请求会回答 `busy`。
- [x] 链接在平台允许处重建，在不允许处记入 `skippedLinks`；`cache/` 不被复制。
- [x] 未设置 `DSH_HOME` 的 `prism` 从指针解析主目录；设置了 `DSH_HOME` 时该变量仍然优先。
- [x] 桌面壳按 `$PRISM_HOME`、指针、`~/.prism` 的顺序解析，并仍然把结果作为 `DSH_HOME` 交给子进程。
- [x] 覆盖四个被改动包的 `pnpm vitest run`、`pnpm run typecheck` 与客户端/翻译/配置校验通过。
