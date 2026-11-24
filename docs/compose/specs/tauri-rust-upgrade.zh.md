---
feature: tauri-rust-upgrade
status: delivered
updated: 2026-11-24
branch: chore/tauri-rust-latest
commits: f9433f3732..7b4ae7086a
---

# Tauri 与 Rust 升级：2.12.6 / 1.100.0

[English](tauri-rust-upgrade.md) | 中文

## Report

**完成内容** —— 桌面壳现在构建在 Tauri 2.12.6 上：`apps/desktop/package.json` 把 `@tauri-apps/cli` 固定到 2.12.6，`Cargo.toml` 声明 `rust-version = "1.90"`（Tauri 2.12.6 的 MSRV）与 `webview2-com = "0.39"`，`Cargo.lock` 把 `tauri` 精确解析到 2.12.6，同时解析出 `webview2-com 0.39.1`、`windows 0.62.2`、`wry 0.57.3`、`tao 0.37.3`、`tauri-build 2.7.6`，`dsh-desktop` 仍为 `0.2.2-rc.1`。vendored NSIS 模板已从 `tauri-cli-v2.12.6`（tauri-bundler 2.10.6，现位于 `crates/tauri-bundler/`）重新同步：上游已自带 `Win\RestartManager.nsh`，fork 旧的 include delta 消失，仅剩的 delta 是 Reinstall 页的就地升级优先行为（与上游 diff 共 30 行，PageReinstall 与 PageLeaveReinstall 两处镜像）。

**验证** —— `pnpm run build` 通过 9/9 个 gate；`cargo check` 与 `cargo build` 在新依赖图上通过（`--quit` 命名事件路径仍用 `windows-sys 0.61`，与 `windows 0.62` 共存）；`node apps/desktop/scripts/smoke-bridge.mjs` 通过。安装器用固定 CLI（`npx @tauri-apps/cli@2.12.6 build`，本地 `createUpdaterArtifacts:false`）加文档记载的 makensis junction 变通构建，产物为 `Prism Agent_0.2.2-rc.1_x64-setup.exe`（123 MB）。静默安装（`/UPDATE /S`）覆盖旧安装替换了壳（exe 哈希 `F82B0BA3…` → `1BF0D82E…`，runtime 18757 → 18851 个文件），装机后的壳能启动，`prism-agent.exe --quit` 能干净退出；完整卸载（注册表项与卸载器移除）后再全新静默安装也成功。旧分支 `chore/tauri-rust-upgrade`（无升级提交；其 folder-drop 工作已经通过其他提交进入 master）已删除，`stash@{0}` 在归档到 `.artifacts/stash-archives/2026-11-08-tauri-2.12.4-wip.patch` 后已 drop。本轮未覆盖（需要人在机器前）：托盘图标目视检查、mac proxy 会话、麦克风/语音输入、真实 updater 下载。

**历程记录** ——
- 所有"静默安装什么都没做"的现象都是自己造成的：Git Bash 的 MSYS 路径转换把 `/S` 改写成 `S:/`，而 `cmd //c` 的引号处理压根没启动 exe。用 `MSYS_NO_PATHCONV=1` 加无空格的 exe 路径启动，NSIS 就会按文档静默安装。
- `makensis` 依然会在 inspector 的长路径 `.md` 上失败；C:\prism-nsis junction + installer.nsi 前缀改写仍然必需，且 junction 必须改指到当前 checkout（旧的指到了主仓库）。
- tauri monorepo 在 2.11.4 到 2.12.x 之间把 bundler 模板从 `tooling/` 挪到了 `crates/` —— 模板要从 `crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi` 取。
- tauri 的 NSIS 欢迎页在 passive（非 silent）运行时也会显示；只有真正的 `/S` 才隐藏页面。updater 自己的 `/UPDATE` 调用不受影响。
- Lefthook 的 msys 崩溃（0xc0000142）在本环境仍存在；手动跑受影响的 gate，并用 `LEFTHOOK=0` 提交（已写进提交信息）。

## [S1] 问题

升级没有可用分支。`chore/tauri-rust-upgrade` 是从 `feat/usage-billing` 创建的指针；它相对 master 的六个提交是旧的 folder-drag-drop 工作，没有任何 Tauri 升级提交。唯一实现是 2026-11-08 基于 `0.2.1-rc.4-alpha5` 的 `stash@{0}`。整包套用会把 `dsh-desktop` 从 `0.2.2-rc.1` 退回 `0.2.1-rc.4-alpha5`，用旧锁替换当前依赖图，并与 master 之后获得的桌面改动（mac proxy、setup、update、tauri.conf）冲突。

