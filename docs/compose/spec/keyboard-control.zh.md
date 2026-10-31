---
feature: keyboard-control
status: in-progress
updated: 2026-10-31
branch: feat/keyboard-control
commits: 13707d2897..<head>（交付时回填）
---

# Keyboard Control for the Prism Agent GUI

[English](keyboard-control.md) | 中文

## Report

设计闸口：尚未实现任何代码。本文档确认后开始第一阶段。

## [S1] Problem

界面已经拥有一套完整的命令层：按 runtime 与平台分别声明的默认键位并带冲突校验、可持久化的用户改键、以及用参考快捷键打开的可搜索快捷键表；但这套能力只对已经背下键位的人有用。

四个缺口让产品中很大一部分只能靠鼠标操作：

- **没有任何入口能按名字执行命令。** `Shortcuts.invoke` 已经存在，但只有桌面原生菜单适配器调用它，所以参考表中的每一行只能打开改键对话框，不能执行命令。不记得键位的用户没有键盘路径。
- **会话树无法用键盘到达。** 行的语义是 `role="treeitem"` 并带 `onClick` 打开，但没有 `tabindex`、没有按键处理，焦点永远落不到行上。会话搜索只提供了文本路径，浏览和阅读树仍然离不开指针。
- **没有在区域之间移动焦点的命令。** 左侧栏、会话主区和右侧面板是三个互不相通的键盘孤岛；模态原语只在对话框内部恢复焦点。
- **回到输入框属于鼠标操作。** 看完面板后想继续打字，必须点一下编辑器。
- **待答提问只能用指针回答。** 选项是按钮，题目流转靠点击，方向键、`Tab`、`Esc` 在这里都没有意义，于是用户正在打字时到来的提问会强制一次鼠标往返。

这就是反馈的症状：界面大部分需要鼠标，而现有快捷键只覆盖用户本来就会的动作。

## [S2] Design

### [S2.1] A palette that runs the registered catalog

在 `ui-shortcuts` 中新增命令 `commands.open`，打开一个可搜索的全部命令列表，并把选中的命令交给 `ctx.shortcuts.invoke` 执行。

列表直接来自现有的可观察命令目录，因此不需要第二套注册表：行渲染 `label` 与当前生效的键帽，过滤通过 `rankByName` 作用于本地化标签和命令别名。面板挂载后才注册的命令会立即出现，插件卸载的命令会随之消失。

面板拥有自己的小 store（`createCommandPaletteStore`），状态是 `open`、`close`、`search` 与选中行下标；所有状态都是 JSON 兼容值，store 在 `apply` 中创建并交给一个 `shell.overlay` 注册，沿用参考对话框的写法。

面板内的按键：输入即过滤并重置选中项，`ArrowDown`/`ArrowUp` 移动，`Home`/`End` 跳到首尾，`Enter` 执行，`Escape` 与点击遮罩的关闭仍由 `Modal` 原语负责。

执行时先关闭面板，再在下一个动画帧调用 `invoke`，此时模态原语已经把焦点还给唤起面板的元素；传入的上下文是 `{ region: 'page', modal: null, target: document.activeElement }`。`commands.open` 声明 `modals: []`，面板只会在没有其它对话框时打开，因此 `modal: null` 成立。

被拒绝的执行不能静默。`Shortcuts.invoke` 返回 `ShortcutResolution | undefined`：`undefined` 表示命令未注册或其模态闸口拒绝执行；`ShortcutResolution` 加入该包 client 入口的类型导出。面板在关闭状态下保持挂载，用自身 toast 显示本地化的 `reason`，与参考表报告保存失败的方式一致。执行成功的行静默关闭。

行不维护第二套可用性模型：未绑定键位的命令照样执行，键位冲突的命令照样执行，只有执行时才能判断的可用性才会被拒绝。面板是启动器，不是第二个设置界面。

### [S2.2] Region landmarks and cycling

三个元素加上 `data-dsh-region` 与 `tabIndex={-1}`：`ui-workspace` 的会话树容器、`ui-conversation` 的编辑器根节点、`ui-sidebar-right` 当前页面的容器。

`focus.cycle` 与 `focus.cycleReverse` 由 `ui-layout` 注册：按文档顺序收集 `[data-dsh-region]`，用 `document.activeElement.closest('[data-dsh-region]')` 找到当前区域，聚焦下一个或上一个地标并环绕。没有任何地标挂载时返回带本地化原因的拒绝，让收起的布局给出提示而不是吞掉按键。

用属性发现而不是新增服务，是因为这三个所有者本来就通过 DOM 解析命令——`ui-sidebar-right` 就是依据 `focusedTarget(element)` 决策的——属性把地标留在渲染它的包内。

### [S2.3] Composer focus

`focus.composer` 由 `ui-conversation` 注册，聚焦主区域的地标——编辑器根节点；没有输入框挂载时返回带原因的拒绝。

