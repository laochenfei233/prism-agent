---
feature: desktop-single-hub-sweep
status: delivered
updated: 2026-10-29
branch: feat/desktop-single-hub-sweep
commits: c64d35c4..5be9dc96
---

# Desktop Single-Hub Sweep

[English](desktop-single-hub-sweep.md) | 中文

## Report

**What was built** — 壳现在先结束对手 hub，再决定由哪个 hub 服务自己。`is_our_dsh_web_server` 按装机闭包路径（`runtime/prism/lib/bin.js`，Windows 安装与 macOS app bundle）或本 checkout 构建好的 CLI（`prism-agent/apps/cli/lib/bin.js`，含 linked worktree）识别 hub，匹配前先转小写并归一分隔符；`rival_pids` 是纯决策核；枚举在 Windows 上读 `Get-CimInstance`（输出 UTF-8）、在 macOS/Linux 上读 `ps`，受 3 秒预算约束；`sweep_rival_servers` 在收养时与每次冷启前结束除被收养 pid 外的所有命中，debug 构建跳过。原版 dsh、Easel、手动启动的 `prism web` 与姊妹 `deepseek-harness` checkout 绝不命中；两个 release 安装与 POSIX 信号的限制写在 S3。桌面 README 的 hub 契约、端口弹性规格的范围说明、启动延迟规格的 S5 行与分叉索引，都与本文档一起记录了这一改动。

**Verification** — 以下命令均在 worktree 的 5be9dc96（基线 c64d35c4）上运行：

- `apps/desktop/src-tauri` 下的 `cargo fmt --check` — PASS。
- `apps/desktop/src-tauri` 下的 `cargo test` — PASS，17 项通过、0 失败。两个清场测试与 CIM 解析测试在 Windows 上运行；`ps_sample_parser_accepts_ps_output` 在此编译掉，由 macOS/Linux CI 运行。
- 针对含 `C:/Users/陈/...` 的 `node.exe` 命令行做 PowerShell 编码探针——带前缀的查询输出合法 UTF-8 且保留完整命令行；不带前缀的输出不是合法 UTF-8，说明修复是必需的。
- 五个改动对上的 `pnpm run verify-translation-pairing` — PASS。
- `pnpm run verify-md-wrap` — PASS，2074 个文件。
- `pnpm run verify-md-links` — PASS，2034 个文件。
- `git diff --cached --check` — 每个提交都干净。
- 接线核对——`dsh_runner.rs:140` 的 `sweep_rival_servers(None)` 位于 141 的 `spawn_child` 之前；236 的 `sweep_rival_servers(Some(record.pid))` 位于 237 的 `self.port.store` 之前。
- 独立评审——第一轮发现编码 bug、无上限的枚举与四个范围问题；聚焦复核通过了编码修复、3 秒预算与每一条 S3 裁决，只剩本次收尾。

**Journey log**

- 评审的字节探针抓到了单元测试抓不到的问题：PowerShell 5.1 的重定向输出使用控制台代码页，中文用户名会让 `ConvertTo-Json` 的字节不是合法 UTF-8，清场静默失效。查询现在先设置 `[Console]::OutputEncoding`，非 ASCII 路径进入了 CIM 解析测试。
- 清场位于启动路径上，因此枚举是一个带 3 秒预算的 `kill_on_drop` 子进程。被放弃的枚举不可能结束壳刚启动的 hub，因为击杀循环只消费一次已完成枚举的目标。
- 范围按产品而不是按安装或按 home 划定：匹配通用的 `deepseek-harness/apps/cli` 会结束原版 dsh 用户的 server，而两个闭包路径不同的 release 安装被记录为不支持的并发，而不是互杀。
- 一次清场无法持久阻止受监督的对手壳重启它的 hub：每次启动只能重新确立一个 hub，仍在运行的开发壳会再造一个，而两个闭包路径不同的安装正是 S3 记录的限制。

## [S1] Problem

每次壳启动，要么收养 `$DSH_HOME/desktop-server.json` 指向的 hub，要么在 3081..=3131 里挑第一个空闲端口新起一个 `dsh web`。这个决策唯一读取的证据就是那条记录，因此「活着但不可收养」的 hub 对它不可见：死掉的壳留下的孤儿（记录已被覆盖）、从被替换的运行时闭包启动的 hub、并行启动的实例，以及装机版旁边开发壳自己的 hub。它们服务同一份 `~/.prism` 会话存储，而会话写者锁对每个会话只允许一个写者，于是竞态中输掉的那个窗口报 `session/writer-held` —— 这正是 Easel 壳撞上、并通过在每个决策点结束自家对手 server 修掉的「被另一个 dsh 占用」。

