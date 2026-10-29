---
feature: cross-agent-session-import
status: in-progress
updated: 2026-10-29
branch: feat/session-import
commits: c64d35c4..HEAD
---

# 跨 Agent 会话导入

[English](cross-agent-session-import.md) | 中文

## [S1] 问题

用户从其他命令行 Agent 带来大量对话历史：Claude Code、Codex、Grok、DeepSeek Harness、MiMo Code、OpenCode、OpenClaw、Hermes、Pi 和 Gemini CLI。Prism Agent 的侧栏对这些历史显示为空，而仓库里唯一的导入工作服务的是另一个 DSH home（[SESSION-IMPORT-PLAN.md](../../../SESSION-IMPORT-PLAN.md)），不是外部格式。

只把历史读出来还不够：用户必须能打开导入的对话并继续它，之前的内容要进入模型请求。导入的对话还必须落到项目里：一个工作文件夹对应一个项目；当这个文件夹已经是这里的项目时，把导入的会话并入它是用户确认过的决定，不能成为静默的副作用。

## [S2] 设计

### [S2.1] 包与进程落点

新包 `packages/session-query/session-import`（`@prism/prism-session-import`）同时承载两半：注册一条带认证的 Fetch 路由的 Host 函数插件，以及注册 `settings.section` 的浏览器插件。包形态照抄 `session-log-export`：`apply(ctx, config)`、`dsh.client`、Host 与 Client 两套 tsconfig、`clientBundle(..., { hostPhase: true })`。

路由是 `POST /api/session.import`（`plan` 与 `apply`）和 `GET /api/session.import/candidates`（发现）。它走 `ctx.connection.fetch` 而不是 Typert Remote 命名空间，因为载荷就是普通 JSON，客户端不需要生成类型，而同一个包已经拥有自己的设置页。在共享 API 通道的认证策略下，只有 owner peer 能到达这条路由。

### [S2.2] 来源目录

每个来源有一个读取器，把其原生存储转换成 [S2.3] 的规范化对话。根目录是各工具在操作系统 home 下的文档默认位置；`Config.roots` 可以覆盖其中任意一个。

| 来源 | 默认根目录 | 读取单元 |
|---|---|---|
| Claude Code | `~/.claude/projects` | `<project>/*.jsonl`，排除 `<session>/subagents/**` |
| Codex | `~/.codex` | `sessions/**/rollout-*.jsonl[.zst]` 与 `archived_sessions/*.jsonl[.zst]`，按 `session_id` 归组 |
| Grok | `~/.grok/sessions` | `<encoded-cwd>/<session>/chat_history.jsonl` 加 `summary.json` |
| DeepSeek Harness | `~/.dsh/sessions` | `<projectKey>/<sessionDir>/session.v4.jsonl[.zstd]` |
| MiMo Code | `~/.local/share/mimocode` | `mimocode.db`（`session`、`message`、`part`） |
| OpenCode | `~/.local/share/opencode` | `opencode.db` 或旧版 `storage/session/**` JSON |
| OpenClaw | `~/.openclaw/agents` | `*/agent/openclaw-agent.sqlite`（`session_windows`、`transcript_events`） |
| Hermes | `~/.hermes` | `state.db`（`sessions`、`messages`）或导出的 `session_*.json` |
| Pi | `~/.pi/agent/sessions` | `--<cwd>--/<timestamp>_<uuid>.jsonl` |
| Gemini CLI | `~/.gemini/tmp` | `<project>/chats/session-*.jsonl` 或旧版 `.json` |

当前 home（`ctx.dshHomePath()`）会从 DeepSeek Harness 来源中排除，并报告为不可用，而不是重复列一遍。

### [S2.3] 规范化对话

对于九个转换来源，读取器返回：

```ts
interface ImportedSession {
  readonly key: string
  readonly source: string
  readonly title?: string
  readonly cwd?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly model?: string
  readonly messages: readonly ImportedMessage[]
}

interface ImportedMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly time: number
}
```