### [S2.4] Session tree keyboard navigation

树容器保留 `role="tree"`，在 `AnimatedRows` 内增加一个 `onKeyDown`：`ArrowDown`/`ArrowUp` 在可见的 `[role="treeitem"]` 之间按文档顺序移动焦点，`Home`/`End` 到首尾，`Enter` 通过行自己的点击处理激活当前行，于是打开、展开、折叠仍然只有指针使用的那一套行为。

行带 `tabIndex={-1}`、树容器带 `tabIndex={0}`，因此一次 Tab 就能到达整棵树；方向键把焦点移到某一行，`Enter` 按下该行。

处理函数忽略输入法合成，也忽略来自行内控件的按键——行菜单按钮与行操作按钮保留自己的键位。

### [S2.5] Phase 1 keymap

| 命令 | 所有者 | 桌面 macOS / Windows | 桌面 Linux | Web Windows / macOS |
|---|---|---|---|---|
| `commands.open` | `ui-shortcuts` | `Mod+Shift+P` | `Mod+Shift+P` | `Mod+Alt+P` |
| `focus.cycle` | `ui-layout` | `F6` | 未绑定 | `Mod+Alt+F6` |
| `focus.cycleReverse` | `ui-layout` | `Shift+F6` | 未绑定 | `Mod+Alt+Shift+F6` |
| `focus.composer` | `ui-conversation` | `Mod+L` | `Mod+L` | `Mod+Alt+L` |
| 树方向键、`Home`/`End`、`Enter` | `ui-workspace` | 本地 DOM 按键，不是绑定 | 同左 | 同左 |

每个默认键位在注册时都要通过 `bindingIssue`，Web 还要通过 `isWebBindingAllowed`。裸 `F6` 在任何适用修饰键规则的场合都会被拒绝，因此只声明给 macOS 与 Windows 桌面——桌面输入接受任何完整组合；Linux 桌面不使用 Ctrl+Alt+F6，因为它会与虚拟控制台切换冲突。Web Linux 不声明默认值，因为其可接受集合只有三个具体组合，而"未绑定"是合法声明。Web 遵循"不带 Alt 的默认键位改用 `Mod+Alt`"这条既有规则。新默认键位不与任何现有命令或固定动作重叠。

### [S2.6] Phase 2 backlog (out of scope here)

- 仍未注册命令、只能靠指针的动作：模型选择、主题、消息复制/重试/反馈、队列发送、计划与待办停靠面板、设置分区跳转。
- 右侧面板页面之间的 `page.next`/`page.prev` 循环。
- 新命令对应的桌面原生菜单项。
- 单键或前缀序列层，以及用户自定义命令分组。

### [S2.7] Compatibility, feedback, and gates

新默认键位是增量：没有任何既有绑定被挪动，用户保存的改键以命令 ID 为键，因此现有配置继续可用，新命令继承各自默认值。

面板、拒绝原因和三个焦点命令的文案放在各自所有者的字典里，中英文各一份，`verify-client-ui-i18n` 必须通过。

`packages/client` 下新增的 fork 自有文件在第 1 行带 `PRISM-DIVERGENCE` 标记；已存在的 fork 自有 `invoke` 接口保留原标记。

测试：面板 spec（按标签与别名过滤、执行、拒绝原因、关闭与焦点归还）、循环 spec（顺序、环绕、缺少地标）、输入框聚焦 spec、树导航 spec（方向键、`Home`/`End`、`Enter`、roving tab index）、提问 spec（选项移动、题目前进、取消）。验证先跑 `pnpm run test:gui`，再跑 `DSH_SNAPSHOT=replay pnpm run test:web`，因为这是产品可见变更。

### [S2.8] Questions and approvals on the keyboard

待答提问用这套键回答：`ArrowUp`/`ArrowDown` 移动选中项并让焦点跟随，`Home`/`End` 到首尾选项，`Enter` 确认当前这道题，`Tab`/`Shift+Tab` 在多题提问里前进到下一题或退回上一题，`Esc` 走既有的取消路径关闭整个提问——和它的"取消"按钮同一个动作，同样的确认与忙碌状态。

自定义回答框保留 `Enter` 继续、`Shift+Enter` 换行，指针与键盘走同一批处理函数，敲进去的回答不会被提交两次。

审批有两个动作，用同一套移动方式：`ArrowUp`/`ArrowDown` 与 `ArrowLeft`/`ArrowRight` 在"拒绝"和"允许一次"之间移动焦点，`Enter` 确认当前聚焦的动作（没有聚焦时仍然是允许一次），`Esc` 拒绝。两条路径都调用按钮本来调用的处理函数，因此记录下来的结果与输入设备无关。

### [S2.9] What can be rebound and what stays fixed

用 `ctx.shortcuts.register()` 注册的命令都能在设置 → 键盘里改键，包括第一阶段的全部命令；保存的覆盖值作用于用户当前所在的运行时与平台，和既有 profile 规则一致。

