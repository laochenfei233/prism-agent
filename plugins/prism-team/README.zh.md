# prism-team

[English](README.md) | 中文

Prism Team 在 Agent Teams 包之外补上四项能力，且不改动它们：

| 能力 | 带来的变化 |
|---|---|
| 结构化汇报 | `team_report` 把 teammate 的进展变成一条状态消息，Lead 只收一条 |
| 需要人清单 | `/team` 把 blocked、failed、ready、waiting 排在 working 之前；团队健康时只输出一行 |
| 每 teammate 一个 worktree | 每个 teammate 拿到自己的 `git worktree` 与分支，两个成员不再共写一个 checkout |
| 强制的写入范围 | teammate 写出自己所认领任务的范围之外时，进入审批而不是直接生效 |

它是出树 bundle：只在文档化的扩展点上注册，从不修改 `packages/**`，因此上游 resync 不必重放它。

## 要求

本 bundle 需要旁边挂载 Agent Teams 包——`dsh-agent-team`（共享任务板，`ctx.agentTeams`）与 `dsh-tool-agent-team`（任务工具），以及拥有这棵树的 subagent 运行时。缺了它们，这一行会加载失败，这是有意的响亮失败：没有团队可加入。

一个 Team 就是一棵启用了 Team 模式的子代理树：根 Agent 是 Lead，每个可续谈（continuable）后代都是 teammate。树外的会话得不到任何工具、段落或写入检查。

## 安装

把 bundle 加进 profile，然后启用 Agent Teams。对尚未安装本包的 checkout，把这一行指向构建产物而不是包名：

```yaml
- insert:
    - id: prism-team
      name: 'file:///absolute/path/to/plugins/prism-team/lib/index.js'
      config:
        mode: enforce
        worktree: true
```

## 配置

每个键都可省略并在装载时校验；不可用的值会让插件加载失败，而不是悄悄停用某一部分。

| 字段 | 默认 | 含义 |
|---|---|---|
| `mode` | `enforce` | `enforce` 在越界写入前询问；`observe` 记录后放行 |
| `worktree` | `true` | 为每个 continuable teammate 创建一个 `git worktree` 与分支 |
| `writeTools` | `write`、`edit`、`str_replace_editor` | 范围检查所要审视的写工具名 |
| `maxReports` | `200` | 内存台账里每队保留的汇报条数 |

## 成员得到什么

`team_report` 接收 `status`（`progress`、`waiting`、`ready`、`blocked`、`failed`、`dropped`）、`summary` 和可选的 `task_id`。teammate 的汇报以 `Report from <name> [<status>]: <summary>` 发给 Lead；Lead 在自己的收件箱里收到它，台账记下同一行。Lead 自己调用时只入台账，不发消息。

成员的提示词段落写明汇报协议、先认领后写文件的规则，以及——对拿到 worktree 的 teammate——要工作的绝对路径与分支。

## 会话头部入口

浏览器半区在会话头部加一个**团队** chip，紧挨着子智能体与后台任务 chip（`conversation.session.header.actions`，order 15）。chip 常驻；打开面板才显示名册、开放任务与全部汇报，需要人的行排在最前。数据在首次打开时才加载，所以普通会话只有被人查看时才花一次请求。

面板经一条 Host 只读路由读取：`POST /api/prism-team/panel`，注册在 Connection 的共享 `/api` 通道上。路由按所请求的会话解析它所属的团队，所以 teammate 的会话显示自己队里的内容，浏览器无需知道名册。该路由是可选的：没有 Web 服务器的 profile 保留 bundle 其余全部行为，因为服务是用 `ctx.get('connection')` 读的。

面板只读。认领、完成、改派任务需要活的 Agent 与 Lead 权限，因此留在模型的工具里。

## 写入范围

teammate 通过被配置的写工具写文件时，会对照它**所拥有的**共享任务的 `writeScopes` 检查：

- 路径落在调用者已认领任务的某个范围内：写入继续。这是显式情形。
- 路径在调用者拥有的所有任务之外，或它根本没有认领任务：`enforce` 下该调用进入审批，理由里写明范围；`observe` 下继续执行，台账记一条 `observed`。

别的成员认领的任务只是上下文，不是授权：它的范围永远不能担保这个成员的写入。

每个被配置的工具声明自己的路径参数（`write` 与 `edit` 用 `file_path`；`str_replace_editor` 用 `path`），因此部署新增的写工具会按它真正接受的参数被检查。

`/team` 把这些行打印在汇报之后——这正是 `observe` 能作为试用期的原因。

任务板把 write scopes 定义为顾问性的，对 bundle 不拦截的一切它们仍然是顾问：bash、格式化工具、代码生成器与任何直接的外部写入者都绕得过这道检查。它封住的只有写工具这条路。

teammate 自己 worktree 里的路径（`.worktrees/<checkout>/…`）与共享 checkout 里的同一路径按相同范围比较，所以在 worktree 里工作不会把每次写入都变成审批。

## worktree

teammate 创建时，bundle 会在 `<Lead cwd>/.worktrees/team-<team>-<name>` 准备一个 worktree，分支为 `team/<team>/<name>`；当 checkout 还没忽略该目录时，先把 `*` 写进 `.worktrees/.gitignore`。准备失败只会写进成员的段落，绝不打断成员——subagent 运行时已经把它创建出来了。one-shot 子代理是普通委托，不是 teammate，不建 worktree。

没有任何自动删除：一个未评审的 worktree 可能就是成员的成果。`/team` 与成员段落都会带路径；清理靠手工 `git worktree remove <path>`。

## 已知限制

- **worktree 是劝告，不是隔离。** 会话的工作目录在创建时就已固定，bundle 无法把成员的 cwd 切到它的 worktree。teammate 必须用绝对路径在 worktree 内工作；共享 checkout 依然可写。worktree 带来的变化真实但狭窄：每个成员终于有一个可以提交、可以 `git diff` 的专属 checkout。
- **台账在内存里。** 它回答「团队现在什么样」，重启即失。出树插件写不了 Session 事件，所以汇报的持久副本是 Lead 收件箱里的那条消息。
- **`observe` 是关闭护栏的方式。** 一个以为自己在被保护、实际跑在 `observe` 的部署，不如从一开始就不装这道检查。`/team` 会打印 observed 行，成员段落第一行写明模式。
- **`/team` 只读团队服务暴露的内容。** 它列出名册、任务与本 bundle 的台账；不会总结某个 teammate 自己的会话。
- **没有 Web 写入路径。** 头部面板只读；认领、完成、改派留在模型工具里，因为它们需要活的 Agent 与 Lead 权限。
- **头部 chip 不隐藏自己。** 没有团队的会话仍显示团队 chip；打开它得到空状态，而不是 chip 消失，这样头部在不同会话之间保持稳定。

## 测试

```sh
npm test    # vitest run --config vitest.config.ts
```

测试套件用真实的工具、system-prompt、会话与命令注册表，对 Team 与 subagent 服务打桩，因此它检验的是本 bundle 自己的决策，而不是团队领域本身。