端口回退还把这个分裂藏了起来：`select_port` 把新 hub 挪到 3082，壳显示一切正常，两个 hub 继续共用一个 home 活着。桌面 README 的端口契约已经允许 3081..=3131 的扫描吸收「外来监听者」，但它对「第二个 Prism hub」没有答案。

## [S2] Design

### S2.1 产品范围内的进程签名

`is_our_dsh_web_server(command_line)` 只有在三个条件同时成立时才接受一条命令行：

- 含有 `bin.js`。
- 含有连续参数对 ` web --port`，即 `spawn_child` 构造的形式（`<bin> web --port <port> --no-open`）。
- 命名了本产品启动 hub 的两条路径之一：`/runtime/prism/`（装机闭包 —— Windows 上是 `<install>/runtime/prism/lib/bin.js`，macOS 上是 `Prism Agent.app/Contents/Resources/runtime/prism/...`），或者 `prism-agent/` 与 `/apps/cli/` 同时出现（本 checkout 及其 linked worktree，`resolve_runtime` 的开发回退正是从这里解析构建好的 CLI）。

命令行先转小写、再把反斜杠归一成 `/`；Windows（`CIM`）与 macOS（`ps`）于是共用一条规则。CIM 原样返回带引号的映像路径（`"C:\...\bin.js" web --port ...`），所以标记按彼此独立的子串匹配，而不是天真的连续 `bin.js web`。

这三个条件从构造上把其他 harness 构建挡在清场之外：原版 `deepseek-harness` 的 hub（`.../runtime/dsh/lib/bin.js`）、Easel 的 hub（`.../easel-dsh/runtime/dsh/lib/bin.js`）和无关的 Node server 都不带任一产品路径标记。用户手动起的 CLI server（`prism web`、`pnpm dsh web` —— `apps/cli/src/bin.ts`，常常是相对路径且不带 `--port`）也不匹配；壳按契约把 3080 留给它，所以这条边界是刻意的，S3 记录在案。

### S2.2 决策核

`rival_pids(samples, keep)` 就是整个决策，不碰进程 I/O，因此可测：所有命令行匹配 S2.1 的采样 pid，除了 `keep`。supervisor 在即将收养已校验的 hub 时传 `Some(record.pid)`，在即将冷启时传 `None`。`keep` 指向不存在的进程只是少一项豁免，其余对手照清。

### S2.3 进程枚举

