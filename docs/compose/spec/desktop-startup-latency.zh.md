---
feature: desktop-startup-latency
status: delivered
updated: 2026-10-01
branch: 无，见 S2 的工作区覆盖
commits: 未提交的工作区改动
---

# Desktop Startup Latency

[English](desktop-startup-latency.md) | 中文

## Report

**构建内容** —— 本功能分两层。第 1 层：壳记录自己启动的 hub（`$DSH_HOME/desktop-server.json`），并在下次启动时采纳该 hub，而不是再启动第二个；判定受三重约束：CLI 入口的 runtime 身份、启动 URL 自身的端口与 token，以及回环 `GET /?token=…` 仍须返回 303。采纳在 supervisor 中先于任何 spawn 执行，对外发布的 `dsh://ready` 与 `dsh_status` 与启动出的 hub 完全相同，并跳过 `ensure_home_node_modules`、`ensure_default_plugins`、端口选择、spawn，以及约 4.1 s 的 `dsh web` 启动。"Restart service" 会先复核记录、再按 pid 结束被采纳的 hub，让 supervisor 替换它；记录会在所指的 hub 停止服务后丢弃，或在壳收尾自己拥有的那个 hub 时随之丢弃。第 3 层：解析器的前缀表改为经载体的 realpath（`realModuleDirectory`）规范化，不再走 JavaScript 的 `realpathSync`；`packageDirFromAnchor` 每次解析构建最多列一次被搜索的 `node_modules` 目录，且只依据列表所证明的内容否决候选项——不存在的目录装不下任何东西，可读目录的名字按大小写折叠匹配——`package.json` 探测始终是最终判定。在打包 runtime 上，这两处改动把 `dsh web --help` 从 3346 ms 降到 3039 ms，把冷启动到启动 URL 从 4269 ms 降到 3903 ms（三轮交替测量的最小值）。

**验证** —— `node ./node_modules/typescript/bin/tsc -p packages/boot/app-boot/tsconfig.json --noEmit` 通过。在加上差异标记与 ACL 测试修复后，于 2026-10-01 重跑 `node ./node_modules/vitest/vitest.mjs run packages/boot/app-boot`：19 个文件、5575 项通过、跳过 2 项；这两项都是本机无法构造的平台条件——POSIX 专有的权限用例，以及 `package-meta.spec.ts` 中大小写敏感文件系统的用例——而单独运行 `profile.spec.ts` 为 37 通过 | 1 跳过，`-t "probes a search path"` 在整个包上把 Windows ACL 用例报为唯一通过项，因此无法列出目录的修复在本机确实被执行；该用例也确实约束了修复——把 `isMissingDirectory` 无条件改为返回 `true` 会让它失败。同一套件在 `--coverage` 下的未覆盖位置只出现在既有基线（`compatibility-preflight.ts:57`、`profile-context.ts:67-68`，以及 `resolver.ts` 中一处向上查找分支，PRE-EXISTING），本功能代码没有未覆盖行。对三个改动文件运行 `run-oxlint` 干净。打包 runtime 的 A/B：`dsh web --help` 之前 3346/3391/3527 ms、之后 3039/3150/3165 ms，冷启动之前 4269/4301/4356 ms、之后 3903/3987/4018 ms，两侧激活日志相同。`cargo fmt --check` 干净，`apps/desktop/src-tauri` 下 `cargo test` 通过 13 项；默认跳过的跨进程测试 `DSH_DESKTOP_ADOPT_E2E="<node>|<bin>" cargo test adopts_a_live -- --nocapture` 在单独一次运行中针对打包 runtime 通过（不带该环境变量时它会提前返回）。`verify-md-wrap` 检查 2245 个文件，`verify-translation-pairing` 报告本文档配对一致。共进行三轮独立复查——两轮针对主体改动，一轮针对复查后的新增内容——三处 critical 均已修复并有测试覆盖：门禁最初缺少的大小写折叠、不得被读成空目录的无法列出目录，以及最初因 deny 指定账户名而非 Everyone SID 而毫无证明力的 Windows 回归测试。

**过程记录**

