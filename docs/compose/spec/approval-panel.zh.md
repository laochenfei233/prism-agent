---
feature: approval-panel
status: delivered
updated: 2026-11-01
branch: feat/approval-panel
commits: d26a0ebaee..4b40272185
---

# 进展面板里的审批

[English](approval-panel.md) | 中文

## Report

**已构建** — 等待审批的会话现在会在进展面板里带一条审批条：请求本人那一行文本和两个决定。面板按结构读取该待处理值并直接作答，因此 Host 与浏览器线上都没有新增内容。实现在树外的 `plugins/dsh-agent-progress` 插件里。

## [S1] 问题

审批卡在发起它的会话输入框上方，于是「要批什么」和「批准」都只有打开那个会话才能完成。进展面板恰恰是唯一持续盯着所有运行中会话的地方——它已经从同一份状态快照里显示「等待」chip——但那个 chip 只说明有事在等。盯着进展的人必须离开面板才知道等的是什么。

## [S2] 设计

### S2.1 值从哪里来

`ui-session` 按会话发布审批包登记的那条待处理交互（`SessionStatus.pendingInteraction`）。进展面板本来就为「等待」chip 选择该快照，因此它手里就是那个确切的请求——与会话里审批卡作答的是同一个对象——不需要打开会话，也不需要新 RPC。

该值的类属于 `ui-approval`，面板不能导入它。面板改读结构：`kind === 'approval'`、`key`、`toolName`、`reason`、可选的 `displayReason`、`answerable`，以及 `answer(decision)` 回调。缺少判别字段或回调的值（问题、计划评审、已结算的请求）不算审批，不渲染审批条。

### S2.2 审批条的位置

在该会话行下方、同一个列表项内部。整行本身就是一个打开会话的 `<button>`，把决定嵌进去就变成按钮套按钮——那不是浏览器能激活的控件。审批条是它的兄弟节点，这也让决定的点击不会顺带打开会话。

### S2.3 审批条显示什么、做什么

- 文本：请求方提供了文案时用 `displayReason`，经多语言座位（`ctx.locale.resolveText`）解析；否则用审计 `reason`；再否则用面板本地化的「工具 `{tool}` 请求越权执行」。
- 决定：「拒绝」与「允许一次」，各自的无障碍名称包含会话标题，因此读列表的读屏使用者知道它决定的是哪个会话。
- 作答调用 `approval.answer(decision)`，占用一次性守卫，结算期间禁用两个按钮，失败后恢复。它结算的是与会话卡片同一个 Host waterfall；卡片与审批条一起消失，因为两者读的是同一条已发布的请求。

### S2.4 限制

- 文本是请求方原文：沙箱越权读作 `escalate sandbox to <mode>: <一句话>`。结构化的目标（命令、路径、diff）需要在审批请求上增加摘要字段；本次不加。
- 待审批只存在于收到它的那个客户端；刷新或重连后 Host 已按 `unavailable` 结算，因此不会重新出现审批条。
- 审批条只在面板打开且状态快照存活时出现；它不是通知。

### S2.5 测试

`plugins/dsh-agent-progress/scripts/smoke.mjs` 通过与 shell 相同的模块加载器握手加载构建产物 `lib/client.js`，用合成列表与状态快照渲染页面，并新增断言：审批会话有一条审批条、问题类等待没有；请求方文本与两个决定都在；点击决定把 `allowed-once` 送到该请求。

## [S3] 范围

- 范围内：面板对待审批值的推导、审批条、两个决定、字典键、审批条样式，以及插件冒烟断言。
- 范围外：会话里的审批卡、Host 审批语义、结构化摘要字段、通知，以及对会话列表的任何改动。

## 任务

- [x] T1：从状态快照推导待审批值（`progress.ts`）
- [x] T2：在行旁边渲染审批条与两个决定（`index.tsx`）
- [x] T3：添加字典键与审批条样式
- [x] T4：经多语言座位解析请求方文案
- [x] T5：扩展插件冒烟：审批条、两个决定、无审批条的情形
- [x] T6：重建 `lib/client.js` 并更新包 README 对照件

## [S4] 验收

- [x] 等待审批的会话在面板里显示请求方文本与两个决定（`smoke.mjs`：一条审批条、文本、`reject`/`allowOnce`）
- [x] 审批条上的决定会作答该请求（`smoke.mjs`：点击允许送出 `allowed-once`）
- [x] 等待其他交互类型的会话只显示 chip、没有审批条（`smoke.mjs`：问题类会话）
- [x] 插件通过类型检查与打包（`tsc -p plugins/dsh-agent-progress/tsconfig.json`、tsdown）