只有真实的用户输入和助手文本会保留。系统提示、developer 消息、合成提醒、推理、工具调用、工具结果、附件和子 agent 会话都会被丢弃。丢弃工具活动让下一次请求保持较小，也避免编造 DSH 会尝试重放的调用标识；导入的对话读起来就是用户记得的那段交流。DeepSeek Harness 不走这条路径，而是使用 S2.3a 的原生复制。

上限约束内存与模型请求：`Config.maxMessages` 保留最近的消息，`Config.maxMessageTextBytes` 截断单条消息并留下可见标记。两者的默认值按真实存储的规模设定（2000 条消息、32 KiB）。

### [S2.3a] DeepSeek Harness 原生复制

DeepSeek Harness 读取器改为暴露原日志：头部中的 id、createdAt 与 cwd，以及完整的已提交事件序列。应用时校验事件封套，并用原会话 id 重放事件，绝不合成消息。工具调用、工具结果、request 头、标题事件与中断标记因此都留在会话及其派生历史中。

格式版本不是当前 `SESSION_FORMAT_VERSION`、或事件被持久化校验拒绝的日志，会让该会话带原因失败；绝不会降级到文本路径。第一次原生写入前，来源 home 的 `attachments/` 目录会复制到当前 home，已存在的文件保留，因此历史中的附件引用可以解析。

### [S2.4] 持久会话合成

对于转换来源，引擎通过 `ctx.sessionPersistence` 写入一个普通的顶层会话：

1. 头部 `{ version: 4, id, createdAt: <首条消息时间>, cwd, isSeeded: false, delegationDepth: 0 }`。id 是确定性的：`session-import-<sha256(source + ':' + key)>` 的小写十六进制。重复导入因此得到同一个 id，直接跳过而不是复制。
2. 每一轮：`turn/start`、`user/message`（`surfaceOp: 'append'`）、`assistant/message`（`surfaceOp: 'append'`、`stream: []`）、`turn/end`（`reason: { kind: 'completed' }`）。连续的助手消息合并为一条；开头没有用户输入、仅有助手消息的轮次跳过。
3. 最后一条事件之后，若存储提供了标题，`session/title` 带上该标题；否则现有的回退标题会从第一条用户消息推导。
4. `handle.append(events)`、`handle.flush()`、`handle.close()`。事件带从 0 开始连续的 `seq` 和不递减的 `time`。

由于日志就是普通的会话日志，`sessionPersistence.list()` 在下一次界面刷新前就会暴露它，`session-query` 能解码它，下一次提问的请求头也会通过 `deriveMessages()` 带上导入的 surface 历史。不需要重启 DSH。

### [S2.5] 项目与合并确认

计划按对话 `cwd` 的 `realpath` 给会话分组；没有 cwd、或 cwd 已不存在的会话照常导入但不登记工作区，并在结果里点名。

对每个分组，计划调用 `ctx.workspaceRegistry.resolveByPath(path)`：

- 没有工作区：应用时创建一个，标题用 `defaultWorkspaceTitle(path)`。
- 已有工作区：应用会把导入会话挂到用户已经认识的项目上。计划把该分组标记为 `merge: true`，除非请求带 `confirmMerge: true`，否则 `apply` 以 `merge-confirmation-required` 拒绝。设置页会列出每个受影响的项目及其当前会话数，并对列出的项目做一次确认。

在这个注册表里一个文件夹就是一个工作区，所以来自多个工具、指向同一文件夹的导入天然汇聚到同一个项目。注册表是唯一的写入者；本功能从不直接改 `workspace.json`。

### [S2.6] 路由契约

`GET /api/session.import/candidates` 返回每个来源的可用性、根目录、会话数、字节数和最近活动时间；不可用的来源带原因。`POST /api/session.import/plan` 接收 `{ source, sessionIds?: string[] }`，返回 [S2.5] 的分组以及逐会话的跳过原因，不写任何字节。`POST /api/session.import/apply` 接收 `{ source, sessionIds, confirmMerge }`，返回逐会话结果（`imported`、`duplicate`、`skipped`、`failed` 及错误文本）以及按工作区汇总的结果。