- 先测量再设计：hub 启动为 4081/4086 ms，而客户端只有 718 ms，因此渲染器从来不是目标，Electron 也据此被排除；`NODE_COMPILE_CACHE` 与 `--preserve-symlinks` 都是按实测否决，而非凭直觉。
- 采纳需要所有权证明，按进程签发的启动 token 能返回 303 就是该证明；runtime 身份检查则是因为应用更新会就地替换打包闭包。
- 复查发现"拥有一个没有子进程的 hub"会带来两个后果：壳在停驻期间退出时忘掉记录，会让仍然存活的 hub 永远无法再被采纳；采纳时缓存的 pid 会在 hub 被就地替换后立刻失效。现在两处都以记录为准：只忘掉已经停止服务的，只结束仍然能通过鉴权的。
- 列目录门禁在复查中失败两次才站住：先是按大小写敏感比较名字，在大小写不敏感的文件系统上会把已安装的包变成缺失；随后又把无法列出的目录读成空目录，丢掉了探测本可解析的包。现在列表只用于证明"不存在"，其余一律交给 `package.json` 探测。它的 Windows 回归测试本身也被查出毫无证明力——`icacls` 并不会拒绝以账户名给出的 ACE——现在改为拒绝众所周知的 Everyone SID。
- 本检出把上游作为单个基线提交导入，所以上游更新是重新导入而非合并；每处差异都带有 `PRISM-DIVERGENCE` 标记并列入 S5 表，重放时无需阅读设计文档即可找到全部位置。

## [S1] Problem

冷启动时壳的启动页要停留约五秒，而这段时间并不花在渲染上。用真实浏览器连到运行中的 hub 实测，客户端从文档加载到首帧挂载只用了 718 ms。壳启动的 hub 需要约 4.1 s 才打印出启动 URL，而在它启动期间窗口里只有启动页。如果这次启动发现上一次壳启动留下的 hub 仍在监听，它会在下一个空闲端口上重付一遍同样的 4.1 s，同时把先前那个 hub 闲置在那里。

## [S2] Design

### 实测阶段

下表数据来自本检出在 Windows 上的实测，使用打包 runtime（`apps/desktop/runtime`，Node 22.23.3），客户端数据来自连到运行中 hub 的 Playwright 浏览器。

| 阶段 | 实测 | 采集方式 |
| --- | --- | --- |
| `dsh --version`，CLI 底线 | 269 ms | 打包 runtime |
| `dsh web --help`，只组装不服务 | 3453 ms | 打包 runtime |
| `dsh web` 到打印启动 URL，全新 home | 4086 ms | 打包 runtime |
| `dsh web` 到打印启动 URL，已有 home | 4081 ms | 打包 runtime |
| 一次组装并导入的 hub 加载的脚本 | 1261 个脚本，9.0 MiB | V8 coverage |
| 采样中落在解析文件系统调用上的启动耗时 | 3277 ms 中的 1634 ms | `--cpu-prof` |
| 文档加载到客户端首帧，冷启动 | 718 ms | Playwright |
| 文档加载到客户端首帧，重新加载 | 431 ms | Playwright |

表中每一行都来自同一次会话对改动前 runtime 的读数：绝对值随机器负载变化，因此第 3 层引用的每个数字都给出同一轮运行的对照双方。

等待就是 hub 的启动，约占用户盯着启动页的时间的 85%。它的开销是围绕 profile 插件图的文件系统操作。一次启动的 5.2 s CPU profile 显示约 2.7 s 自耗时落在文件系统叶子调用上（`lstat` 839 ms、`internalModuleStat` 509 ms、`readFileUtf8` 372 ms、`existsSync` 219 ms、`readlink` 214 ms、`realpath` 157 ms），而 `dsh web --help` 会发起 3856 次文件系统调用（`realpathSync` 2499、`readFileSync` 1350），`dsh --version` 只有 177 次。组装并导入这张图就是启动本身。

### 工作区覆盖

本功能没有 worktree、没有分支、也没有提交。当前检出上还有尚未完成的他人改动，沙箱权限禁止写入 `.git`，而本次会话把提交保留给显式请求。改动以工作区编辑的形式交付，本文档以此替代分支与提交区间记录。

### 第 1 层 —— 采纳上一次壳启动遗留的 hub

壳在从子进程 stdout 解析出启动 URL 的那一刻，把它启动的 hub 记录到 `$DSH_HOME/desktop-server.json`：端口、启动 URL、pid，以及解析出的 CLI 入口及其长度与修改时间。下一次启动在启动任何进程之前先读这条记录，并在三项检查全部通过时采纳该 hub：

1. 记录中的 CLI 入口与本次壳将要运行的一致（路径、长度、修改时间都相同），因此应用更新后不会采纳由上一个闭包启动的 hub。
2. 记录中的 URL 是该端口的回环启动 URL，并携带它自己的 token。
3. 对该端口发出回环 `GET /?token=…` 会得到 303，只有当初打印该 URL 的进程会这样应答：token 属于进程，被复用的端口或外来监听者无法应答。

