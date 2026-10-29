---
feature: desktop-single-hub-sweep
status: in-progress
updated: 2026-10-29
branch: feat/desktop-single-hub-sweep
commits: # filled at delivery
---

# Desktop Single-Hub Sweep

[English](desktop-single-hub-sweep.md) | 中文

## Report

## [S1] Problem

每次壳启动，要么收养 `$DSH_HOME/desktop-server.json` 指向的 hub，要么在 3081..=3131 里挑第一个空闲端口新起一个 `dsh web`。这个决策唯一读取的证据就是那条记录，因此「活着但不可收养」的 hub 对它不可见：死掉的壳留下的孤儿（记录已被覆盖）、从被替换的运行时闭包启动的 hub、并行启动的实例，以及装机版旁边开发壳自己的 hub。它们服务同一份 `~/.prism` 会话存储，而会话写者锁对每个会话只允许一个写者，于是竞态中输掉的那个窗口报 `session/writer-held` —— 这正是 Easel 壳撞上、并通过在每个决策点结束自家对手 server 修掉的「被另一个 dsh 占用」。

端口回退还把这个分裂藏了起来：`select_port` 把新 hub 挪到 3082，壳显示一切正常，两个 hub 继续共用一个 home 活着。桌面 README 的端口契约已经允许 3081..=3131 的扫描吸收「外来监听者」，但它对「第二个 Prism hub」没有答案。

## [S2] Design

### S2.1 Product-scoped process signature

`is_our_dsh_web_server(command_line)` 只有在三个条件同时成立时才接受一条命令行：

- 含有 `bin.js`。
- 含有连续参数对 ` web --port`，即 `spawn_child` 构造的形式（`<bin> web --port <port> --no-open`）。
- 命名了本产品启动 hub 的两条路径之一：`/runtime/prism/`（装机闭包 —— Windows 上是 `<install>/runtime/prism/lib/bin.js`，macOS 上是 `Prism Agent.app/Contents/Resources/runtime/prism/...`），或者 `prism-agent/` 与 `/apps/cli/` 同时出现（本 checkout 及其 linked worktree，`resolve_runtime` 的开发回退正是从这里解析构建好的 CLI）。

命令行先转小写、再把反斜杠归一成 `/`；Windows（`CIM`）与 macOS（`ps`）于是共用一条规则。CIM 原样返回带引号的映像路径（`"C:\...\bin.js" web --port ...`），所以标记按彼此独立的子串匹配，而不是天真的连续 `bin.js web`。

这三个条件从构造上把其他 harness 构建挡在清场之外：原版 `deepseek-harness` 的 hub（`.../runtime/dsh/lib/bin.js`）、Easel 的 hub（`.../easel-dsh/runtime/dsh/lib/bin.js`）和无关的 Node server 都不带任一产品路径标记。用户手动起的 CLI server（`prism web`、`pnpm dsh web` —— `apps/cli/src/bin.ts`，常常是相对路径且不带 `--port`）也不匹配；壳按契约把 3080 留给它，所以这条边界是刻意的，S3 记录在案。

### S2.2 Decision core

`rival_pids(samples, keep)` 就是整个决策，不碰进程 I/O，因此可测：所有命令行匹配 S2.1 的采样 pid，除了 `keep`。supervisor 在即将收养已校验的 hub 时传 `Some(record.pid)`，在即将冷启时传 `None`。`keep` 指向不存在的进程只是少一项豁免，其余对手照清。

### S2.3 Process enumeration

