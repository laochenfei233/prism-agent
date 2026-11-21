---
feature: context-menu-plugins
status: delivered
updated: 2026-11-04
branch: feat/context-menu-plugins (worktree .worktrees/context-menu-plugins)
commits: 50ff54bd96..51342066b9
---

# 右键菜单的插件行

[English](context-menu-plugins.md) | 中文

## Report

**做了什么** —— 已定稿助手消息的右键菜单现在可以携带插件行。ui-chat 声明 `conversation.chat.message.menu.item`，作为 `assistant-step` 节点渲染器的子级；消息菜单在自带的复制、加入输入框与侧边对话三行之后渲染插件条目，每个条目通过注入的 `useMenuOpenState` 钩子关闭菜单。门槛是节点视图已持有的持久消息 id（`AssistantChatData.finalNode`），因此流式、用户与空正文仍只有自带三行。ui-message-feedback 在那里注册它的两个评分行（order 10），并打开与悬停条相同的单条消息反馈对话框；悬停条保留二次点击收回的行为。Session 行既有的 `sidebar.workspaces.session.menu.item` 路径不动。

项目标题的右键菜单得到同样的待遇：ui-workspace 声明 `sidebar.workspaces.project.menu.item`，`prism-transfer` 在那里注册 **导出项目**（order 900），经既有的流式路由把该工作区的单项目归档交给浏览器下载管理器。禁用态的「导出（开发中）」占位行已删除，多项目与设置归档仍由设置页承担。

**验证** —— `node node_modules/typescript/bin/tsc -b tsconfig.client.json` 在最终改动后退出码 0。聚焦 vitest 套件通过：`packages/client/ui-message-feedback/tests` 与 `packages/client/ui-chat/tests/chat-message-actions.client.spec.tsx` 106/106，`packages/client/ui-workspace/tests/rows.client.spec.tsx` 69/69，`packages/transfer/prism-transfer/tests` 199 通过、1 跳过（该目录的 `route.spec.ts` 抛出一处未处理拒绝，在未改动检出上同样复现，属既有）。`gen-client-catalog --check` 报告 catalog 为最新。被编辑的文档对通过 `verify-translation-pairing`；全仓库运行报告与此无关的既有 out-of-sync 对。`chat-view.client.spec.tsx` 在本机无法运行（沙箱无法创建 pnpm 需要的符号链接，而 hoist 布局会复制 React），因此它那处仅类型层面的 helper 改动依赖客户端聚合 typecheck，流式/用户正文的门槛依赖已测试的「无插件条目时渲染自带行」路径，而不是组装一次真实右键。

**过程记录** ——

- 把 `messageId` 传进 `AssistantMarkdown` 并加宽它的 `renderSlot` prop，破坏了既有测试桩的上下文类型；已定稿消息的 extras 改为由节点视图提供的一个对象，组件自身的 `renderSlot` 类型保持不变。
- 回调形态的 extras prop 会留下一个只在菜单打开时才运行的 lambda，没有诚实的覆盖方式；对象形态把 slot 调用留在测试驱动的钩子里。
- 本 worktree 跑 vitest 需要 pnpm 的 hoist 布局（无符号链接权限），跑 tsx 又需要隔离布局，因此测试在主检出中运行：把改动文件拷入再还原，脚本门禁在切回之后运行。

## [S1] 问题

五个客户端界面新增的右键菜单都在内部拼装自己的行。对话文字菜单是最明显的缺口：助手消息的悬停条经 `conversation.chat.assistant-actions` 渲染插件条目（ui-message-feedback 在那里注册它的赞/踩控件），而右键同一段文字只有 ui-chat 硬编码的三行——复制、加入输入框、在侧边对话中提问。插件动作从菜单不可达，未来任何单条消息动作都得改 ui-chat 本体。

## [S2] 设计

**S2.1 —— 一个消息菜单 slot。** `@deepseek-ai/dsh-client-ui-chat` 声明新的 list slot `conversation.chat.message.menu.item`（session 作用域，owner `{ messageId }`），作为 `assistant-step` 节点渲染器的子级。它的条目在同一份 `Menu` 列表中渲染在自带行之后，并经注入的 `useMenuOpenState` 钩子关闭菜单，与 Session 行的 `sidebar.workspaces.session.menu.item` 约定一致。只有已定稿的助手消息才携带持久 `messageId`（`AssistantChatData.finalNode`），因此流式消息、用户气泡与空正文不渲染插件行。

