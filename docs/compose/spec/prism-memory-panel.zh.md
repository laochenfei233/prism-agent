---
feature: prism-memory-panel
status: in-progress
updated: 2026-11-01
branch: feat/prism-memory-panel
commits: c22ec9f0b9..HEAD
---

# Prism 记忆的人工操作面

[English](prism-memory-panel.md) | 中文

## Report

_（交付时填写）_

## [S1] Problem

`@prism/prism-memory` 没有任何人能直接读写的界面。`/memory` 只管治理——status、review、approve、reject、restore、maintain、dream、journal、import、export——却既不能自己写一条，也不能查一条：`show` 要 id，而 id 只会出现在 `review` 或 `conversations` 的输出里。不经过模型的一轮对话就无法写入，Web 端也完全没有记忆页面。

对照目标是第三方插件 `omdsh-dev/dsh-mnemon`，它把记忆库和人自己的界面配成一对：侧边栏的记忆系统页、每条回复下方列出本轮读写了什么的记忆条、以及一键把候选交给 agent 去重提炼后写入的采集。它的存储、检索、沉淀、整理与本插件已有能力重叠，所以可参考的是面向人的那一半，不是存储的那一半。

记忆的读写在会话记录里本来就可见——注入帧作为上下文消息到达，模型写入就是一次工具调用——所以真正缺的，是一个能让人看语料、搜语料、处理审阅收件箱、并且不花掉一轮模型就能加一条记忆的地方。

## [S2] Design

### S2.1 服务里的人侧读取与审阅结算

Scope 权威不变：每个模型侧工具、每个 `/memory` 子命令继续传自己的调用 agent，`admission(agent)` 仍然决定它能看见什么。浏览器路由没有调用会话，因此服务新增四个不带 agent 的方法，作用于整库，沿用 `maintain`、`dream`、`importMemories`、`exportMarkdown` 已经是整库操作的先例：

- `operatorRecords()` —— 全部已存记录，新的在前，含 pending 与 archived，因为治理面必须显示它在治理的东西。
- `operatorSearch(query, options)` —— 与 `search` 相同的 BM25 排序和状态集合，不加 scope 过滤。
- `operatorApprove(id, note?)` 与 `operatorReject(id, reason?)` —— 与 `approve`/`reject` 相同的审阅结算，不加 scope 过滤。

私有的 `require` 拆成保留 scope 的包装与 `requireIn(id, admission)`，让两个面共用同一份实现。人侧写入复用公开的 `remember` 并带 `origin: 'operator'`，把写入时的去重、标签推导和容量检查留在同一条路径上。

### S2.2 Connection 共享 API 通道上的四条路由

新的一行 Host 插件 `@prism/prism-memory/web` 通过 `ctx.connection.fetch.register` 在 `/api/prism-memory` 下注册精确 Fetch 路由，与其他功能包用的是同一套机制。每条路由接收一个 JSON 体，用 zod 校验，并且只回答一种信封：`{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`，后者为 HTTP 400。

    POST /api/prism-memory/overview  -> { total, byStatus, byLayer, pending, recent }
    POST /api/prism-memory/search    -> { rows }
    POST /api/prism-memory/remember  -> { row, outcome, duplicates }
    POST /api/prism-memory/review    -> { row }

`overview` 一次往返给出页面的初始状态：整库算出的计数、审阅收件箱、以及每一层最近的一条。行数上限住在这条行里而不在服务里，所以读取仍是整库读取，由传输层决定有多少内容过线。

### S2.3 浏览器侧

插件新增一个浏览器入口，手工复刻 shell 的动态包契约，因为本包在仓库之外，`packages/client/tsdown.client.ts` 是 workspace 预设。该包注册两处贡献：一个 `sidebar.panellist` 图标，以及以面板 id `memory` 为键的 `main` 页面。

页面显示计数、搜索框、新增表单、带通过和驳回的审阅收件箱，以及记录列表，并具备加载中、空、失败三种状态。控件来自共享的 `@deepseek-ai/dsh-client-ui-primitives` 基线；样式表是页面内的字符串，因为仓库外的包没有 CSS 流水线，并消费 shell 的 `--dsw-*` token 以跟随当前主题。文案集中在一个 locale 命名空间，注册名 `prismMemory.panel`。