被采纳的 hub 在其他方面与全新启动的没有区别。supervisor 用采纳到的端口发布 `dsh://ready`，`dsh_status` 报告同样的端口与 URL，前端加载同一个带鉴权的 URL，因此客户端约定没有变化。采纳会跳过 `ensure_home_node_modules`、`ensure_default_plugins`、端口选择、spawn 以及那 4.1 s 的启动。"Restart service" 会先重读并复核记录，然后才通过 pid 结束被采纳的 hub（Windows 用 `taskkill`，其他平台用 `kill`），于是 supervisor 的端口监听把这次请求变成一次冷启动；如果记录已无法通过鉴权，壳不会去结束它，而是在空闲端口上替换它，因为被替换服务的 pid 可能已被回收。记录会在所指的 hub 停止服务后忘掉，或在壳收尾自己拥有的 hub 时随之忘掉；绝不在被采纳的 hub 仍在监听时忘掉——比壳活得更久的 hub 恰恰就是下次启动要采纳的对象。对于不指向产生该记录的端口与 token 的 URL，记录不会被写入；记录的写入也不依赖应用日志目录可写。

### 第 2 层 —— 让 hub 跨应用退出保活（已否决）

只有当 hub 比启动它的壳活得更久时，采纳才会生效；今天这种情况只包括崩溃、强制退出，或在第一个壳仍在运行时再启动一个。让 hub 比窗口活得更久，可以把之后的每次启动都变成一次采纳，从而完全消除等待；代价是窗口退出后仍留下一个 Node 进程和占用的回环端口。

产品决策是：不。本应用运行的任何东西都不得比它的窗口活得更久。退出应用仍会结束 hub，所以每次退出后的启动都是冷启动，第 1 层因此成为唯一的复用手段——它采纳的是已经在运行的 hub，没有这样的 hub 时它没有任何代价。

### 第 3 层 —— 压缩 hub 自身的启动

每次会话的首次启动都要付整个启动开销，所以启动本身就是等待。一次启动在开始服务之前会先组装 profile 并导入它的整个插件闭包：在下文交替测量的那一轮里，`dsh web --help` 只组装、只导入、不服务，却是 4269 ms 冷启动中的 3346 ms，而这次运行加载了 1261 个脚本、合计 9.0 MiB。读取与编译并不是开销所在——3277 ms 的 profile 中 `compileSourceTextModule` 占 152 ms——采样时间里有一半落在模块解析的文件系统调用上。

其中两次调用属于本仓库，都在 `dsh-app-boot`：

| 文件系统开销 | 采样耗时 | 为什么会这样 |
| --- | --- | --- |
| `canonicalPath` 调用了 `fs.realpathSync` | 351 ms | JavaScript 版 realpath 会逐段 `lstat`，而一次解析要为每个已安装包规范化一个目录，于是约 400 条路径变成约 4800 次调用 |
| `packageDirFromAnchor` 对每个候选探测 `existsSync(<candidate>/package.json)` | 129 ms | 每个声明的依赖一次探测，而多数候选指向一个并不存在的 `node_modules` 目录 |

前缀表现在通过 `realModuleDirectory` 规范化——它是载体的 realpath：在打包可执行文件之外即 `fs.realpathSync.native`，整条路径只问文件系统一次；`packageDirFromAnchor` 则在每次解析构建中只列一次被搜索的 `node_modules` 目录，并且只在列表能证明候选不存在时才否掉它：目录不存在就装不下任何东西，可读目录里的名字按大小写折叠匹配。其余候选——列表里确实存在的名字，以及进程根本列不出的目录里的候选——仍会走到 `package.json` 探测，由它决定该条目是不是一个包。每次构建各自新建列表缓存，因此下一次构建会重新读取文件系统；`loadProfileDirectory` 逐个解析各 bundle，因此会按 bundle 重复列目录——冷启动不走这条路径（它经 `createRuntimeResolution` 组装），不会付这份开销。

在打包 runtime 上以三组交替配对测量——两种构建轮流运行，使机器负载互相抵消——两侧各取最小值：

| 命令 | 之前 | 之后 |
| --- | --- | --- |
| `dsh web --help` | 3346 ms | 3039 ms |
| `dsh web` 到打印启动 URL | 4269 ms | 3903 ms |

两种构建各跑三轮并交替进行，使机器负载互相抵消，且没有任何一轮出现反转：`dsh web --help` 之前是 3346/3391/3527 ms、之后是 3039/3150/3165 ms，冷启动之前是 4269/4301/4356 ms、之后是 3903/3987/4018 ms。绝对值仍随机器负载整体变动，而两侧总是一起移动。两行数据都来自手动施加这两处改动的打包 `dsh-app-boot` 副本，因为本检出无法运行 `apps/desktop/scripts/bundle-runtime.mjs`（它通过 pnpm 部署）；该副本被 git 忽略，事后已按字节还原（sha256 `0ab71e0d…`），因此要复现这些数字需要从本源码重新构建 runtime。两种构建打印出完全相同的激活日志——各 10 行，端口、token、路径与数字均已掩码，两侧一致。