必须由持有焦点的控件自己处理的按键保持固定、在参考表里只读：输入框的 `Enter` 发送与 `Shift+Enter` 换行、连按两次 `Escape` 停止、输入框的 `/` 与 `@` 触发器、审批的 `Enter`/`Esc`。它们通过 `registerFixed` 贡献，因此照样显示键帽、参与冲突检查，并且不能被分配给命令。

提问按键保留在卡片内部、不注册为固定行：为卡片本身已经写明的按键而把 `Tab` 与方向键长期保留，会让它们从所有可编辑绑定中消失。卡片 README 记录这些按键。

分界依据是归属而不是重要性：应用级动作是命令，可以改；属于当前焦点控件的按键是固定的，改了会破坏该控件里的输入。

## [S3] Scope

- 范围之内：[S2.1] 到 [S2.5]、[S2.8]、[S2.9]，以及 [S2.7] 的检查。
- 范围之外：[S2.6] 的待办、触屏与移动布局、终端输入、会话内斜杠命令（`ui-commands`），以及任何改动键位存储或改键界面的工作。

## Tasks

- [x] T1：在工作树中确认工具链——`pnpm install --frozen-lockfile`、基线 `pnpm run test:gui`，并记录任何既有失败。（depends: none）
- [x] T2：让 `Shortcuts.invoke` 返回 `ShortcutResolution | undefined`，从该包 client 入口导出这一类型，并在 shortcuts service spec 中覆盖返回值。（depends: T1, covers: S2.1）
- [x] T3：新增面板 store、组件、文案、带默认键位的 `commands.open` 命令，以及参考表的排序项。（depends: T2, covers: S2.1）
- [x] T4：给三个地标加上 `data-dsh-region` 与 `tabIndex={-1}`。（depends: T1, covers: S2.2）
- [x] T5：在 `ui-layout` 注册基于地标的 `focus.cycle`/`focus.cycleReverse`。（depends: T4, covers: S2.2）
- [x] T6：在 `ui-conversation` 注册 `focus.composer`。（depends: T4, covers: S2.3）
- [x] T7：在 `ui-workspace` 增加树方向键导航与 roving tab index。（depends: T1, covers: S2.4）
- [ ] T8：编写 [S2.7] 列出的五个 spec。（depends: T3, T5, T6, T7, T10, covers: S2.7）
- [ ] T9：更新受影响的包 README 与 Web 客户端子系统页。（depends: T5, T6, T7, T10, covers: S2.7）
- [ ] T10：让待答提问可以用键盘回答——选项移动、题目前进、确认与取消——并把它的固定行加入参考表。（depends: T1, covers: S2.8, S2.9）
- [ ] T11：用 `pnpm run verify-translation-pairing --write docs/compose/spec/keyboard-control.md` 记录双语配对，然后跑检查：`pnpm run test:gui`、`DSH_SNAPSHOT=replay pnpm run test:web`、`pnpm run typecheck`、`pnpm run lint`、`pnpm run doc-sync`。（depends: T8, T9, T10）

## [S4] Acceptance

- [ ] `commands.open` 能从页面区、输入框、右侧面板页打开面板，并列出全部已注册命令及其生效键帽。
- [ ] 输入按标签和别名过滤列表；`ArrowDown`/`ArrowUp`/`Home`/`End` 移动选中项；`Enter` 执行选中命令；`Escape` 关闭并把焦点还给唤起面板的元素。
- [ ] 面板挂载之后才注册的命令无需重新打开面板就会出现。
- [ ] 执行被拒绝的命令时显示该命令的本地化原因，且会话与布局不发生改变。
- [ ] `focus.cycle` 依次把焦点移到 侧栏 → 会话区 → 右侧面板 → 侧栏，`focus.cycleReverse` 反向环绕，没有右侧面板的布局会跳过它而不是卡住。
- [ ] `focus.composer` 把光标放回当前会话的输入框；主视图没有输入框时给出原因。
- [ ] 焦点在会话树行上时，方向键在行之间移动，`Home`/`End` 到首尾行，`Enter` 打开当前会话；Tab 只进出树一次，而不是每行一次。
- [ ] 待答提问里，`ArrowUp`/`ArrowDown`/`Home`/`End` 移动选项，`Enter` 确认当前题，`Tab`/`Shift+Tab` 在多题之间前进或后退，`Esc` 走与"取消"相同的路径关闭；模型收到的回答不变。
- [ ] 每个新命令都出现在 `⌘/` 参考表中并显示键帽，且能在设置里改键；输入、停止与审批的固定动作在参考表中只读显示；中英文文案都存在。
- [ ] `pnpm run test:gui` 与 `DSH_SNAPSHOT=replay pnpm run test:web` 通过，且没有任何既有默认键位被改动。
