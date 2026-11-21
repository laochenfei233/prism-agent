---
feature: sidebar-git-workbench
status: delivered
updated: 2026-11-01
branch: feat/sidebar-workbench
commits: c22ec9f0b9..HEAD
---

# Git 工作台

[English](sidebar-git-workbench.md) | 中文

## Report

**做了什么** —— 右侧栏新增原生 Git 工作台 tab。面板列出仓库分支、与上游的领先/落后，以及按已暂存、未暂存、未跟踪分段的全部改动路径；点击一行展开该文件对索引或工作树的比较，行上的动作只暂存或取消暂存那一条路径，底栏提交已暂存的内容。五条鉴权 Host 路由（状态、单文件比较、暂存、取消暂存、提交）挂在 Connection 的 fetch 围栏上，并复用共享的 `GitRunner`，不复制 git 执行代码。

**验证** —— `tsc -b tsconfig.client.json` 与 `pnpm run build:lib:client` 通过；该包八个测试文件共 76 个用例，逐文件覆盖率 100%；受影响的前端套件（`ui-primitives`、`ui-deliverables`、`ui-sidebar-right`、`ui-sidebar-git`）除一个在未改动检出上同样失败的图标计数断言外全部通过；`verify-client-packages`、`verify-package-dependencies`、`gen-tsconfig-paths --check`、`verify-client-ui-i18n`、`verify-md-links`、`verify-translation-pairing` 与两份 catalog 对本改动均干净。

**过程记录** —— 首轮评审查出路径通配（`[ab].txt` 会暂存三个文件）、同时已暂存与已修改的文件对比取错侧、已暂存的删除被当作未跟踪，以及缺少按 tab 的清理；四处都已修复并由测试覆盖，而不是靠放宽面板行为绕过。

## [S1] 问题

右栏已有文件树、只读预览、终端与本轮改动 review，却没有 Git 状态、暂存与提交：用户要离开去外部终端或另一个客户端。Host 侧原来只暴露回合快照，没有仓库状态、暂存或提交的通道。社区插件 `dsh-better-sidebar` 说明需求真实存在，但它把编辑器、任务视图和侧边对话一起塞进一个 19 MB 的第三方包；本项目要的是原生提交闭环。

## [S2] 设计

### S2.1 数据通道

不新建 Typert Remote 服务。面板交换的是小体量的请求与响应记录，不需要流，也不需要生成的线上类型，因此沿用 `ui-deliverables` 已验证的 `ctx.connection.fetch.register` 路由围栏，Host 半与浏览器半放在同一个插件包里。

### S2.2 路由

每条路由都在 Host 上解析 Session 的工作目录，不信任客户端传来的路径。

| 路由 | 方法 | 语义 |
|---|---|---|
| `/api/git.status` | GET | `{ repo: false }`，或 `{ repo: true, root, branch, ahead, behind, entries: [{ path, index, worktree }] }` |
| `/api/git.diff` | GET | `?path=&side=index\|worktree` → `{ kind: 'text', hunks }`、`{ kind: 'binary' }` 或 `{ kind: 'untracked' }` |
| `/api/git.stage` | POST | `{ paths }` → 暂存后的状态 |
| `/api/git.unstage` | POST | `{ paths }` → 取消暂存后的状态 |
| `/api/git.commit` | POST | `{ message }` → 提交后的状态，或带 stderr 尾部的 422 |

### S2.3 安全

路径只接受仓库内的相对写法：绝对路径、`..` 段、NUL 字节与空串一律拒绝；每条带路径的命令都在 `GIT_LITERAL_PATHSPECS=1` 下运行，因此 `[ab].txt` 只作用于该文件，而不是它的全部通配匹配。命令以 argv 数组执行、不经 shell，并沿用 `GitRunner` 的清洗环境、超时与输出上限；被截断的列表或比较会被拒绝，而不是带着错误行号画出来。只有面板里的用户手势能到达三个写操作，模型侧没有入口。

### S2.4 复用

`GitRunner` 与 `resolveGitExecutable` 提升到 `workspace-changes` 包根（一行 re-export 加一条 `SAFE_HOST_DEPENDENCY_EXPORTS` 分类），新包因此复用同一套清洗环境，而不是第二份实现。`locateGitWorkspace` 不在其列：它为回合快照重定向对象库与索引，与在真实索引上暂存、提交相冲突，所以面板用 `git rev-parse --show-toplevel` 定位仓库。

