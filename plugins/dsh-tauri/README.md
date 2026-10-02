# dsh-tauri — DeepSeek Harness 桌面端消息桥

Message bridge for the DeepSeek Harness desktop shell: forwards host nav-bar
commands (sidebar toggle / page prev / page next) into dsh and reports dsh state
back. **No UI, no runtime dependencies** — the top nav bar lives in the Tauri
host; this plugin is only the iframe-side receiver.

## Protocol（宿主 ↔ iframe，postMessage）

| 方向 | source | type | 说明 |
| --- | --- | --- | --- |
| 宿主 → iframe | `dsh-desktop` | `dsh://sidebar:toggle` | `ctx.layout.toggleSidebar()` |
| 宿主 → iframe | `dsh-desktop` | `dsh://page:prev` / `dsh://page:next` | 会话访问栈后退 / 前进 |
| iframe → 宿主 | `dsh-nav-bridge` | `dsh://sidebar:collapsed` / `dsh://page:firsted` / `dsh://page:lasted` | 折叠状态与历史边界（驱动导航栏图标 / 禁用态） |
| iframe → 宿主 | `dsh-plugin-error-bridge` | `dsh://plugin-error` `{ id, error, action }` | 运行时错误上报（「插件」面板 danger 标记） |

实现细节（会话访问栈页面模型、`window.__dsh_tauri_bridge__` 接管让位、
错误上报契约）见 `src/client/bridge.ts` 与 `src/client/error.ts`。

## Install

```sh
dsh plugin --profile web add dsh-tauri
```

安装后重启服务。插件自带 `cordis.patch.yml`（bundle patch），`dsh plugin add`
会自动把它挂入 profile 的 bundle 层并注册到浏览器插件名册。

## Develop

```sh
pnpm install
pnpm lint        # ESLint
pnpm typecheck   # tsc --noEmit
pnpm build       # 产物 lib/client.js + lib/index.js（随仓库提交，安装无需构建）
pnpm test        # Vitest：lib/client.js loader 冒烟测试
```