当前树也落后于工具链契约。Tauri 2.12.6 要求 Rust 1.90，而 `Cargo.toml` 仍声明 1.77。`webview2-com` 0.38 已不再匹配 Tauri 2.12.6 链接的版本（0.39），vendored NSIS 模板也是 CLI 2.11.4 的，而不是 2.12.6 CLI 内嵌的 tauri-bundler 2.10.6。本机 Rust 落后一个 minor（1.99.1 对 1.100.0），`cargo tauri` 是 2.11.5。

## [S2] 设计

### S2.1 分支与来源

从 master 创建 `chore/tauri-rust-latest`，把升级提交留在这个分支上。不要 rebase 或复活 `chore/tauri-rust-upgrade`，也不要 cherry-pick 它的 folder-drop 提交；那些工作已经通过其他提交进入 master。

在任何清理前把 `stash@{0}` 导出为 patch 文件。只把它当作清单增量和 2.12.4 NSIS 模板的参考；不要应用它的 `Cargo.lock`。等新分支的锁文件和安装器验证通过后，再 drop stash。

### S2.2 目标矩阵

| 组件 | 当前 | 目标 | 来源 |
|---|---|---|---|
| `@tauri-apps/cli` | 2.11.4 | 2.12.6 | npm `latest` |
| `tauri` crate | 2.11.5 | 2.12.6 | crates.io stable |
| `tauri-build` | 2.6.3 | 最新 2.x（2.7.x） | Cargo 解析 |
| 内嵌 `tauri-bundler` | CLI 2.11.4 内嵌版本 | 2.10.6 | 由 `tauri-cli` 2.12.6 固定 |
| `wry` | 0.55.1 | 0.57.x | Cargo 解析 |
| `tao` | 0.35.3 | 0.37.x | Cargo 解析 |
| `webview2-com` | 0.38 | 0.39 | tauri 2.12.6 依赖 |
| `windows` | 0.61.3 | 0.62.x | tauri 2.12.6 依赖 |
| `rust-version` | 1.77 | 1.90 | tauri 2.12.6 MSRV |
| 本机 Rust | 1.99.1 | 1.100.0 | rustup stable |
| NSIS 模板 | tauri-cli-v2.11.4 | tauri-cli-v2.12.6 | tauri-bundler 2.10.6 |

### S2.3 清单改动

在 `apps/desktop/package.json` 中，把三行 `npx --yes @tauri-apps/cli@2.11.4` 改成 `2.12.6`。`dsh-desktop` 版本保持 `0.2.2-rc.1`；本次升级不 bump 发布版本。

在 `apps/desktop/src-tauri/Cargo.toml` 中，把 `rust-version` 设为 `"1.90"`，把 `webview2-com = "0.38"` 改成 `"0.39"`，并保留 `tauri = { version = "2", ... }`，让 Cargo 解析到 2.12.6。保留 `tokio` 的 `net` feature 和现有的 `windows-sys = "0.61"` 行（用于 `--quit` 的命名事件/互斥量）；`windows` 0.62 与 `windows-sys` 0.61 是不同 crate，可以共存。

### S2.4 锁文件

从当前树重新生成 `apps/desktop/src-tauri/Cargo.lock`：把 `tauri` 更新到精确的 2.12.6，再让 Cargo 解析传递依赖图。不要复制 stash 的锁。验证解析结果包含 `tauri 2.12.6`、`webview2-com 0.39`、`windows 0.62`，并且 `dsh-desktop` 仍是 `0.2.2-rc.1`。

### S2.5 NSIS 模板

从 tauri-cli-v2.12.6 / tauri-bundler 2.10.6 取 `installer.nsi`，再重新应用 fork 的 delta：Reinstall 页的 Upgrading 分支优先提供就地升级、其次才是干净卸载，并在 `PageLeaveReinstall` 中对应。Tauri 2.12 已包含 `Win\RestartManager.nsh`，旧的这条 delta 消失；确认剩下的 delta 是就地升级行为。保持 `tauri.conf.json` 指向 vendored 模板。

### S2.6 工具链契约