### S2.5 Diff 行模型

行编号的纯函数（`hunkRows`、`DiffRow`）提升到 `ui-primitives`，形参是结构化的 `{ oldStart, newStart, lines }`，不依赖任何 diff 生产者。回合 review 改为从那里引入；Git 面板用同一份行模型，只实现统一视图的极简 chrome。

### S2.6 浏览器半

`git` tab 类型以 kind `git` 注册，带 order 15 的 guide 条目，以及 `sidebar.right.pane.tab` 与 `.title` 两个 seat。面板由分支条、三段列表、就地比较与提交底栏组成。store 是 `defineStore` 实例，归 tab 生命周期所有；tab 记录 abort 时结束自己的 bucket。

### S2.7 刷新与竞态

面板在挂载时读取，每次写操作后再读一次；写操作本身回传它留下的状态，因此没有第二轮往返。它不轮询、不监听。每个 tab 同时只有一个读取在生效：更新的请求作废旧请求的落定，abort 之后发起的请求不发出任何东西。

### S2.8 失败

不是仓库：空态。Host 没有 git：空态。读取失败：就地错误行。提交被拒：stderr 尾部，且保留草稿。

### S2.9 明确不做

- 编辑与保存：写入需要新的沙箱写入通道，且与 review、交付面冲突；本机编辑器已由 `ui-open-in-app` 承担。
- 文件树搜索：composer 的 `@` 引用已按路径搜工作区。
- `sidebar_open` 工具：内联文件引用与 Markdown 链接已经能在侧栏打开文件。
- 侧边对话与子代理拓扑：`ui-subagent` 的聊天 tab、会话头部的 jobs 与子代理目录已经覆盖。

### S2.10 候选增强（不在本期）

- 改动归属：按已记录的 deliverables 操作，在行上标出是第几轮、哪个工具改的。
- 模型起草提交信息：需要新的模型可见输入通道，成本高于面板本身。
- diff 行内提问：把选区引用成 `path:line`；当前内联代码引用还不带行号。
- LSP 跳转：在侧栏内做定义与引用，基于 `ctx.lsp`，是带独立 Host 通道的另一期。

## [S3] 范围

- 范围内：S2.1–S2.8、两处提升的导出、新包的注册面、双语 README 与测试。
- 范围外：切换分支、历史、pull 与 push、冲突解决、diff 行内评论、多仓库、按 hunk 暂存。

## Tasks

- [x] T1：从 `workspace-changes` 导出 `GitRunner` 与 `resolveGitExecutable` 并登记分类 (covers: S2.4)
- [x] T2：把 `hunkRows` 与 `DiffRow` 移入 `ui-primitives` 并改接 review (covers: S2.5)
- [x] T3：新包骨架与三条注册面
- [x] T4：Host 只读路由：仓库定位、状态解析、比较解析、参数校验 (covers: S2.2, S2.3)
- [x] T5：Host 写路由：暂存、取消暂存、提交与失败报告
- [x] T6：浏览器数据层：fetch face、store、读取代次 (covers: S2.6, S2.7)
- [x] T7：tab 定义、guide 条目、三段列表、比较视图、提交框、词典
- [x] T8：Host 与浏览器测试、README 对、zh/en 词典
- [x] T9：验证：前端构建、逐文件覆盖率、GUI 套件、文档门禁

## [S4] 验收

- [x] 在仓库会话里打开 Git tab，能看到分支、领先/落后与三段文件列表；非仓库会话看到空态而不是错误。
- [x] 点击一行展开该行所属侧的统一比较；二进制文件显示不可预览。
- [x] 暂存、取消暂存、提交后列表与统计更新；提交成功后输入框清空。
- [x] 提交被拒时显示 stderr 尾部并保留草稿。
- [x] 绝对路径、`..` 与通配样式的文件名都无法越过被点击的那条路径，且每种拒绝都有测试。
- [x] 面板不发起轮询，每次写操作只读一次状态。
- [x] 该包逐文件覆盖率为 100%，前端构建通过。
