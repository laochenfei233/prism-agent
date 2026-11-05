---
feature: prism-tasks
status: designed
updated: 2026-11-04
branch: feat/prism-tasks
commits: none
---

# 任务视图：会话内的子代理拓扑与团队任务板

English | [中文](prism-tasks.zh.md)

## Report

设计稿，尚未实现。

## [S1] Problem

一次运行里谁被派生、各自在做什么、共享任务被谁认领，现在分散在三处：对话流只显示主线；子代理状态要打开会话头那个弹出面板，而它只列名册加一块只读任务板（[client-ui-agent-team](../../../packages/experimental/client-ui-agent-team/README.md)）；拓扑要靠逐个打开子会话才能拼出来。

市面上的做法（better-sidebar 的任务管理页）把这三件事放进右侧栏的一个 tab，并给了可缩放的工作流图。本项目不采用侧边栏落点：右侧栏是「文件 / 终端 / 变更」这类工作区工具的容器，而任务视图是「这次运行发生了什么」的观察面，属于会话本身，应当和「对话」「轨迹」同级。

## [S2] Design

### S2.1 落点：`conversation.view` 的第三个 tab

`plugins/prism-tasks` 是一个出树插件（按 [A5](../spec/fork-upstream-divergence.md) 归口），只做一件事：向 `conversation.view` 注册一个 tab，`id: 'tasks'`、`order: 20`（对话 0、轨迹 10 之后）、label 走 thunk `() => t('view.tasks')`、`inject(sessionId)` 拿到当前会话。

注册形态照抄 [ui-trajectory](../../../packages/client/ui-trajectory/src/client/index.ts)：`ctx.slots.inject('conversation.view', () => ctx.slots.register({ … }))`。slot 消失或插件卸载时注册随之撤销，tab 因而出现在会话头部，并免费获得按会话记忆的选中、固定与「更多」溢出行为（声明见 [ui-conversation 的 slot 契约](../../../packages/client/ui-conversation/src/client/contract/slots.ts)）。

不新增服务、不发请求、不注册右侧栏 tab、不接管 `ui-sidebar-right` 的任何 slot，`packages/**` 一行不改。没有选更小的形态（独立设置页、浮窗）：它们拿不到会话作用域与常驻位置，而 tab 这两样都是现成的。

### S2.2 数据：只用客户端已发布的投影

根会话按 `useSession(snapshot => snapshot.subagent?.address.parentSessionId) ?? sessionId` 解析：从子会话进入时先归到它的 Lead，与 [TeamAction](../../../packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx) 的取法一致。

拓扑读 `projectionsBySession[parent].values.subagentCatalog`（每条 `SubagentCatalogEntry` 带 id、createdAt、mode ∈ one-shot/continuable/external/unknown、label）与 `subagentTiming`（settledMs、当前轮 active.since、lastTurnCompleted），类型在 [subagent 投影类型](../../../packages/subagent/subagent/src/projection-types.ts)；节点是否在运行读 `useSessions(state => state.byId[id].running)`。

团队读 `projectionsBySession[leadSessionId].values.agentTeam`，字段为 `members`（id、name、role、phase）与 `tasks`（id、revision、subject、description、status、ownerName、blockedBy、writeScopes、ready），见 [agent-team 类型](../../../packages/experimental/agent-team/src/types.ts)；`failure` 非空时顶部显示一行告警，名册与任务保持最后一次有效值。

**限制一**：`subagentCatalog` 是父会话自己的投影，只有父会话在客户端加载后才可用；孙级节点要等那个子会话也被加载过才有自己的目录。所以 v1 只画「已加载的父会话 + 它的直接子代理」，更深的层级渲染成不可展开，README 必须写明。

**限制二**：客户端没有子会话的事件，节点上只能写持久状态（运行中 / 待命 / 已完成 / 出错）与时长，写不出「正在分析请求」这类实时措辞。实时文案需要 Host 读接口把子会话最新片段聚合回来，见 S2.7。

### S2.3 派生与布局是纯函数

`deriveTopology(rootId, summaries, catalog, timing)` 产出 `{ nodes, edges }`；`layoutGraph(nodes, width)` 产出分层坐标（根在上，子级按列换行）。两者不碰 React、不读 ctx、不订阅，单测直接喂数据。

图用 SVG 画边、DOM 卡片画节点，`transform: translate/scale` 承载缩放：滚轮 0.4–2，「− / +」按 20% 步进，「适应画布」按内容包围盒计算。拖动平移只在背景按下时开始，节点保留自己的点击；点节点打开详情 popover（名字、模式、状态、时长、认领的任务）。

### S2.4 两种视图，共用一份派生数据

「工作流图」为默认，右下角切到「树状图」，选择按会话记在本地 store（不进会话日志）。