剩下的开销是 Node 对闭包中 1261 个模块自身的解析——每次导入的内部 `stat`、`realpath` 与 package scope 查找——只有把闭包预先打成一个包才能去掉，而那会改变 profile 按包名解析各行的方式。它不在本次范围内（见 S3）。

### 已否决的做法

| 做法 | 实测 | 结论 |
| --- | --- | --- |
| 用 Electron 或 Chromium 替换 WebView | 客户端只占约 4800 ms 中的 718 ms | 等待在 hub，不在渲染器 |
| 为 hub 使用 `NODE_COMPILE_CACHE` | 4066/4060/4051 ms 对比 4184/4174/4174 ms | 无收益；开销在解析，不在编译 |
| 为 hub 使用 `--preserve-symlinks` | `dsh web --help` 2846 ms 对比 3104 ms | 虽有 260 ms 收益仍否决：profile 的 `node_modules` 是 junction 时，路由层与 Node 加载器会把同一模块用两个 URL 命名 |
| 不触碰 hub 自带解析器、直接打包闭包 | 未尝试 | 剩下的是 Node 的逐模块解析，解析器并不拥有它 |

## [S3] Scope

- 范围内：记录启动出的 hub；带 runtime 身份与 token 检查的采纳判定；supervisor 中的采纳；对被采纳 hub 的按 pid 重启；在自有收尾时忘掉记录；单元测试与一个默认跳过的跨进程测试；把解析器的前缀路径改为经载体的文件系统规范化；每次解析构建只列一次被搜索的 `node_modules` 目录；本文档。
- 范围外：应用退出后继续保活 hub（第 2 层，已否决：本应用的任何东西都不得比窗口活得更久）；预打包插件闭包，它对应的是 Node 的逐模块解析，且会改变 profile 按包名解析各行的方式；采纳不是本壳启动的 hub，因为没有存储的 token 能通过它的鉴权；客户端载荷，已测量且不在关键路径上。

## Tasks

- [x] T1：记录启动出的 hub 并在下次启动采纳它——验收：`apps/desktop/src-tauri` 下 `cargo test` 通过 13 项，包含采纳判定的各个用例（覆盖：S2 第 1 层）
- [x] T2：对真实 hub 验证该约定——验收：`DSH_DESKTOP_ADOPT_E2E="<node>|<bin>" cargo test adopts_a_live -- --nocapture` 采纳一个真实的打包服务、按 pid 结束它，并停止采纳它（覆盖：S2 第 1 层）
- [x] T3：否决第 2 层——验收：受监督的 hub 仍随窗口一起结束（`dsh_runner.rs`：`stop`），且 S2 第 2 层记录了该决定（覆盖：S2 第 2 层）
- [x] T4：把解析器的前缀路径改为经载体的 realpath 规范化——验收：`profile.spec.ts`、`profile-resolution.spec.ts`、`linked-resolution-matrix.spec.ts` 通过，且打包 `dsh web --help` 的 A/B 在三轮交替测量中从 3346 ms 降到 3039 ms（覆盖：S2 第 3 层）
- [x] T5：每次解析构建只列一次被搜索的 `node_modules` 目录——验收：`skips a declared dependency whose node_modules entry holds no manifest` 通过，且整个 `packages/boot/app-boot` 套件通过 5575 项、跳过 2 项（覆盖：S2 第 3 层）

## [S4] Acceptance

