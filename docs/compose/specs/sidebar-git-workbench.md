---
feature: sidebar-git-workbench
status: designed
updated: 2026-11-01
branch: feat/sidebar-workbench
commits:
---

# 侧栏 Git 工作台

## Report

## [S1] Problem

prism-agent 的右栏已经有文件树、只读预览、终端、本轮改动 review，唯独没有 Git 状态、暂存与提交：用户要把工作交出去，只能切到外部终端或别的 Git 客户端。本仓库的 host 侧只有 `workspace-changes` 的回合快照（`GitRunner` + 私有对象库），没有任何把仓库状态、暂存、提交暴露给浏览器的通道。社区插件 `dsh-better-sidebar` 证明这类工作台有真实需求，但它把编辑器、任务、侧边对话一起塞进一个 19MB 第三方包；本项目要的是原生、只做提交闭环的那一块。

## [S2] Design

### S2.1 数据通道

不新建 Typert Remote 服务。Git 面板是请求/响应式、无流式、无跨进程类型生成需求，沿用 `ui-deliverables` 已经验证的 `ctx.connection.fetch.register` 路由（Connection 鉴权围栏内），host 半与 client 半放在同一个 client 插件包里。理由：Remote 需要 typert 生成产物、`api/remotes` 挂载、lookup 声明等一整套登记面，对只读状态与三个写操作是过度设计。

### S2.2 路由

全部按 `sessionId` 定位会话与其 `cwd`，由 host 用 `ctx.sessionQuery` 解析，不信任客户端传来的路径。

| 路由 | 方法 | 语义 |
|---|---|---|
| `/api/git.status` | GET | `{ repo: false }`，或 `{ repo: true, root, branch, ahead, behind, entries: [{ path, index, worktree }] }`；`index`/`worktree` 为 porcelain 状态字母 |
| `/api/git.diff` | GET | `?path=&side=index\|worktree` → `{ kind: 'text', hunks }` 或 `{ kind: 'binary' }` |
| `/api/git.stage` | POST | `{ paths: string[] }` → 新的 status |
| `/api/git.unstage` | POST | `{ paths: string[] }` → 新的 status |
| `/api/git.commit` | POST | `{ message: string }` → `{ status }`；失败返回 422 与截断的 stderr |

### S2.3 安全与边界

路径只接受仓库根内的相对路径：拒绝绝对路径、`..` 段、NUL、空串，并再次用 `git rev-parse --show-toplevel` 的根做包含校验；提交信息长度上限（默认 64 KiB）由 Config 提供。所有命令以 argv 数组执行，不经 shell；沿用 `GitRunner` 的清洗环境、超时与输出上限。写操作只由用户在面板里的手势触发，模型侧没有任何入口。

### S2.4 复用

`GitRunner` 目前只在 `workspace-changes/src/git.ts` 内部导出，包根只导出类型。本期把它提升为包根导出（一行 re-export，并在 `verify-package-dependencies` 的 host 导出分类里登记），新插件包依赖 `@deepseek-ai/dsh-workspace-changes` 的 host 半使用它，不复制 git 执行代码。`locateGitWorkspace` 不在此列：它为回合快照把对象库与索引重定向到私有目录，与本面板要在真实索引上暂存/提交的语义冲突，因此面板自己用 `git rev-parse --show-toplevel` 定位仓库。

### S2.5 Diff 行模型

`ui-deliverables` 的 `hunkRows`/`DiffRow` 是把 hunk 行编号的纯函数，与渲染无关。把它提升到 `ui-primitives`（结构化的 `{ oldStart, newStart, lines }` 形参，不引入对 deliverables 包的类型依赖），`FileDiff` 改为从 `ui-primitives` 引入并继续 re-export 给同包测试；Git 面板用同一份行模型，只实现统一视图的极简 chrome（无 shiki、无分栏）。

### S2.6 客户端

新包 `@deepseek-ai/dsh-client-ui-sidebar-git`：注册 tab 类型 `kind: 'git'`、guide entry（order 15，位于 files 的 10 与 terminal 的 20 之间）、`sidebar.right.pane.tab` 与 `.title` 两个 seat。面板结构：顶部仓库/分支条（ahead/behind）与刷新、右侧「暂存 N / 未暂存 M」统计；中部三段列表（已暂存、未暂存、未跟踪），点击文件名展开该文件的 diff；底部提交框（message 输入 + Commit，无暂存内容时禁用）。store 由 `defineStore` 创建，按 tab 生命周期持有。