**S2.2 —— 标准动作保持自带。** 复制、加入输入框与在侧边对话中提问仍是 `chat-message-actions.tsx` 中的内联行，渲染在 slot 条目之前。插件可以增加行，但不能移除标准动作。

**S2.3 —— 反馈注册菜单行。** `@deepseek-ai/dsh-client-ui-message-feedback` 增加 `MessageFeedbackMenuItems`，两行通过悬停条所用的同一 `openDialog` 动词、以所选评分打开既有的单条消息反馈对话框。悬停条保留二次点击收回的行为；菜单刻意总是打开对话框，这是产品记录或修改评价的规范途径。

**S2.4 —— 不新增生命周期。** 贡献沿用既有 `ctx.slots.inject` 的等待，随插件 fiber 一起离开；菜单的关闭是按压点状态，`useContextMenu` 已持有它。

**S2.5 —— 行是动词。** `menu.like` 与 `menu.dislike` 以两种语言加入反馈词典（「标记为好的回答」/ "Mark as a good response"），而不是复用悬停条的动作标签。

**S2.6 —— 项目行走同一条路由。** ui-workspace 为项目标题的按压点菜单声明 `sidebar.workspaces.project.menu.item`（root 作用域，owner `{ workspaceId, displayTitle }`），带同样的关闭钩子。`prism-transfer` 在那里注册 `export-project`（order 900）：它构造 `GET /api/prism.transfer/export?projects=<id>&settings=0&secrets=0` 并点击一个下载锚点，归档因此经浏览器下载管理器流出，而不是走 tab。该路由按项目限定作用域，所以 Session 行不获得导出；自带的禁用导出占位行被删除，而不是留成第二行死行。

## [S3] 范围

- 范围内：消息菜单 slot 及其钩子、反馈菜单行与注册、项目菜单 slot 与 transfer 导出行、聚焦的组件与销毁测试、重新生成的客户端 slot catalog，以及 ui-chat、ui-workspace 与 prism-transfer 的 README 备注。
- 范围外：文件树与输入框菜单——没有插件在那里注册行，因此不添加零消费方的 slot；消息菜单中的分支与用量行（它们不是插件贡献）；改动助手动作条或其收回行为；按会话的归档路由（transfer 路由按项目限定，Session 菜单不加行）；设置页对项目行的带类型下载前校验（浏览器按原样下载路由响应）。

## Tasks

- [x] T1：声明 slot、其 owner props 与打开状态钩子工厂 (covers: S2.1)
- [x] T2：在消息菜单中渲染 slot 并把已定稿消息 id 传下去 (covers: S2.1, S2.2)
- [x] T3：加入反馈菜单行及其注册 (covers: S2.3, S2.5)
- [x] T4：聚焦测试、slot catalog 重新生成与 README 备注 (covers: S2.4)
- [x] T5：项目菜单 slot 与 transfer 导出行 (covers: S2.6)

## [S4] 验收

- [x] 右键已定稿的助手消息，标准行之后显示两条反馈行。（hook 测试加顺序断言）
- [x] 选择一条反馈行会关闭菜单，并为该消息以所选评分打开反馈对话框。（menu-row spec、registration spec）
- [x] 右键用户消息、流式消息或没有已定稿正文的正文，只显示标准行。（无插件条目时渲染自带行；节点视图从 `finalNode?.messageId` 推导 extras）
- [x] 销毁反馈贡献后菜单移除其行，悬停条继续渲染。（disposal spec 移除注册表条目；悬停条条目保留自己的 spec）
- [x] 项目行的二级点击显示 **导出项目**，选择它会关闭菜单并开始项目归档下载。（transfer menu-row spec 断言关闭动作与路由查询；rows spec 断言 slot owner 与插件行渲染）
- [x] 聚焦客户端测试、typecheck 与重新生成的 slot catalog 通过。
