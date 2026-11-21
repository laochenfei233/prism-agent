---
feature: side-chat-panel
status: delivered
updated: 2026-11-04
branch: feat/side-chat-panel (worktree .worktrees/side-chat-panel)
commits: 50ff54bd96..57ce788948
---

# 侧边对话面板

[English](side-chat-panel.md) | 中文

## Report

**做了什么** —— 对选中消息文字的二级点击现在能在对话旁提问。既有的「在侧边对话中提问」条目在浏览中会话的工作区里创建一个会话，并作为右侧栏 tab（`dsh-resource://sidechat/session/<id>`）打开，选中段落作为引文暂存在那个对话的输入框里；什么都不发送，主对话保持自己的选择与滚动位置。`ui-chat` 注册 `sidechat` 资源协议、它的 `builtin` tab 类型、经共享 `conversation.content` Factory 的 tab 正文，以及该正文承载的嵌套对话 seat。资源在 tab 存活期内持有一个会话引用，在会话打开落定后暂存一次引文，把意外的打开失败报告为资源失败帧，并在 tab 关闭时释放引用。

**验证** —— `pnpm exec vitest run packages/client/ui-chat` 通过（53 个文件，869 个测试）；`pnpm run test:gui` 通过，除六个在未改动 master 上同样失败的套件（`ui-directory-picker-native` client-flow、`connection` binary-rpc、`ui-primitives` icons、`ui-theme` corner-shape、menu-surfaces、scrollbar-styles）——既有；`pnpm exec tsc -b packages/client/ui-chat/tsconfig.client.json` 与客户端聚合 `tsc -p tsconfig.client.json` 通过；`pnpm run build` 对 artifacts、host bundle、客户端编译器、客户端 bundle、客户端聚合检查与 Web 构建全部通过，host 聚合检查在 master 上同样失败（`connection/tests/browser-auth.host.spec.ts:100`）——既有；`pnpm run verify-client-ui-i18n` 通过；`pnpm run lint` 对被改文件干净（全仓库报告在 master 上本就失败）；其余文档门禁失败为分叉的既有漂移。

**过程记录** —— 把 `resources` 与 `conversation` 作为硬插件注入要求后，先后打破 27 个、18 个无关挂载套件；两者都改为限定作用域的可选注入，与既有的可选 tab 注册表一致。资源提供方的第一形态在 tab 于打开中途关闭时从 `open()` 抛出，而资源模型只读失败帧，因此它现在产出 `{ ok: false }` 并释放。仅以 `{ cwd }` 创建会让会话在下一次 Host bootstrap 之前不归组，因为 Host 只为显式 `workspaceId` 附加工作区成员关系。

## [S1] 问题

对话文字上的二级点击提供「在侧边对话中提问」。它为选中段落创建一个会话并用它替换主对话，读者丢失正在读的段落，回答也在另一个视图里到达。`dsh-sidebar-qa` 插件展示了另一种形态：在对话旁、右侧栏里提问，不离开主视图。

## [S2] 设计

**S2.1 —— 创建位置移动，手势不动。** 菜单条目保留它的标签与随选择变化的文字。它经 `sessions.create({ workspaceId })` 在持有当前会话的工作区中创建会话（没有工作区列出它时回落到 `{ cwd }`），并作为右侧栏 tab 打开；主视图继续显示当前对话。

**S2.2 —— 一个 tab 类型承载侧边对话。** `ui-chat` 注册以 `dsh-resource://sidechat/session/<id>` 寻址的 `sidechat` 资源协议与同类的 builtin tab 类型。资源提供方在 tab 存活期内持有一个会话引用（`source: 'sideChat'`），tab 关闭时释放；tab 正文用 `SessionProvider` 包住嵌套的 `chat.side.conversation` seat，后者以 `variant: 'embedded'` 与激活阶段渲染共享的 `conversation.content` Factory，面板因此携带普通 transcript 与自己的输入框。

**S2.3 —— 引文只暂存，从不发送。** 该动作把被引用的文字记录在插件自己的映射里、挂在创建的会话 id 下；资源提供方等待 `reference.ready`，消费该条目，并以 `whenDraftExists: 'append'` 把它交给 `conversation.input.requestDraftInitialization`。阅读者仍自己写问题并发送。

**S2.4 —— 失败保持局部。** 被拒绝的创建在控制台报告，当前视图不动。打开被持有会话时的意外失败变成 tab 上的 `sidechat/open-failed` 失败帧而不是抛出；输入枢纽拒绝的草稿初始化让面板保持打开、输入框为空。

**S2.5 —— 词典文案。** tab chip 的标题是一个 Chat locale 键。

## [S3] 范围

- 范围内：消息菜单动作的去向、`ui-chat` 资源提供方与带正文的 `sidechat` tab 类型、草稿交接、locale 键、测试与包 README。
- 范围外：`dsh-sidebar-qa` 的上下文策略（fork、压缩、裁剪）、摘要生成、嵌套追问、追问历史树、按面板的模型选择与选择浮层。面板承载一个普通会话，使用工作区的默认 Agent 预设与模型。

## Tasks

- [x] T1：`ui-chat` 中的 `sidechat` 资源、tab 类型与 tab 正文 (covers: S2.2)
- [x] T2：菜单动作创建并打开侧边会话；locale 标题 (covers: S2.1, S2.3, S2.5)
- [x] T3：地址、提供方交接、正文与改动动作的规格 (covers: S2.2, S2.3, S2.4)
- [x] T4：包 README 与 manifest 更新 (covers: S2.5)

## [S4] 验收

- [x] 对选中消息文字的二级点击打开右侧栏，新的侧边对话在其输入框中持有引文，主对话仍显示自己的会话。（`apply-inject.client.spec.tsx` "opens a side conversation in the right Sidebar and stages its quotation"；`side-chat.client.spec.tsx` "creates the Session in the Workspace holding the viewing Session" 与两个 `SideChatTab` 用例。）
- [x] 关闭 tab 释放被持有的会话引用。（abort 之后 `retainedBy.sideChat` 不存在，资源提供方的 disposer 在插件拆卸时运行。）
- [x] 创建或资源打开失败时，当前对话与侧栏不变。（创建被拒只记日志、不开 tab；被拒的 `reference.ready` 产出 `ok: false` 帧并仍然释放。）
- [x] 聚焦客户端测试、`test:gui`、typecheck 与客户端构建通过。
