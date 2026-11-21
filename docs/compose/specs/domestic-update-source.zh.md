---
feature: domestic-update-source
status: in-progress
updated: 2026-11-21
branch: feat/domestic-update-source
commits: 205657d63d..
---

# 国内更新源

[English](domestic-update-source.md) | 中文

## Report

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

- [ ] T1: `tauri.conf.json` endpoint 重排为镜像在前、GitHub 兜底（依赖: 无）
- [ ] T2: `UpdateSource` 扩展显示地址并把 endpoint 映射为镜像/GitHub 事实，附测试（依赖: 无）
- [ ] T3: 关于卡片渲染镜像态——bridge 类型、纯函数、节组件、字典、测试（依赖: 无）
- [ ] T4: 本地重建 prism-about `lib/` 产物作构建冒烟——`lib/` 不入库、打包时重建（依赖: T3）
- [ ] T5: 更新文档——桌面 README 对、prism-about README 对与描述、`desktop-dev-notes.md`（依赖: 无）
- [ ] T6: 添加 changelog 条目（依赖: 无）

## [S4] 验收

- [ ] 随包更新器配置先查 CDN 清单、后查 GitHub。
- [ ] 镜像在前配置产出关于事实 `{ host: "prism.xyern.com", repo: "laochenfei233/prism-agent", releaseUrl: ".../releases" }`；纯 GitHub 配置产出当前事实且 host 为空；不可识别 endpoint 产出空事实。
- [ ] 关于卡片在镜像配置下以文本渲染 `prism.xyern.com` 与镜像徽标，纯 GitHub 配置下保留仓库链接、GitHub Releases 徽标与 GitHub 链接，其余保持不可用态。
- [ ] zh/en 字典保持键配对，插件测试通过。
- [ ] 桌面 crate `cargo test` 通过，插件经 tsdown 干净构建（`lib/` 产物不入库、打包时重建）。