本机工具链是 rustup 1.29.3、rustc/cargo 1.100.0、`cargo tauri` 2.12.6。仓库没有 `rust-toolchain.toml`；把 MSRV 留在 `Cargo.toml` 的 1.90，并在这份 spec 里记录实测编译器，而不是新增 toolchain 文件。CI 和其他机器需要 Rust 1.90 或更新；1.77 的机器会在升级前就失败。

### S2.7 构建与安装器验证

在 `apps/desktop/src-tauri` 运行 `cargo check` 和 `cargo build`，然后用固定 CLI 构建安装器（`npx --yes @tauri-apps/cli@2.12.6 build`）；如果使用本机 CLI，再单独跑一次升级后的 `cargo tauri build`。安装产物，覆盖已有安装做一次升级，再卸载。验证托盘图标与 `--quit`、loopback proxy 会话、麦克风权限与语音输入、updater 产物与签名。运行 `node apps/desktop/scripts/smoke-bridge.mjs` 和 `pnpm run build:check` 检查 JavaScript 聚合。

### S2.8 风险与回滚

Tauri 3.0.0-alpha.6 是预发布，不能被宽松的 `"2"` 要求意外选中；保留 major 固定并验证解析版本。`windows` 0.62 升级可能破坏 `--quit` 路径，因为它单独使用 `windows-sys` 0.61；必须编译并实际跑退出路径。NSIS 模板是手工 vendored 的，漏掉 delta 会改变安装器的升级行为；与 2.10.6 源码做 diff。mac proxy 和 updater 是旧 stash 之后在 master 上加入的，所以新分支必须基于 master，而不是旧分支。如果升级失败，回滚就是分支本身：在合并前 master 不受影响。

## [S3] 范围

- 范围内：新分支；本机 Rust 与 Tauri CLI 升级；`package.json` 的 CLI 固定；`Cargo.toml` 的 MSRV 与 `webview2-com`；`Cargo.lock`；NSIS 模板；README 版本说明；构建与安装器验证。
- 范围外：Tauri 3 预发布；新的桌面功能；JavaScript 行为改动；旧分支的 folder-drop 历史；在 patch 归档前 drop stash。

## Tasks

- [x] T1：从 master `f9433f3732` 创建 `chore/tauri-rust-latest`（依赖：无）
- [x] T2：rustup 升到 1.29.3，Rust stable 升到 1.100.0（依赖：无）
- [x] T3：本机安装 `cargo tauri` 2.12.6（依赖：T2）
- [x] T4：写这份 spec 及中文对（依赖：T1）
- [ ] T5：在 `apps/desktop/package.json` 固定 `@tauri-apps/cli@2.12.6`（依赖：T3）
- [ ] T6：在 `Cargo.toml` 设置 `rust-version = "1.90"` 与 `webview2-com = "0.39"`（依赖：T5）
- [ ] T7：重新生成 `Cargo.lock` 并验证解析图（依赖：T6）
- [ ] T8：从 tauri-bundler 2.10.6 重新同步 NSIS 模板（依赖：T5）
- [x] T9：构建、安装、升级、卸载并冒烟测试桌面壳（依赖：T7、T8）
- [x] T10：把旧 stash 导出为 patch，并退役旧分支/stash（依赖：T9）
- [x] T11：如果安装器或 updater 行为对外可见，补 changelog 或升级指南（依赖：T9）

## [S4] 验收

- [x] 新分支从 master 开始，不包含旧 folder-drop 历史。
- [x] `rustc` 与 `cargo` 报告 1.100.0，rustup 报告 1.29.3，`cargo tauri` 报告 2.12.6。
- [x] `apps/desktop/package.json` 固定 `@tauri-apps/cli@2.12.6`。
- [x] `Cargo.lock` 解析出 `tauri 2.12.6`、`webview2-com 0.39`、`windows 0.62`，且 `dsh-desktop` 仍为 `0.2.2-rc.1`。
- [x] vendored NSIS 模板匹配 tauri-bundler 2.10.6，并保留 fork 的就地升级 delta。
- [x] `cargo build` 与安装器构建通过；安装、升级、卸载、`--quit` 冒烟通过。
- [ ] 托盘图标目视、mac proxy 会话、语音/麦克风、真实 updater 下载由人工在装机上确认。
- [ ] 只有 stash patch 已归档且新安装器验证通过后，才退役旧分支和 stash。
