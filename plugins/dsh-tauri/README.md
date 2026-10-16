# dsh-tauri — DeepSeek Harness desktop message bridge

English | [中文](README.zh.md)

Message bridge for the DeepSeek Harness desktop shell: forwards host nav-bar
commands (sidebar toggle / page prev / page next) into dsh and reports dsh state
back. **No UI, no runtime dependencies** — the top nav bar lives in the Tauri
host; this plugin is only the iframe-side receiver.

## Protocol (host ↔ iframe, postMessage)

| Direction | source | type | Description |
| --- | --- | --- | --- |
| host → iframe | `dsh-desktop` | `dsh://sidebar:toggle` | `ctx.layout.toggleSidebar()` |
| host → iframe | `dsh-desktop` | `dsh://page:prev` / `dsh://page:next` | back / forward in the session visit stack |
| iframe → host | `dsh-nav-bridge` | `dsh://sidebar:collapsed` / `dsh://page:firsted` / `dsh://page:lasted` | collapsed state and history boundaries (drives the nav-bar icon / disabled state) |
| iframe → host | `dsh-plugin-error-bridge` | `dsh://plugin-error` `{ id, error, action }` | runtime error reporting (the danger marker in the Plugins panel) |

Implementation details (the session visit stack's page model, the `window.__dsh_tauri_bridge__` handover, and the error-reporting contract) are in `src/client/bridge.ts` and `src/client/error.ts`.

## Install

```sh
dsh plugin --profile web add dsh-tauri
```

Restart the service after installing. The plugin ships its own `cordis.patch.yml` (bundle patch), and `dsh plugin add` mounts it into the profile's bundle layer and registers it in the browser plugin roster automatically.

## Develop

```sh
pnpm install
pnpm lint        # ESLint
pnpm typecheck   # tsc --noEmit
pnpm build       # 产物 lib/client.js + lib/index.js（随仓库提交，安装无需构建）
pnpm test        # Vitest：lib/client.js loader 冒烟测试
```
