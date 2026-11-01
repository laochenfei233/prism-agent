---
feature: approval-sidebar
status: delivered
updated: 2026-11-01
branch: feat/approval-sidebar
commits: c22ec9f0b9..HEAD
---

# 会话行内的审批

[English](approval-sidebar.md) | 中文

## Report

**已构建** — 审批请求现在有第二处呈现，就在会话列表里。`ui-workspace` 声明了按行挂载的 `sidebar.workspaces.session.pending` 座位，并在任何未归档、非空白且 `pendingInteraction` 存在的会话行上把它渲染成整行宽的第二行；只有这一行会切到 `flex-wrap: wrap` 与 `height: auto`，其余行保持 32 px 单行。`ui-approval` 注册占位组件：它从 `useSessionStatus` 读取该行的请求，用 `instanceof PendingApproval` 收窄，并把请求方的一行摘要渲染在 拒绝 / 允许一次 旁边。摘要优先用本地化的 `displayReason`，其次 `reason`，再否则用工具文案；该行不重复第一行已有的 warning 橙点和「待审批」标签。两个按钮走输入框卡片原来那套结算守卫（现已抽出为 `useApprovalAnswer`），其无障碍名称包含会话标题，因此输入框卡片仍保有现有测试与快捷键依赖的那个精确的 "Allow once" 名称。在任一处作答都结算同一个 Host waterfall，另一处随之撤回。

**验证** — `node ./node_modules/vitest/vitest.mjs run packages/client/ui-approval packages/client/ui-workspace` 通过 15 个文件、518 个测试，其中包含 `RowApproval` 的 8 个新用例与新增的行内座位用例。`pnpm run typecheck` 五项门禁全部通过（host 编译器、host 聚合、Host Typert、client 编译器、client 聚合）。`DSH_SNAPSHOT=replay node ./node_modules/vitest/vitest.mjs run --config vitest.web.config.ts apps/web/tests/built-boot.expected.e2e.ts` 在重新构建的插件产物上通过 2 个测试，其中新增断言证明组装后的侧栏行显示 fixture 审批的摘要、给出两个带会话名的决定，并在输入框卡片作答后失去该行。`pnpm run test:gui` 报告 11008 通过，8 个套件与 6 个测试失败；把这些改动 stash 掉的同一分支上，同样这些套件与其中 5 个测试以相同方式失败（第 6 个是同一个 `connection` 套件的第二个变体），因此它们属于 PRE-EXISTING。`pnpm exec tsx scripts/run-oxlint.ts packages/client/ui-approval packages/client/ui-workspace` 在改动文件中没有报告任何问题；它剩下的一条是 `packages/client/ui-workspace/tests/apply.client.spec.ts:923` 的既有 `unbound-method`，该文件本次未改动。`pnpm run verify-translation-pairing` 报告四对改动文档一致，`pnpm run verify-client-ui-i18n` 扫描 1098 个文件通过。

**过程记录**

- 行内作答不需要任何 Host 改动：`useSessionStatus` 本来就按会话发布完整的 `PendingApproval`，`answer()` 直接结算 Remote waterfall；组装启动里的常驻 fixture 早就覆盖了未打开会话的情形。
- 只有正在等待的行会变高，其余行维持 32 px 单行。第一行已有 warning 橙点与「待审批」尾标，第二行把宽度留给请求方的文本，而不是重复状态。
- 摘要保持请求方原文。`approval/request` 刻意不带工具参数，因此结构化的目标（命令首行、文件路径、diff 规模）需要在请求及其审计事件上新增摘要字段；这一点记为限制，而不是从 reason 字符串里猜。
- 两个实现约束出现得较晚：list slot 注册必须带 `id`；钩子若返回方法签名的成员，解构时会触发 `unbound-method`，因此守卫返回属性式函数，占位组件通过 props 对象解析文案。
- 这个沙箱无法为工作树做全新安装（符号链接与 postinstall 都报 `spawn EPERM`），因此验证用的是把主检出 `node_modules` 以目录 junction 挂到工作树；测试运行器通过 `tsconfig.base.json` 的 paths 解析工作区包，所以编译与加载的确实是本工作树的源码。

## [S1] 问题

待审批的请求只有一处到达用户：发起它的那个会话输入框上方的接管卡。侧栏的会话行只说「等待审批」，别的什么都没有，于是「谁要做什么」只有打开那个会话才知道，「批准」也只能在那里发生。同时开着多个会话时，一个卡在审批上的后台会话，就等在一行用户没有理由点开的行上。

会话行也正是用户已经在扫的地方，而且数据早就在了：`useSessionStatus` 为客户端持有的每个会话发布待处理交互，工作区浏览器也已经把它折进每行的状态。行里缺的是内容和一个动作，不是通路。