### S2.4 两个人的子命令

`/memory remember <text>` 以 `origin: 'operator'` 存下操作者自己的断言，并打印它落到的 id；`/memory search <query>` 渲染与 `memory_search` 相同的排序行，窄化到发起会话的 scope。两者都是既有服务方法的薄适配，都不花任何工具 schema。

### S2.5 模型侧一动不动

面板与两个子命令不新增任何工具定义、不新增任何系统提示字节、不新增任何注入帧。五个工具 schema、协议段、尾部注入规则都保持原样，`tests/cache-safety.spec.ts` 因此无需改动继续成立。

### S2.6 明确不采纳的 dsh-mnemon 部分

- 外部记忆服务的 provider 生态：本插件的库就是 profile 的 storage domain，只有一个 provider 的抽象是空想。
- 插件页上的可组合来源与策略组件：检索策略就是一个函数，拆成组件等于在没有第二种实现之前先做配置。
- 存储位置可选与 ZIP 备份：storage domain 与 Markdown 镜像已经负责这件事，独立备份功能正在别处建设。
- 实体图谱与按记忆作答的 agent：主题摘要在聚类语料，检索也就一次工具调用。
- 每条回复下方的记忆条：读已经是上下文消息、写已经是工具调用，记忆条只是把会话已经显示的东西再说一遍。
- 可手改的记忆文件作为第三方真相源：Markdown 镜像保持为导出，否则手改文件与 domain 需要一个双方都没有的合并责任方。

## [S3] Scope

- 范围内：四个服务侧人用方法、浏览器路由及其线上契约、浏览器侧与其构建和清单改动、两个 `/memory` 子命令、面向模型的文档，以及它们的测试。
- 范围外：任何对记录 schema、检索模型、注入帧、工具面、协议文本、导入布局、整理流程的改动。

## Tasks

- [ ] T1: 给服务加四个 operator 方法与共用的 `requireIn`，并在 `tests/service.spec.ts` 覆盖（依赖：无）
- [ ] T2: 加 `src/web-contract.ts` 与 `src/web.ts` 路由行，把该行接进 `cordis.patch.yml`，并用 Loader 组装的 spec 覆盖（依赖：T1）
- [ ] T3: 加浏览器侧：清单与 `dsh.client`、两个 tsconfig 面、tsdown 客户端包、locale 字典、请求客户端、页面与样式、图标、注册（依赖：T2）
- [ ] T4: 加 `/memory remember` 与 `/memory search`，并加一个通过真实命令运行时端到端驱动 `/memory` 的 spec（依赖：T1）
- [ ] T5: 更新 `README.md`、`README.zh.md` 与配对记录；更新 `preview/` 里陈述命令与面板面的设计说明（依赖：T3、T4）
- [ ] T6: 在 worktree 里跑本包两个面的 typecheck、全部 suite、构建与 smoke 脚本（依赖：T3、T4、T5）
- [ ] T7: 对整个改动做独立评审，然后定稿本文档（依赖：T6）

## [S4] Acceptance

- [ ] `/memory remember <text>` 以 origin `operator` 在调用方默认 scope 存下一条断言，并打印其 id。
- [ ] `/memory search <query>` 渲染带层、种类、scope、日期与来源会话的排序行，空查询列出最近的断言。
- [ ] 没有会话的调用方可以读到 project 与 conversation scope 的记录，也可以通过或驳回其中一条——今天 `visible` 与 `approve` 做不到。
- [ ] 四条路由各自回答信封，非法请求体以错误码拒绝，且路由内永不抛出。
- [ ] 该 web 行通过 Loader 在真实 web server 与 connection 上激活，并在两者都没有的 profile 里保持 pending。
- [ ] 页面注册进 `sidebar.panellist` 与 `main`，并渲染计数、搜索结果、审阅动作、新增表单与三种状态。
- [ ] 五个工具 schema、协议段、注入帧与前一个构建逐字节相同。
- [ ] 两个 typecheck 面、本包 suite、tsdown 构建与 `scripts/smoke.mjs` 在 worktree 里通过。