- [x] 由本次构建记录、且仍以其启动 token 提供服务的 hub，会在不启动子进程的情况下被采纳（测试：`adopts_the_recorded_server_while_its_token_is_accepted`、`adopts_a_live_dsh_web_server_and_rejects_it_once_gone`）
- [x] URL、token、runtime 身份或服务本身不再匹配的记录不会被采纳（测试：`rejects_urls_that_name_another_port_or_no_token`、`rejects_a_record_whose_token_no_longer_authenticates`、`rejects_a_record_from_a_runtime_this_shell_no_longer_runs`、`reports_no_adoption_without_a_record`）
- [x] 被采纳期间执行重启会按 pid 结束该 hub 并释放端口（测试：`adopts_a_live_dsh_web_server_and_rejects_it_once_gone`、`terminate_pid`）
- [x] 仅采纳过某 hub 的壳退出后，该记录仍然保留；而该 hub 停止服务后记录被丢弃（`dsh_runner.rs`：采纳停驻处仅在 `!port_open(port)` 时忘掉）
- [x] 重启请求绝不会结束一条记录已无法通过鉴权的 pid（`dsh_runner.rs`：`request_restart` 在 `terminate_pid` 之前重跑 `adopt_decision`）
- [x] 只有已经在运行的 hub 会被复用；本壳所监督的 hub 仍随窗口一起结束（`dsh_runner.rs`：`stop`；S2 第 2 层）
- [x] 前缀表经载体的文件系统规范化，因此一条路径只花一次文件系统调用，而不是每段一次（`resolver.ts`：`canonicalPath` 调用 `realModuleDirectory`）
- [x] `node_modules` 目录存在但不含 `package.json` 的已声明依赖仍被跳过，而不会被当成已安装（测试：`skips a declared dependency whose node_modules entry holds no manifest`）
- [x] 与磁盘目录大小写不同的请求名会得到与文件系统一致的答复，因此列目录绝不会把已安装的包变成缺失的包（测试：`answers a requested name that differs in case from the installed directory as the filesystem does`）
- [x] 进程可搜索但无法列出的搜索路径交给 `package.json` 探测处理，而不会被当成装不下任何包（测试：POSIX 用 `probes a search path whose entries cannot be read rather than reporting the package as missing`，Windows 用 `probes a search path whose entries an ACL hides rather than reporting the package as missing`；Windows 用例在本机执行——`-t "probes a search path"` 在整个包上把它报为唯一通过项——两种用例只在本平台无法构造该条件时跳过）
- [x] 一次解析构建最多列一次被搜索的 `node_modules` 目录（`profile.ts`：`createRuntimeResolution` 中新建、经 `listingOf` 读取的 `DirectoryListings` 映射）
- [x] 冷启动更快到达启动 URL 且激活输出一致：之前 4269 ms、之后 3903 ms（交替测量最小值），激活日志相同（打包 runtime A/B）
- [ ] 连续启动壳两次时，第二个窗口落在第一个 hub 的端口上且不会再次启动（人工：需要 GUI 壳）

## [S5] 与上游的差异

本检出的上游 `deepseek-harness/deepseek-harness` 是以单个基线提交导入的，因此将来重新导入上游时这些文件是整体替换，而不是合并。下表是本功能引入的差异点，每一处都带 `PRISM-DIVERGENCE` 注释，所以 `rg PRISM-DIVERGENCE` 就能列出它们，不必先读本节。

全仓索引见 `fork-upstream-divergence.md`，其中列出每次重新导入上游都必须重放的全部区域。

| 文件 | 差异位置 | 重放时必须保留的内容 |
| --- | --- | --- |
| `packages/boot/app-boot/src/profile-resolution/resolver.ts` | `canonicalPath` 返回 `realModuleDirectory(path)`，上游调用的是 `fs.realpathSync` | 那一行载体 realpath |
| `packages/boot/app-boot/src/profile.ts` | 列表相关代码块（`DirectoryListings`、`DirectoryListing`、`ABSENT_DIRECTORY`、`isMissingDirectory`、`listingOf`、`listedDirectory`、`listingHolds`）与 `packageDirFromAnchor` 内的门禁 | 代码块与门禁；`collectInstallationScopePackages`、`dependencyClosure`、`collectProfileScopePackages`、`createRuntimeResolution`、`resolveBundleDir` 上多出的 `listings` 参数由它们派生，少传参数编译器会直接报错 |
| `packages/boot/app-boot/tests/profile.spec.ts` | 无 manifest 用例、大小写折叠用例，以及两条搜索路径用例（POSIX 权限、Windows ACL） | 四条都要保留，它们共同构成这道门禁的回归覆盖——列表持有的名字仍会去探测、大小写不同的名字仍能解析、无法列出的目录仍经探测解析 |
| `apps/desktop/src-tauri/src/dsh_runner.rs` | 第 1 层：`ServerRecord` 以及采纳、停驻、重启、遗忘、停止这些路径 | 整个文件的功能；它的 13 项测试就是重放验收 |
| `docs/compose/spec/desktop-startup-latency.*` | 本文档 | 无需保留，上游没有这个文件 |

`vendor/` 未被改动，因此其本地修改清单不需要新增条目。重放是否成立，以仓库根目录下 `node ./node_modules/typescript/bin/tsc -p packages/boot/app-boot/tsconfig.json --noEmit`、`node ./node_modules/vitest/vitest.mjs run packages/boot/app-boot` 通过，且 `apps/desktop/src-tauri` 下 `cargo test` 通过为准。