### S2.7 刷新与竞态

打开面板、手动刷新、每次写操作成功后重新读取 status；不轮询、不监听文件系统。同一时刻只保留一个在途读取，后发请求以递增 token 覆盖先发结果，避免旧响应回写。

### S2.8 失败

非仓库：空态说明「当前工作区不是 Git 仓库」。git 不可用：空态说明。读取失败：就地错误行 + 重试。提交失败（无 user.name/email、钩子拒绝等）：展示截断后的 stderr 尾部，保留输入内容。

### S2.9 明确不做（及替代）

- 编辑器保存：写盘要走沙箱策略与新写入通道，成本远高于收益；本机编辑器由 `ui-open-in-app` 的「打开方式」承担。
- 文件树搜索：composer 的 `@` 引用已能按路径跨工作区检索文件。
- `sidebar_open` 工具：模型回答里的内联文件引用与 Markdown 链接已经能在右栏打开文件。
- 侧边对话、子代理拓扑：已有 `ui-subagent` 的侧栏聊天 tab 与会话头部的 jobs/子代理目录。

### S2.10 候选增强（不在本期）

- **改动归属**：文件行标注「本轮由哪个工具改过」，点开跳回对应会话回合。数据来自既有的 deliverables 操作记录，插件做不到，是本项目独有的角度。
- **提交信息由模型起草**：暂存后一个按钮把 `git diff --cached` 摘要交给模型，回填提交框；需要新建一个模型可见的输入通道，成本高于面板本身，先不做。
- **diff 行内提问**：选中行后在输入框引用 `path:line`；当前内联代码引用不支持行号，需要先扩展 `producedFileMentions`。
- **LSP 跳转**：右栏代码视图接 `ctx.lsp` 的定义/引用/悬停，需要新的 host 通道与编辑器内核，是独立的一期。

## [S3] Scope

- In scope: S2.1–S2.8；`GitRunner` 包根导出；`hunkRows` 提升；新插件包的注册面、i18n、README 与测试。
- Out of scope: 分支切换与新建、历史浏览、pull/push、冲突解决、diff 行内评论、多仓库、暂存部分行（hunk 级暂存）。

## Tasks

- [ ] T1: `workspace-changes` 包根导出 `GitRunner`，登记 host 导出分类 (depends: none) `covers: S2.4`
- [ ] T2: `hunkRows`/`DiffRow` 提升到 `ui-primitives`，`FileDiff` 改为引入 (depends: none) `covers: S2.5`
- [ ] T3: 新包骨架与三条注册面（tsconfig 聚合、cordis 行、bundle 依赖）(depends: none)
- [ ] T4: host 半只读路由：仓库定位、status 解析、diff 解析、参数校验 (depends: T1, T3) `covers: S2.2, S2.3`
- [ ] T5: host 半写路由：stage/unstage/commit 与失败报告 (depends: T4)
- [ ] T6: client 半数据层：fetch 客户端、store、竞态 token (depends: T3) `covers: S2.6, S2.7`
- [ ] T7: tab 定义、guide entry、列表与 diff 视图、提交框、locales (depends: T2, T6)
- [ ] T8: host 与 client 单测（含拒绝路径）、README、zh/en 词典 (depends: T5, T7)
- [ ] T9: 验证：`build:artifacts`、`typecheck`、`test:gui`、`doc-sync`，需要时 `DSH_SNAPSHOT=replay pnpm run test:web` (depends: T8)

## [S4] Acceptance

- [ ] 在 Git 仓库的会话里打开 Git tab，能看到分支、ahead/behind 与三段文件列表；非仓库会话看到空态而不是错误。
- [ ] 点击已修改文件能展开统一 diff；二进制文件显示不可预览。
- [ ] 暂存、取消暂存、提交后列表与统计立即更新；提交成功后输入框清空。
- [ ] 提交失败时显示 stderr 尾部且不清空输入。
- [ ] 绝对路径、`..`、仓库外路径的请求被 4xx 拒绝并有单测覆盖。
- [ ] 面板不发起轮询；写操作成功后只读一次 status。
- [ ] `pnpm run test:gui`、`pnpm run typecheck`、`pnpm run build:artifacts` 通过。