树是键盘路径：Arrow 上下移动、Left/Right 折叠展开、Enter 打开对应子会话（`ctx.uiWorkspace.openSession({ parentSessionId, childSessionId, mode: 'continuable' })`）。图的节点不设 `tabIndex`：几十个节点会变成几十个 Tab 停点，把页面的真实控件淹没；可访问性由树承担，图只承担浏览。窄屏（< 720px）默认树。

### S2.5 团队任务板：只读

`agentTeam` 存在时，图上方渲染一条可折叠的任务板：成员胶囊（「全部」+ 各成员，兼作负责人过滤）+ 任务行（状态点、标题、负责人、状态 Tag、阻塞标记），点行打开只读详情。

没有新建、认领、完成、删除。原因不是省事：写操作在 Host 的团队服务上，要求活的 Agent，且分配只有 Lead 能做；浏览器要写就得有一条「代表 Lead」的通道，先要定授权模型（谁能替 Lead 认领、CAS 冲突怎么回给界面）。授权定下来之前，写按钮就是伪造权限。

### S2.6 空态与失败面

无子代理且无团队：一句话空态（本会话还没有派生子代理），不画空画布。

无团队但有子代理：只画拓扑，任务板整块不渲染。

`agentTeam.failure` 非空：任务板上方一行告警，仍渲染最后一次有效数据。

`ctx.sessions.binding(sessionId)` 缺失：注册期抛错，与 ui-trajectory 一致。

### S2.7 明确不做（v2 候选）

任务写操作与实时措辞都要新增 Host 面：一条读路由（子会话最新片段与运行摘要）和一条写路由（代表 Lead 的认领与完成）。两者都受「model-visible ⟺ logged」约束（只回放日志里已有的事实），并且要先有授权决定，所以不在本规格里顺手加。

workflow run 节点也不画：那是另一套投影，混进来会让 v1 的派生函数同时处理两种树。

## [S3] Scope

In scope：`plugins/prism-tasks` 包（manifest、`cordis.patch.yml`、client 半区、locale、README 与两条限制）、`conversation.view` 注册、`deriveTopology`/`layoutGraph` 与单测、图与树两个组件、只读任务板、组件行为 spec、真实 Cordis 组合挂载测试、e2e 钉住 tab 与空态。

Out of scope：右侧栏与任何侧边栏 tab、任务写操作、实时措辞、workflow 节点、自动折叠已结束节点、token 与耗时统计、改 `packages/**`、把插件装进正在跑的 profile（收尾单独一步）。

## Tasks

- [ ] T1 脚手架：manifest（`@prism/prism-tasks`、`dsh.client.platform: web`、`dsh.bundle.patch`）、tsconfig、tsdown、vitest、README 骨架 (depends: none)
- [ ] T2 `conversation.view` 注册与 tab 文案（zh/en），dispose 即移除 (depends: T1) covers: S2.1
- [ ] T3 `deriveTopology` + `layoutGraph` 纯函数与单测 (depends: T2) covers: S2.2, S2.3
- [ ] T4 图视图：缩放、平移、适应画布、节点详情 (depends: T3) covers: S2.3
- [ ] T5 树视图：键盘导航与打开子会话，与图共享派生数据 (depends: T3) covers: S2.4
- [ ] T6 只读团队任务板与成员过滤 (depends: T2) covers: S2.5
- [ ] T7 空态、failure 告警、缺失 binding (depends: T4, T5, T6) covers: S2.6
- [ ] T8 README（两条限制与只读边界）、真实组合挂载测试、e2e 收尾 (depends: T4, T5, T6, T7)

## [S4] Acceptance

- [ ] A1 安装后会话头部出现「任务」tab；卸载插件后 tab 消失，真实 Cordis 组合断言注册数为 0。
- [ ] A2 一次派生 2 个子代理的运行里，图与树都显示「主代理 + 2 子代理」，节点状态跟随 `byId[id].running` 变化。
- [ ] A3 节点显示 label 与模式（一次性 / 可续接）；`unknown` 不冒充一次性。
- [ ] A4 树状图可用键盘遍历，Enter 打开对应子会话并按可续接地址继续。
- [ ] A5 缩放落在 0.4–2，适应画布把内容放进面板，背景拖动平移，点节点不触发平移。
- [ ] A6 有 `agentTeam` 的会话显示「团队 N 成员 · M 任务」与成员过滤；任务行只读，没有新建 / 认领 / 删除控件。
- [ ] A7 `agentTeam.failure` 存在时显示告警且仍渲染最后一次有效名册；无子代理时显示空态而不是空画布。
- [ ] A8 `tsc --noEmit` 与 `vitest run` 通过，构建出的 `lib/client.js` 只请求 React 与声明的基线模块。
