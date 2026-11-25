---
feature: domestic-update-source
status: delivered
updated: 2026-11-21
branch: feat/domestic-update-source
commits: 205657d63d..7f9ddd5d4b
---

# 国内更新源

[English](domestic-update-source.md) | 中文

## Report

**构建内容** — 桌面更新器现在先查国内镜像：`tauri.conf.json` 把 `https://cdn.xyern.com/prism-agent/updates/latest.json` 钉在 GitHub Releases endpoint 之前，Tauri 更新器按序兜底，镜像不可达时落回 GitHub（覆盖 CDN 清单就绪前的窗口期）。关于页保持稳定显示：Rust 壳的 `UpdateSource` wire 增加 `host` 字段，配置了 `cdn.xyern.com`/`prism-agent/` endpoint 时携带官方地址 `prism.xyern.com`——显示与实际有意分离，沿用 Easel 更新器约定——`repo`/`releaseUrl` 仍取自列表中第一个 GitHub endpoint，更新日志与意见反馈链接始终落在 GitHub Releases/issues。

prism-about 客户端经新增的纯函数 `deriveSourceView` 渲染镜像态：显示地址以纯文本呈现并配 `国内镜像`/`China mirror` 徽标；纯 GitHub 配置下维持仓库链接与 GitHub Releases 徽标；其余为不可用态。文案对两套字典各加一键；文档（桌面 README 对、插件 README 对与描述、`desktop-dev-notes.md`、`desktop-client` spec 对）均改为镜像在前的新安排。

**验证** — `cargo test`（apps/desktop/src-tauri）：49 通过 / 0 失败，exit 0，每次 Rust 改动后重跑；`pnpm run test`（plugins/prism-about）：13 通过 / 0 失败；插件 `tsc --noEmit`：PASS；插件 tsdown 构建：PASS；`pnpm run verify-md-wrap`：全仓 PASS（2533 文件）；`pnpm run verify-translation-pairing`：改动文件 0 投诉（全仓 32 对 master 基线 54——陈旧构建目录副本的环境噪声）；`verify-md-links` 与其余 6 个文档门：与 master 相同的既有失败，改动文件无一被点名。endpoint 为编译期写入：本改动随下一次打包发版进入用户手中。

**历程记录** —
- 新 worktree 的 `cargo test` 在 Tauri build script 处失败：`resource path '..\runtime' doesn't exist`——`apps/desktop/runtime` 是 `bundle-runtime.mjs` 的 gitignored 产物。从主检出镜像一份即可解锁编译与测试；Git Bash 下 `robocopy /MIR` 必须配 `MSYS_NO_PATHCONV=1`，否则 `/MIR` 被转成路径。
- lefthook 的 pre-commit 钩子在本机崩溃（msys `NtCreateDirectoryObject … 0xC0000022`）；手动执行相同门禁命令后以 `--no-verify` 提交是可行路径。
- endpoint 列表与显示耦合：关于事实从配置的 endpoint 派生，因此 CDN 在前必须扩展 `UpdateSource`（显示地址），仅重排数组会让关于页显示「更新源不可用」。
- 新 spec 文档必须双语言都保持每段一物理行（`verify-md-wrap` 拒绝硬换行），并随带 `.i18n.yaml` 记录与语言切换链接（`verify-translation-pairing`）。

## [S1] 问题

应用内更新只解析单一 GitHub Releases endpoint，对国内用户来说慢或不可达。国内 CDN 镜像已在 `cdn.xyern.com` 就位（与 Easel 应用迁移后的同一安排）；桌面应用需先检查镜像、保留 GitHub 兜底，同时关于页仍显示稳定的官方地址。

## [S2] 设计

### S2.1 更新器 endpoint

`apps/desktop/src-tauri/tauri.conf.json` 按优先序列出两个 endpoint：

1. `https://cdn.xyern.com/prism-agent/updates/latest.json` —— 国内镜像清单（腾讯 CDN，按 Easel 的 release 同步约定）。
2. `https://github.com/laochenfei233/prism-agent/releases/latest/download/latest.json` —— 既有 GitHub Releases 兜底。

Tauri 更新器按声明顺序逐个尝试、取第一个成功的响应，因此镜像可达时检查走镜像，CDN 侧就绪前的窗口期由 GitHub 覆盖。pubkey、安装模式与签名校验不变。

### S2.2 显示/实际分离

关于卡片显示官方地址 `prism.xyern.com`，更新器实际请求 `cdn.xyern.com`，与 Easel 约定一致。Rust 壳的 `UpdateSource` wire 增加 `host` 字段：配置了 `cdn.xyern.com` 上 `/prism-agent/` 路径的 endpoint 时携带显示地址，纯 GitHub 配置下为空（卡片照旧渲染仓库）。`repo`/`releaseUrl` 事实继续取自列表中第一个 GitHub releases endpoint（不限位置）——更新日志与意见反馈链接始终落在 GitHub Releases/issues。

### S2.3 关于卡片渲染

prism-about 客户端经一个纯函数从快照派生源卡片：配置镜像 → 徽标文案 `国内镜像`/`China mirror`，显示地址以纯文本呈现（显示名不是可导航页面）；否则维持现有仓库链接与 GitHub Releases 徽标。文案对 zh/en 各加一个键（`sourceMirror`）；zh/en 配对测试保证成对。

## [S3] 范围

- 范围内：endpoint 列表、Rust 源事实映射及其测试、关于卡片的镜像渲染、插件字典与 README、桌面 README 对、`desktop-dev-notes.md`、一条 changelog 条目；插件 `lib/` 产物是 gitignore 的构建产物，打包时由 `bundle-runtime.mjs` 重建，故以本地 tsdown 构建验证而不入库。
- 范围外：自定义更新源 UI；CDN 侧同步工具（在网站仓库）；CDN 地址连通性验证（用户要求暂缓）；recorded-session 快照覆盖（关于卡片只在桌面载具内可达，keyless web 重放无法产生——既有缺口，非新增）。

## Tasks

- [x] T1: `tauri.conf.json` endpoint 重排为镜像在前、GitHub 兜底（依赖: 无）
- [x] T2: `UpdateSource` 扩展显示地址并把 endpoint 映射为镜像/GitHub 事实，附测试（依赖: 无）
- [x] T3: 关于卡片渲染镜像态——bridge 类型、纯函数、节组件、字典、测试（依赖: 无）
- [x] T4: 本地重建 prism-about `lib/` 产物作构建冒烟——`lib/` 不入库、打包时重建（依赖: T3）
- [x] T5: 更新文档——桌面 README 对、prism-about README 对与描述、`desktop-dev-notes.md`（依赖: 无）
- [x] T6: 添加 changelog 条目（依赖: 无）

## [S4] 验收

- [x] 随包更新器配置先查 CDN 清单、后查 GitHub。
- [x] 镜像在前配置产出关于事实 `{ host: "prism.xyern.com", repo: "laochenfei233/prism-agent", releaseUrl: ".../releases" }`；纯 GitHub 配置产出当前事实且 host 为空；不可识别 endpoint 产出空事实。
- [x] 关于卡片在镜像配置下以文本渲染 `prism.xyern.com` 与镜像徽标，纯 GitHub 配置下保留仓库链接、GitHub Releases 徽标与 GitHub 链接，其余保持不可用态。
- [x] zh/en 字典保持键配对，插件测试通过。
- [x] 桌面 crate `cargo test` 通过，插件经 tsdown 干净构建（`lib/` 产物不入库、打包时重建）。
