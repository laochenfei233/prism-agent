# dsh-agent-progress

[English](README.md) | 中文

一个 DeepSeek Harness 插件 bundle，加入 **Agent 工作进度面板**：视口底部的侧边栏条目，以及一个原生浮层页面，列出每个会话以及其中 agent（智能体）正在做什么。

它的形态是「已发布插件」（`dsh.bundle.patch` + 一个 `dsh.client` 浏览器半边），且位于仓库之外，而不是对 Harness 检出目录的改动。

## 它展示什么

每个会话一行，按相关度排序（运行中的在前，其次是最近活跃的）：

| 列 | 来源 |
|---|---|
| 运行中 / 空闲 | 会话列表行的运行标志，会话状态快照作为实时回退 |
| 标题、workspace 基名、最后活动时间 | 会话列表行 |
| `3/7 待办`，外加进度条和 `in_progress` 那一行 | Host 计算出的 `todos` 投影值 |
| 目标 chip | `goal` 投影值 |
| 计划模式 chip | `plan` 投影值 |
| 等待 / 新结果 chip | 会话状态快照（`pendingInteraction`、`completionUnread`） |

表头汇总运行中的会话和未完成的待办。点击某一行会通过 `ctx.uiWorkspace.openSession` 打开该会话并关闭面板。

## 它不做什么

没有 Host 服务、工具、RPC 接口或存储。它渲染的每项事实原本就已随已发布的 UI 送达浏览器，因此只要组装出的 Host 提供基线客户端服务（`slots`、`locale`、`sessions`、`uiWorkspace`），该面板就能工作，并在缺少某个投影时退化为只显示行。

## 目录结构

```
src/index.ts             Host half: a Loader-loadable no-op plugin
src/client/index.tsx     registrations: sidebar.footer.action + shell.overlay
src/client/progress.ts   pure derivation from list + status snapshots
src/client/locales.ts    zh / en dictionaries
src/client/styles.ts     panel stylesheet (rendered in a <style> element)
src/client/externals.d.ts  local stand-ins for the two baseline modules used
```

## 构建

```sh
# from this directory, using the checkout's own tsdown
../../node_modules/.bin/tsdown --config tsdown.config.ts
```

产物：`lib/index.js`（Node 半边）与 `lib/client.js`（浏览器半边）。浏览器半边是一个通过 `window.__ModuleLoader__.load({ id, factory })` 注册的 CJS 闭包；`react`、`react/jsx-runtime` 与 `@deepseek-ai/dsh-client-store` 保持外部依赖，经外壳的模块表解析，因此不会向页面重复打包任何内容。

类型检查：`node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`（需要 `@types/react`，已在 `devDependencies` 中声明）。

冒烟测试会通过注入了基线模块的 `window.__ModuleLoader__` 桩加载 `lib/client.js`，用一个记录型上下文驱动 `apply`，再针对合成的三会话列表渲染面板：

```sh
node scripts/smoke.mjs
# smoke: ok — 2 registrations, panel renders, closed panel is null, nav counts 1 running session
```

## 安装到 profile

```sh
dsh plugin --profile web add -w <absolute path to this directory>
```

然后重启 Harness 进程：客户端模块只在启动时扫描，因此新安装的 bundle 要等进程重启后才会被提供。

在重启前后分别验证：

```sh
curl -s http://127.0.0.1:3080/ | grep -c 'dsh-agent-progress'          # > 0 once composed
curl -s -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:3080/plugins/dsh-agent-progress/client.js         # 200 once served
```

重新加载后，侧边栏底部会出现进度条目；只要有会话在运行，它就带一个绿色的计数徽章。