Windows 通过 `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 枚举并取 `ProcessId, CommandLine`（`wmic` 在当前 Windows 上已弃用）。`ConvertTo-Json` 把单条结果渲染成裸对象、多条渲染成数组，两种形态都接受。PowerShell 5.1 的重定向输出使用控制台代码页，因此查询在运行前先把 `[Console]::OutputEncoding` 设为 UTF-8；否则非 ASCII 安装路径会让 JSON 不是合法 UTF-8，清场静默失效。枚举受 3 秒预算约束：超时会杀掉枚举进程并按空结果处理，卡住的 shell 不能把启动页拖住。枚举失败返回空列表：漏掉对手的代价是下一次启动再清一遍，而起不来的代价是整个窗口。macOS 与 Linux 解析 `ps -axo pid=,command= -ww`；`-ww` 关掉终端宽度截断（否则 ` web --port` 尾巴会被切掉），pid 列是右对齐的，所以前导空格要去掉；`ps` 列出所有进程，只靠签名判定，无关进程必须把自己的参数写成产品路径加 CLI 形式才可能命中，命中后就会被结束。

### S2.4 接线与时序

- `adopt_running_server` 在记录的启动 token 通过校验之后、发布收养端口之前，以 `Some(record.pid)` 清场。
- `supervise` 在冷启路径上、`spawn_child` 之前以 `None` 清场，于是 `select_port` 能看到刚释放的端口，新 hub 回到 3081 而不是退避端口；Windows 上 `taskkill /F` 在选择之前完成，而 POSIX 只有在对手收到 SIGTERM 后及时退出时才能看到释放的端口。
- `sweep_rival_servers` 异步枚举、在 blocking pool 上执行结束动作，并在确实有目标时把 `rival dsh web sweep targets: [..]` 追加到 `desktop-startup.log`。
- debug 构建跳过清场（`cfg!(debug_assertions)`），因此 `pnpm run dev:desktop` 在开发者对比两者时绝不会结束装机版的 hub。
- 没有常驻监视器：清场只发生在壳本来就要决定「哪个 hub 服务我」的两个时刻。某个壳启动时遇到另一个壳活着但不可收养的 hub，会在自己启动时结束它；已经在运行的壳要等到下一个决策点才复查。

## [S3] Scope

- In scope: `apps/desktop/src-tauri/src/dsh_runner.rs` 里的签名匹配、决策核、进程枚举、清场，以及收养/冷启两处接线；它们的单元测试；双语桌面 README 的 hub 契约；本次变更新增的分叉记录。
- Out of scope: 壳运行期间常驻杀 server 的监视器；同时首启竞态（两个壳同时启动时可能各起一个 hub —— 下一次启动清掉输家）；其他 harness 构建的 hub（必须让它们继续跑）；手动启动的 `prism web` / `pnpm dsh web` server（3080 契约不动它们）；本分叉谱系的其他 checkout（如姊妹 `deepseek-harness` 树），因为匹配通用的 `deepseek-harness/apps/cli` 路径会结束原版 dsh 用户的 server、破坏安装隔离；按 home 隔离 —— 清场是按产品全机器生效的，因此仅靠 `PRISM_HOME` 分隔的两个 release 实例，或闭包路径不同但共享一个 home 的两个 release 安装，都不支持作为并发 hub（各自在下一个决策点清掉对方的 hub，其中一方可能耗尽重启预算）；POSIX 的结束升级 —— 清场只发 SIGTERM，不等待也不升级到 SIGKILL，忽略 SIGTERM 的 hub 会在那一次 spawn 中存活；超出既有 `terminate_pid` 的 Windows 进程树语义。本 spec 之后新增的单实例注册覆盖所有平台（含 dev 构建）的顺序重开；同时首启竞态仍在范围之外。

## Tasks

- [x] T1: 签名匹配、决策核、枚举、清场与两处接线（covers: S2.1, S2.2, S2.3, S2.4）
- [x] T2: 单元测试——装机与开发路径命中（带引号、不同大小写、macOS 分隔符），原版 dsh/Easel/手动 CLI 排除，`keep` 三态语义，`ps` 样本解析器，以及 CIM JSON 解析器的裸对象/数组两种形态（covers: S2.1, S2.2, S2.3）
- [x] T3: 双语桌面 README 的端口/hub 契约与端口弹性规格的范围说明（covers: S2.4）
- [x] T4: 分叉记录——清场处的 `PRISM-DIVERGENCE` 标记、本文档 S5、`fork-upstream-divergence.md` 的相关文档清单，以及 `desktop-startup-latency.md` S5 里过时的测试数量说法（covers: S2.1, S2.4）
- [x] T5: 验证——把每条命令与结果记录到 [S4] 下（depends: T1, T2, T3, T4）

## [S4] Acceptance

- [x] A1: 带引号、大小写不同的装机命令行（`"C:\...\Prism Agent\runtime\prism\lib\bin.js" web --port 3081 --no-open`）、worktree 开发命令行（`.../prism-agent/.worktrees/<name>/apps/cli/lib/bin.js web --port ...`）与 macOS app bundle 命令行命中签名；原版 dsh、Easel 与无关 Node server 不命中；手动的 `apps/cli/src/bin.ts web` 命令行不命中（测试：`rival_sweep_*`）。
- [x] A2: `rival_pids` 返回除 `keep` 外的所有命中 pid；`keep: None` 返回全部命中；`keep` 指向某个对手时只豁免该 pid（测试：`rival_sweep_kills_orphans_and_dev_hubs_but_spares_the_kept_hub`）。
- [x] A3: `adopt_running_server` 以已校验记录的 pid 清场，`supervise` 在 `spawn_child` 之前以 `None` 清场（报告里给出 `dsh_runner.rs` 行号）。
- [x] A4: debug 构建在枚举之前返回（`cfg!(debug_assertions)`），开发壳因此不可能结束装机版 hub。
- [x] A5: `cargo fmt --check` 与 `cargo test` 在 `apps/desktop/src-tauri` 下通过，改动的双语对通过 `verify-translation-pairing` 与 `verify-md-wrap`。

## [S5] Upstream divergence

本 checkout 把上游 `deepseek-harness/deepseek-harness` 作为单个基线提交导入，因此后续上游导入会整目录替换 `apps/desktop/**` 而不是合并。清场属于 [fork-upstream-divergence.md](fork-upstream-divergence.zh.md) 中 A1 承载的壳改动之一；`is_our_dsh_web_server` 上方的标记指向本节。

| 文件 | 分叉点 | 重放必须保留 |
| --- | --- | --- |
| `apps/desktop/src-tauri/src/dsh_runner.rs` | `is_our_dsh_web_server`、`rival_pids`、`list_process_samples`、`parse_cim_samples`、`parse_ps_samples`、`sweep_rival_servers`（含 3 秒枚举预算），以及 `adopt_running_server` 与 `supervise` 里的两处调用点 | 整个代码块与两处调用点；`rival_sweep_*`、`cim_sample_parser_*` 与 `ps_sample_parser_*` 测试是它的决策覆盖，`apps/desktop/src-tauri` 下的 `cargo test` 是重放验收 |
| `docs/compose/spec/desktop-single-hub-sweep.*` | 本文档 | 无需保留，上游没有这个文件 |
