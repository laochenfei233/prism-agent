# dsh-tauri — DeepSeek Harness 桌面端消息桥

[English](README.md) | 中文

DeepSeek Harness 桌面外壳的消息桥：把宿主导航栏的命令（侧边栏折叠 / 上一页 / 下一页）转发进 dsh，并把 dsh 状态回报给宿主。**没有 UI，也没有运行时依赖**：顶部导航栏位于 Tauri 宿主中，本插件只是 iframe 一侧的接收方。

## Protocol（宿主 ↔ iframe，postMessage）

| 方向 | source | type | 说明 |
| --- | --- | --- | --- |
| 宿主 → iframe | `dsh-desktop` | `dsh://sidebar:toggle` | `ctx.layout.toggleSidebar()` |
| 宿主 → iframe | `dsh-desktop` | `dsh://page:prev` / `dsh://page:next` | 会话访问栈后退 / 前进 |
| iframe → 宿主 | `dsh-nav-bridge` | `dsh://sidebar:collapsed` / `dsh://page:firsted` / `dsh://page:lasted` | 折叠状态与历史边界（驱动导航栏图标 / 禁用态） |
| iframe → 宿主 | `dsh-plugin-error-bridge` | `dsh://plugin-error` `{ id, error, action }` | 运行时错误上报（「插件」面板 danger 标记） |

实现细节（会话访问栈页面模型、`window.__dsh_tauri_bridge__` 接管让位、错误上报约定）见 `src/client/bridge.ts` 与 `src/client/error.ts`。

## 安装

```sh
dsh plugin --profile web add dsh-tauri
```

安装后重启服务。插件自带 `cordis.patch.yml`（bundle patch），`dsh plugin add` 会自动把它挂入 profile 的 bundle 层并注册到浏览器插件名册。

## 开发

```sh
pnpm install
pnpm lint        # ESLint
pnpm typecheck   # tsc --noEmit
pnpm build       # 产物 lib/client.js + lib/index.js（随仓库提交，安装无需构建）
pnpm test        # Vitest：lib/client.js loader 冒烟测试
```