Windows 通过 `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 枚举并取 `ProcessId, CommandLine`（`wmic` 在当前 Windows 上已弃用）。`ConvertTo-Json` 把单条结果渲染成裸对象、多条渲染成数组，两种形态都接受。macOS 与 Linux 解析 `ps -axo pid=,command= -ww`；`-ww` 关掉终端宽度截断（否则 ` web --port` 尾巴会被切掉），pid 列是右对齐的，所以前导空格要去掉。枚举失败返回空列表：漏掉对手的代价是下一次启动再清一遍，而起不来的代价是整个窗口。

### S2.4 Wiring and timing

- `adopt_running_server` 在记录的启动 token 通过校验之后、发布收养端口之前，以 `Some(record.pid)` 清场。
- `supervise` 在冷启路径上、`spawn_child` 之前以 `None` 清场，于是 `select_port` 能看到刚释放的端口，新 hub 回到 3081 而不是退避端口。
- `sweep_rival_servers` 在 blocking pool 上枚举并结束进程；确实结束了东西时，把 `swept rival dsh web servers: [..]` 追加到 `desktop-startup.log`。
- debug 构建跳过清场（`cfg!(debug_assertions)`），因此 `pnpm run dev:desktop` 在开发者对比两者时绝不会结束装机版的 hub。
- 没有常驻监视器：清场只发生在壳本来就要决定「哪个 hub 服务我」的两个时刻。某个壳启动时遇到另一个壳活着但不可收养的 hub，会在自己启动时结束它；已经在运行的壳要等到下一个决策点才复查。

## [S3] Scope

- In scope: `apps/desktop/src-tauri/src/dsh_runner.rs` 里的签名匹配、决策核、进程枚举、清场，以及收养/冷启两处接线；它们的单元测试；双语桌面 README 的 hub 契约；本次变更新增的分叉记录。
- Out of scope: 壳运行期间常驻杀 server 的监视器；同时首启竞态（两个壳同时启动时可能各起一个 hub —— 下一次启动清掉输家）；壳侧单实例锁；其他 harness 构建的 hub（必须让它们继续跑）；手动启动的 `prism web` / `pnpm dsh web` server（3080 契约不动它们）；按 home 隔离 —— 清场是按产品全机器生效的，因此仅靠 `PRISM_HOME` 分隔的两个 release 实例不支持作为并发 hub；超出既有 `terminate_pid` 的 Windows 进程树语义。

## Tasks

- [ ] T1: signature matcher, decision core, enumeration, sweep, and the two wiring points (covers: S2.1, S2.2, S2.3, S2.4)
- [ ] T2: unit tests — installed and dev paths matched (quoted and case variants, macOS separators), stock dsh/Easel/manual CLI excluded, `keep` three-state semantics, `ps` sample parser (covers: S2.1, S2.2, S2.3)
- [ ] T3: desktop README port/hub contract and the port-resilience scope note, both languages (covers: S2.4)
- [ ] T4: divergence records — `PRISM-DIVERGENCE` marker at the sweep site, this document's S5, the A1 row in `fork-upstream-divergence.md`, and the stale test-count claim in `desktop-startup-latency.md` S5 (covers: S2.1, S2.4)
- [ ] T5: verification — record every command and result under [S4] (depends: T1, T2, T3, T4)

## [S4] Acceptance

- [ ] A1: a quoted, differently cased installed command line (`"C:\...\Prism Agent\runtime\prism\lib\bin.js" web --port 3081 --no-open`), a worktree dev line (`.../prism-agent/.worktrees/<name>/apps/cli/lib/bin.js web --port ...`), and a macOS app-bundle line match the signature; stock-dsh, Easel, and unrelated Node servers do not; a manual `apps/cli/src/bin.ts web` line does not (test: `rival_sweep_*`).
- [ ] A2: `rival_pids` returns every matching pid except `keep`; `keep: None` returns all matches; a `keep` naming a sampled rival spares only that pid (test: `rival_sweep_kills_orphans_and_dev_hubs_but_spares_the_kept_hub`).
- [ ] A3: `adopt_running_server` sweeps with the verified record's pid, and `supervise` sweeps with `None` before `spawn_child` (`dsh_runner.rs` line references in the report).
- [ ] A4: debug builds return before enumeration (`cfg!(debug_assertions)`), so a dev shell cannot end the installed hub.
- [ ] A5: `cargo fmt --check` and `cargo test` pass under `apps/desktop/src-tauri`, and the changed bilingual pairs pass `verify-translation-pairing` and `verify-md-wrap`.

## [S5] Upstream divergence

本 checkout 把上游 `deepseek-harness/deepseek-harness` 作为单个基线提交导入，因此后续上游导入会整目录替换 `apps/desktop/**` 而不是合并。清场属于 [fork-upstream-divergence.md](fork-upstream-divergence.zh.md) 中 A1 承载的壳改动之一；`is_our_dsh_web_server` 上方的标记指向本节。

| 文件 | 分叉点 | 重放必须保留 |
| --- | --- | --- |
| `apps/desktop/src-tauri/src/dsh_runner.rs` | `is_our_dsh_web_server`、`rival_pids`、`list_process_samples`、`parse_ps_samples`、`sweep_rival_servers`，以及 `adopt_running_server` 与 `supervise` 里的两处调用点 | 整个代码块与两处调用点；`rival_sweep_*` 与 `ps_sample_parser_*` 测试是它的决策覆盖，`apps/desktop/src-tauri` 下的 `cargo test` 是重放验收 |
| `docs/compose/spec/desktop-single-hub-sweep.*` | 本文档 | 无需保留，上游没有这个文件 |