错误是带 `code` 与可读 `message` 的结构化 JSON。未知来源、根目录不可用、请求体格式错误、未确认的合并都是 4xx；意外的写入失败是 5xx。单个会话失败不中断整批，响应按 key 报告它。

### [S2.7] 设置页

新的设置分区 `import`（顺序 25，排在 Agent presets 之后），标题为「导入对话」。页面为每个探测到的来源显示一张卡片，带数量、体积和最近活动；没有数据的来源显示其预期根目录与不可用原因。把存储放在别处的部署通过 `Config.roots` 覆盖根目录。选中来源后扫描并渲染按项目分组的计划：文件夹路径、会话数、日期范围，以及「将并入现有项目」标记。导入按钮打开确认弹窗，列出每一个会接收会话的项目；只有确认之后才带 `confirmMerge` 执行 `apply`。结果视图列出已导入、重复和失败的会话，并说明导入的对话已经出现在侧栏。

文案位于有类型的 locale 命名空间（`settings.sessionImport`），带英文和中文词典；JSX 里不写死产品文案。

### [S2.8] 来源只读保证

读取器以只读方式打开文件，SQLite 数据库使用 `readOnly: true`。来源根目录下的任何内容都不会被改名、写入或删除。凭据、设置、模型缓存和附件二进制从不读取。

## [S3] 范围

- 范围内：十个读取器、规范化对话、plan/apply、路由、设置分区、带合并确认的项目分组、单元测试、一个真实组合测试、README 与包登记。
- 范围外：导入附件或工具调用记录、双向同步、监听外部工具的新会话、导入另一个 DSH home 的工作区分组与记忆（由 [SESSION-IMPORT-PLAN.md](../../../SESSION-IMPORT-PLAN.md) 负责）、反向导出。

## Tasks

- [ ] T1: 建立包骨架、manifest、tsconfig 两套编译面、tsdown 配置与 bundle 登记（依赖：无）
- [ ] T2: 实现规范化模型、来源目录和文件读取器（依赖：T1）
- [ ] T3: 实现 MiMo Code、OpenCode、OpenClaw、Hermes 的 SQLite 读取器（依赖：T2）
- [ ] T4: 实现发现、计划、应用、会话合成与工作区合并确认（依赖：T2、T3）
- [ ] T5: 实现路由与带确认和结果视图的设置分区（依赖：T4）
- [ ] T6: 添加每个读取器的单元测试、plan/apply 测试和一个真实组合测试（依赖：T4、T5）
- [ ] T7: 编写 README 双语对、更新分组 README 与根布局，然后跑仓库门禁（依赖：T6）

## [S4] 验收

- [ ] A1: 十个来源都能在其文档根目录被发现，读取器按顺序返回用户与助手文本，并带 cwd、时间戳和稳定 key。
- [ ] A2: 应用计划后创建的会话日志可解码，其 `deriveMessages()` 等于导入的对话；第二次应用把每个会话报告为 `duplicate` 且不改任何字节。
- [ ] A2b: DeepSeek Harness 原生导入保留原会话 id 与完整事件序列（包括 `tool/call` 与 `tool/result`），用存储日志构造的 `Session.create` 能把工具结果派生成模型历史；附件已出现在当前 home。
- [ ] A3: 导入的会话出现在其文件夹对应的项目下；文件夹已有项目时，只有 `confirmMerge` 为 true 才合并，否则以 `merge-confirmation-required` 拒绝。
- [ ] A4: plan 与 apply 之后来源根目录未变（文件哈希与 SQLite mtime）。
- [ ] A5: 设置页列出来源、预览项目、在合并确认被勾选前阻止导入，并报告逐会话结果。
- [ ] A6: 聚焦测试、`pnpm run typecheck`、`pnpm run build`、包 README 检查与 `verify-client-ui-i18n` 全部通过。