## [S2] 设计

### S2.1 客户端已经持有的东西

`ui-approval` 为它所拥有的会话应答转发来的 `approval/request` waterfall，并通过 `uiSession.registerPendingInteraction` 发布一个 `PendingApproval`。全局标准钩子 `useSessionStatus` 以 `SessionStatus.pendingInteraction` 按会话暴露该值，而 `WorkspaceBrowser` 已经选择整张状态表，所以行内的占位组件不必打开会话就能读到那次请求。作答调用 `PendingApproval.answer`（`allowed-once` 或 `rejected`），它结算 Remote waterfall；不涉及任何 Host 调用、存储改动或新的会话事件。

投递不依赖会话是否已打开。组装启动测试里的常驻 fixture 就为一个未打开的会话渲染 `Waiting for approval`，并在进入该会话后应答它的审批（`apps/web/tests/built-boot.expected.e2e.ts`）。

请求携带 `toolName`、可选的 `reason`、可选的本地化 `displayReason` 和 `callId`；它刻意不带工具参数（[approval.md](../../subsystems/approval.zh.md)）。因此一行摘要只能来自 `reason` 与 `displayReason`。

### S2.2 行内座位

`ui-workspace` 声明一个新的列表 slot：

`sidebar.workspaces.session.pending` —— 作用域 `root`，owner 为 `SessionRowOwnerProps`（`sessionId`、`displayTitle`），渲染在会话行内作为它的第二行。

声明保持与状态单元格同样的域无关：只要该行的 `pendingInteraction` 存在，浏览器就渲染这个座位——树已经为三种交互类型都推导了该字段——而 ui-workspace 不出现任何审批类型。占位组件由 `ui-approval` 注册，审批的呈现留在拥有该请求的包里。

归档行与空白行沿用现有规则。归档行的状态单元格留空，空白行不出现行内动词，因此待审批行只对非归档、非空白的行渲染。

### S2.3 占位组件

`ui-approval` 向该座位注册一个紧凑组件。它按 `sessionId` 从 `useSessionStatus` 读取待处理值，用 `instanceof PendingApproval` 收窄，并渲染一行：

`<摘要>  [拒绝] [允许一次]`

- `displayReason` 存在时，`summary` 经注入的多语言座位解析；否则用 `reason`；再否则用本地化的「工具请求越权执行」文案。
- 行自身的状态单元格已经在第一行给出 warning 橙点和紧凑的「待审批」标签，因此第二行不再重复这两者，宽度全部留给请求方的文本。
- 该行单行省略，元素的 `title` 承载完整文本。
- 两个按钮都是 ui-primitives 的 `Button size="sm"`，并通过 `PendingApproval.answer` 作答。输入框卡片已经实现的结算守卫移入一个内部钩子（`useApprovalAnswer`），两处呈现共用它；结算失败时按钮恢复可用。
- 按钮像行内动作条一样阻止行自身的点击（`stopPropagation`）。

### S2.4 布局

只有座位被占用时，会话行才变成两行。浏览器为有待处理交互的行加一个类，该类把该行切到 `flex-wrap: wrap` 与 `height: auto; min-height: 32px`；待审批行取 `flex: 0 0 100%`，并对齐标题的缩进。其余行保持当前的 32 px 单行，未占用的座位不渲染任何行。

### S2.5 文案与无障碍

按钮沿用现有的 `拒绝` / `允许一次` 文案，并带有包含会话标题的 `aria-label`（`允许一次：<标题>`），于是屏幕阅读器在读列表时知道这个按钮决定的是哪个会话，而输入框卡片仍保有现有测试要查询的那个精确的 "Allow once" 可及名称。

审批文案的导入留在 ui-approval 的命名空间里；ui-workspace 不新增任何审批用词。输入框卡片保留 Enter/Esc 快捷键；行只通过按钮作答，不自己占用按键。

### S2.6 限制

- 摘要就是请求方自己的文本。沙箱越权当前形如 `escalate sandbox to <mode>: <模型的一句话>`，因此那段固定的英文前缀会保留可见。结构化的目标（命令首行、文件路径、diff 规模）需要在 `approval/request` 与 `approval/asked` 上增加摘要字段，本次不改。
- 待审批只存在于收到它的那个客户端。刷新或重连会按既有的失败关闭规则把 Host 的 waterfall 结算为 `unavailable`，因此已消失的请求不会在行里重新出现。

### S2.7 测试与快照

