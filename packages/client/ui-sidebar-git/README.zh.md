---
description: "dsh Web 客户端右侧 Sidebar 的 Git 工作台 tab 类型：仓库状态、已暂存/未暂存/未跟踪三段列表、单文件比较，以及在面板里暂存与提交。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-git

[English](README.md) | 中文

## 概述

不离开会话就能处理 Session 的仓库。面板列分支、与上游的领先/落后，以及三段改动路径；点击一行展开该文件对索引或工作树的比较，行上的动作只暂存或取消暂存那一条路径，底栏提交已暂存的内容。Host 半提供面板读取的五条鉴权路由，浏览器半只注册 tab 类型，从不直接访问 git。

## 目录

- [注册了什么](#what-it-registers)
- [路由](#routes)
- [面板](#the-panel)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

-----

<a id="what-it-registers"></a>
## 注册了什么

该 tab 类型走每个右侧栏类型都走的公开两段式：`ctx.sidebarRightTabs.register` 声明一个 kind 为 `git` 的页面类型，不认领资源模式，带一个 guide 条目（order 15，位于文件树的 10 与终端的 20 之间）；keyed 的 `sidebar.right.pane.tab` seat 绘制正文，`sidebar.right.pane.tab.title` 绘制 chip 标题。两者都在包自己的 `ctx.effect` 里，随插件一起离开。

Host 半通过 `ctx.connection.fetch.register` 在 Connection 鉴权围栏内注册五条路由。本包不新增 Typert Remote 服务：面板交换的是小体量的请求与响应记录，不需要流，也不需要生成的线上类型。

<a id="routes"></a>
## 路由

| 路由 | 方法 | 回答 |
|---|---|---|
| `/api/git.status` | GET | `{ available, repo, root?, branch?, ahead?, behind?, entries }`；`repo` 为 false 时 `entries` 为空 |
| `/api/git.diff` | GET | `?path=&side=index\|worktree` → `{ kind: 'text', hunks }`、`{ kind: 'binary' }` 或 `{ kind: 'untracked' }` |
| `/api/git.stage` | POST | `{ sessionId, paths }` → 暂存后的状态 |
| `/api/git.unstage` | POST | `{ sessionId, paths }` → 取消暂存后的状态 |
| `/api/git.commit` | POST | `{ sessionId, message }` → 提交后的状态 |

每条路由都在 Host 上解析 Session 的工作目录，并用 `git rev-parse --show-toplevel` 定位仓库；客户端不提供任何被 Host 信任的路径。绝对路径、空串、含 NUL 字节、或逃出仓库根的路径一律以 400 拒绝。git 命令失败时以 422 返回其 stderr 尾部，面板就地展示。

命令通过 `@deepseek-ai/dsh-workspace-changes` 的 `GitRunner` 执行，与回合改动记录共用清洗过的环境、超时与输出上限。每条带路径的命令都在 `GIT_LITERAL_PATHSPECS=1` 下运行，因此 `[ab].txt` 这样的名字只作用于该文件，而不是它的全部通配匹配。被输出上限截断的列表或比较会被拒绝，而不是带着错误行号画出来。`timeoutMs`、`outputMaxBytes`、`maxMessageBytes` 是经校验的 `Config` 字段。

<a id="the-panel"></a>
## 面板

顶部显示分支、领先与落后上游的提交数，以及刷新控件（同时响应 tab 的刷新命令）。正文按已暂存、未暂存、未跟踪三段列出条目；行上的动作只暂存或取消暂存该路径，按下行本身则在行下展开它的比较。底栏是提交信息与提交控件，在没有已暂存内容、信息为空或提交在途时不可用。

面板在挂载时读取一次，每次写操作后再读一次；写操作本身回传它留下的状态，因此不需要第二轮往返。它不轮询、不监听仓库，每个 tab 同时只有一个读取在生效：更新的请求作废旧请求的落定，记录已消失的 tab 不写任何东西。

<a id="model-experience"></a>
## 模型体验

无。本包只提供浏览器面板与 Host 路由，不注册任何面向模型的东西。

#### KV Cache 影响

无；本包不组装也不发送任何请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- 面板按整路径提交。按 hunk 暂存、切换分支、历史、pull 与 push、冲突解决都不在范围内。
- 未跟踪文件在暂存前没有比较，行上直接说明这一点，而不是读取文件。
- 取消暂存先试 `git reset HEAD`，只对 HEAD 尚未诞生的仓库回退到 `git rm --cached`。
- 状态是面板请求时的快照。面板开着而工作树在别处变化时，没有任何东西会刷新它。
