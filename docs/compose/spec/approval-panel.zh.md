---
feature: approval-panel
status: delivered
updated: 2026-11-02
branch: feat/approval-panel
commits: d26a0ebaee..HEAD
---

# 审批的两个入口

[English](approval-panel.md) | 中文

## Report

**已构建** — 待审批的请求在两处可见：对话列表里该会话行的第二行，以及进展面板里该行下方的审批条；但只有其中一处带决定。一个「审批位置」偏好（默认进展面板）决定是哪一处；两处始终显示请求文本，不负责决定的那一处给一句提示，说明决定在哪里。

## [S1] 问题

审批卡在发起它的会话输入框上方，于是「要批什么」和「批准」都必须打开那个会话。有两个地方本来就在不打开会话的情况下盯着所有会话——对话列表和进展面板——但它们都只显示「有事在等」。

## [S2] 设计

### S2.1 值从哪里来

`ui-session` 按会话发布审批包登记的那条待处理交互（`SessionStatus.pendingInteraction`）。两处都读这份快照：行内占位组件经该座位的会话状态钩子读取，面板经它原本就在用的同一个全局钩子读取。不涉及 Host 调用，也没有新的线上字段。

面板不导入发布该值的包，而是按结构读取：`kind === 'approval'`、`key`、`toolName`、`reason`、可选的 `displayReason`、`answerable`，以及 `answer(decision)` 回调。缺少判别字段或回调的值（问题、计划评审、已结算请求）不渲染审批条。

### S2.2 两个入口

- **会话行**（`sidebar.workspaces.session.pending`，由 `ui-workspace` 声明、`ui-approval` 填充）：在未归档、非空白且 `pendingInteraction` 存在的行上多出整行宽的第二行；只有座位真的渲染出内容时才占高度，其余行仍是 32 px 单行。
- **进展面板审批条**：在该会话行下方、同一个列表项内部。整行本身是按钮，把决定嵌进去就不是浏览器能激活的控件，所以审批条是它的兄弟节点。

### S2.3 审批位置偏好

一个浏览器偏好，两侧共读共写：键 `dsh.approval.placement`，窗口事件 `dsh:approval-placement`，取值 `progress`（出厂默认）与 `list`。两处控件写它：进展面板头部的一组两个按钮（`aria-pressed` 表示当前选择），以及设置 → 通用里的 `ApprovalPlacementRow`（注册进 `settings.general.item` 列表槽）——从不打开面板的人也能找到这个选项。每一处按自己的通道读取——行内占位组件与设置行走注入的 `hooks` 隔间，面板用本地状态并在事件与 `storage` 变化时刷新——然后渲染决定，或渲染一句指向另一处的提示。

该偏好按浏览器与 origin 保存，和其它视图偏好一致；它不是 Host 设置，也不跨设备同步。

### S2.4 作答

只有拥有决定权的一处渲染 拒绝 / 允许一次。决定调用请求的 `answer(decision)`，带一次性守卫，结算期间禁用两个按钮，失败后恢复。两处显示的是同一条已发布的请求，因此在任一处作答都结算同一个 Host waterfall，另一处的行或审批条随之消失。无障碍名称包含会话标题，因此输入框卡片那个朴素的 "Allow once" 仍然唯一。

### S2.5 限制

- 文本是请求方原文：沙箱越权读作 `escalate sandbox to <mode>: <一句话>`。结构化的目标（命令、路径、diff）需要在审批请求上增加摘要字段。
- 待审批只存在于收到它的客户端；刷新或重连后 Host 已按 `unavailable` 结算。
- 两处都不是通知：只有列表或面板打开时才可见。

### S2.6 测试

- `ui-approval` 规格：占位组件在两种位置下都显示摘要，只有在位置指向行内时才给出决定，并通过请求作答；设置行显示两个位置、写入所选值，并反映别处改变的值。
- `ui-workspace` 规格：座位只为有待处理交互的行渲染；样式表只让有内容的行变高。
- `prism-progress` 冒烟（`scripts/smoke.mjs`）：经模块加载器握手加载构建产物，断言出厂位置下审批条带决定；通过头部控件切换位置，再断言审批条保留文本、给出提示且没有决定。

## [S3] 范围

- 范围内：行内座位与其占位组件、面板审批条、审批位置偏好及其两个控件（面板头部、通用设置）、字典键、样式，以及上述测试。
- 范围外：输入框卡片、Host 审批语义、结构化摘要字段、通知，以及按会话区分的审批位置。

## 任务

- [x] T1：声明行内座位并渲染其占位组件（`ui-workspace`、`ui-approval`）
- [x] T2：为面板推导待审批值并渲染审批条（`prism-progress`）
- [x] T3：两侧共读共写审批位置偏好
- [x] T4：把位置控件放进面板头部与通用设置
- [x] T5：两种位置下的组件规格与插件冒烟
- [x] T6：重建 `lib/client.js`，更新三个 README 对照件与本文件

## [S4] 验收

- [x] 等待中的会话在列表与面板里都显示请求文本（`ui-approval` 规格、冒烟）
- [x] 出厂位置把决定放在面板，列表里留提示（冒烟、`ui-approval` 规格）
- [x] 切换位置后决定移到列表，面板里留提示（冒烟）
- [x] 决定会作答该请求并禁用两个按钮（`ui-approval` 规格、冒烟）

## [S5] 上游分歧

本检出把上游作为一个基线提交整体导入，因此之后的上游导入会整文件替换而不是合并这些文件。下列位置带指向本文档的 `PRISM-DIVERGENCE` 标记；两个 manifest 与 tsconfig 引用没有注释语法，在此点名。

| 文件 | 分歧点 | 重放必须保留的内容 |
| --- | --- | --- |
| `packages/client/ui-workspace/src/client/{contract/slots.ts,index.ts,rows/Rows.tsx,rows/Rows.module.css}` | `sidebar.workspaces.session.pending` 座位、它的子 slot 声明、第二行及其 `:has()` 布局 | 座位与待审批行；这些文件已因其它分叉工作带 A12 标记 |
| `packages/client/ui-approval/src/client/{index.ts,ApprovalPanel.tsx,locales.ts,RowApproval.tsx,RowApproval.module.css,use-approval-answer.ts,placement.ts}` | 占位组件、共用作答守卫、审批位置偏好与行内文案键 | 在上游版本上重新应用；`placement.ts`、`RowApproval*` 与 `use-approval-answer.ts` 在上游没有对应物 |
| `packages/client/ui-approval/{package.json,tsconfig.json}` | `@deepseek-ai/dsh-client-ui-workspace` devDependency、它的 `dsh.client.inject` 行与项目引用 | 三处接线；没有注释语法，重放按此执行 |
| `plugins/prism-progress/{src/client/{index.tsx,progress.ts,placement.ts,locales.ts,styles.ts},scripts/smoke.mjs,README*}` | 面板审批条、位置控件与冒烟断言 | 整个插件都是分叉独有，原样拷贝 |