- `ui-approval` 组件规格：占位组件渲染摘要并通过 `answer` 作答；结算进行中按钮禁用，失败后恢复；会话持有其他交互类型时什么都不渲染。
- `ui-workspace` 组件规格：座位只为有待处理交互的行渲染，行类跟随同一事实。
- 组装输出：`apps/web/tests/built-boot.expected.e2e.ts` 里的常驻审批与侧栏快照预期会新增这一行；录制输出只在新增行就是预期差异处更新。
- `pnpm run test:gui` 覆盖客户端套件；`DSH_SNAPSHOT=replay pnpm run test:web` 覆盖组装输出。

## [S3] 范围

- 范围内：
  - 会话行内的 `sidebar.workspaces.session.pending` 座位及其占位组件
  - 行内的一行摘要以及 拒绝 / 允许一次
  - 两处审批呈现共用的 `useApprovalAnswer` 守卫
  - 多语言键、组件规格与受影响的侧栏快照
- 范围外：
  - Host 的审批语义、审批触发点与 `approval/request` 负载
  - 结构化目标（命令、路径、diff）以及任何新的摘要字段
  - 通知、toast 与悬停卡
  - 除共用作答守卫之外对输入框卡片的重做

## 任务

- [x] T1：在 ui-workspace 的 slot 约定中声明 `sidebar.workspaces.session.pending`，并贯通浏览器的 children 与 props 类型（依赖：无）
- [x] T2：把座位渲染为行的第二行，并添加待审批行的布局类（依赖：T1）
- [x] T3：从 `ApprovalPanel` 抽出 `useApprovalAnswer` 并在那里使用（依赖：无）
- [x] T4：在 ui-approval 注册行内占位组件，包含摘要、两个按钮与新的多语言键（依赖：T1、T3）
- [x] T5：占位组件与座位的组件规格（依赖：T2、T4）
- [x] T6：更新组装输出预期与侧栏快照（依赖：T4）
- [x] T7：为每个分歧点标注 `PRISM-DIVERGENCE` 并补全 S5（依赖：T2、T4）

## [S4] 验收

- [x] 有待审批的会话行在未打开该会话时，显示请求方的一行摘要与 拒绝 / 允许一次（ui-approval 规格）
- [x] 从行内作答结算的是输入框卡片所显示的同一个审批，两处呈现同时消失（ui-approval 规格）
- [x] 没有待处理交互的行保持 32 px 单行，且不渲染待审批行（ui-workspace 规格）
- [x] 持有问题或计划评审的会话不渲染审批行（ui-approval 规格）
- [x] 结算失败后两个按钮仍可用（ui-approval 规格）
- [x] 组装后的侧栏为常驻审批显示新增行，且从输入框卡片作答后该行消失（`apps/web/tests/built-boot.expected.e2e.ts`）

## [S5] 上游分歧

本检出把上游作为一个基线提交整体导入，因此之后的上游导入会整文件替换而不是合并这些文件。下列每个分歧点都带 `PRISM-DIVERGENCE` 注释，`rg PRISM-DIVERGENCE` 无需读本节即可列出它们。

| 文件 | 分歧点 | 重放必须保留的内容 |
| --- | --- | --- |
| `packages/client/ui-workspace/src/client/contract/slots.ts` | `sidebar.workspaces.session.pending` 声明及其文档 | 该 slot、它的 owner 类型与域无关的占用规则 |
| `packages/client/ui-workspace/src/client/index.ts` | `sidebar.workspaces` 注册项里的子 slot 声明 | 与行内已有的两个 list 座位并列的该座位声明 |
| `packages/client/ui-workspace/src/client/rows/Rows.tsx` | `SessionNodeItem` 内的待审批行 | 第二行、它的条件与待审批行类 |
| `packages/client/ui-workspace/src/client/rows/Rows.module.css` | 待审批行与待审批行的样式规则 | 两行布局及其收起 |
| `packages/client/ui-approval/src/client/index.ts` | 第二个 slot 注册与共用的 `approvalInjected` 工厂 | 占位组件注册、它的 `id`，以及两处呈现共用同一个理由解析器 |
| `packages/client/ui-approval/src/client/RowApproval.tsx` | 行内占位组件 | 摘要的回退顺序与 `displayReason` 的解析 |
| `packages/client/ui-approval/src/client/RowApproval.module.css` | 行、摘要与动作区规则 | 单行摘要与右对齐的两个决定 |
| `packages/client/ui-approval/src/client/use-approval-answer.ts` | 共用的作答守卫 | 每个请求只作答一次，以及结算失败后的恢复 |
| `packages/client/ui-approval/src/client/ApprovalPanel.tsx` | 用它自己的守卫替换为 `useApprovalAnswer` | 两处呈现通过同一个守卫作答 |
| `packages/client/ui-approval/src/client/locales.ts` | 行的 aria-label 键 | 它们与输入框卡片文案的配对 |
