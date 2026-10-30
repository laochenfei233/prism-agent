---
description: "在设置中导入 Claude Code、Codex、Grok、DeepSeek Harness、MiMo Code、OpenCode、OpenClaw、Hermes、Pi 与 Gemini CLI 的对话历史。"
kind: "package-reference"
---

# @prism/prism-session-import

[English](README.md) | 中文

## 概述

`dsh-session-import` 在设置中新增「导入」页，读取另外十个编码 Agent 的对话历史，并把每段对话写成本 harness 中普通的持久会话。导入的会话会出现在侧栏中其记录的工作文件夹对应的项目下，下一次提问会继续该对话。DeepSeek Harness 会话按原生日志复制，保留原会话 id 与完整事件，因此工具调用与结果不会丢失；其余九个来源会归一化成文本。来源以只读方式打开。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已经提供 Connection、Session 持久化与工作区注册表的 Web 或桌面 bundle 中挂载本包。插件注册两条带认证的路由与一个浏览器设置分区。

### 组合

```yaml
- id: session-import
  name: '@prism/prism-session-import'
```

浏览器半包通过同一行加载，因为 manifest 声明了 `dsh.client`。

### 来源

本包在操作系统 home 下各工具的文档根目录查找。缺失、不可读、或本身就是当前 harness home 的来源会显示为不可用，而不是被隐藏。

| 来源 | 默认根目录 |
|---|---|
| Claude Code | `~/.claude/projects` |
| Codex | `~/.codex` |
| Grok | `~/.grok/sessions` |
| DeepSeek Harness | `~/.dsh/sessions` |
| MiMo Code | `~/.local/share/mimocode` |
| OpenCode | `~/.local/share/opencode` |
| OpenClaw | `~/.openclaw/agents` |
| Hermes | `~/.hermes` |
| Pi | `~/.pi/agent/sessions` |
| Gemini CLI | `~/.gemini/tmp` |

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `roots` | 文档根目录 | 按来源 id 覆盖的绝对根目录。 |
| `maxMessages` | `2000` | 每段转换对话保留的最近消息数；原生复制的 DeepSeek Harness 日志不受影响。 |
| `maxMessageTextBytes` | `32768` | 单条转换消息的 UTF-8 字节预算；超长文本以 `[truncated]` 结尾。 |

### 路由约定

| 路由 | 请求体 | 结果 |
|---|---|---|
| `GET /api/session.import.candidates` | 无 | 每个来源一条可用性摘要：根目录、会话数、字节数、最近活动时间与不可用原因码。 |
| `POST /api/session.import` | `{ "op": "plan", "source": "claude" }` | 按规范化工作文件夹分组的会话、每组已有的工作区，以及被跳过的会话。不写入任何内容。 |
| `POST /api/session.import` | `{ "op": "apply", "source": "claude", "sessionIds": ["…"], "confirmMerge": true }` | 每个请求会话一条结果，以及接收了会话的工作区。 |

当选中的对话会被加入已存在的项目、且 `confirmMerge` 不为 `true` 时，`apply` 以 `merge-confirmation-required`（HTTP 409）拒绝。

### 预期行为

页面扫描来源、预览项目，并导入全部会话或用户保留勾选的项目。文件夹已不存在的对话会在不归入项目的情况下导入，并在结果中点名。同一来源与同一会话 id 始终映射到同一个持久会话 id，因此重复导入会报告 `duplicate`，而不会写入第二份。DeepSeek Harness 会话保留原 id 与事件日志，并复制一次来源 home 的附件存储；其余来源使用由来源与 key 推导出的新会话 id。来源记录了标题时，导入会话带上该标题；否则在下一条消息之后沿用现有的回退标题。导入还会把每份写好的日志折叠进会话列表读取的投影缓存，因此导入的对话无需先打开就会以标题显示，并按最后一次输入排序。

### 失败

格式错误或不可读的记录会被跳过并记录原因，其余批次继续。未知来源、缺失根目录、格式错误的请求与未确认的合并属于请求失败；意外的存储失败属于服务端失败。单个会话的写入失败在结果中报告，不中断整批。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计拆分

Host 半包（[`src/index.ts`](src/index.ts)）校验配置、注册两条 Fetch 路由并构造 [`SessionImportEngine`](src/engine.ts)。[`src/sources/`](src/sources/) 下的来源读取器把原生存储转换成统一的对话（[`src/types.ts`](src/types.ts)）。引擎按规范化 `cwd` 分组，通过 `ctx.sessionPersistence` 写入每个选中的对话，并通过 `ctx.workspaceRegistry` 登记项目。浏览器半包（[`src/client/ImportSection.tsx`](src/client/ImportSection.tsx)）渲染来源卡片、项目预览、合并确认与结果。

### 会话合成

DeepSeek Harness 来源按原生方式复制：引擎用原会话 id 重放完整的已提交事件日志，因此工具调用、工具结果、标题事件与 request 头都会留在持久会话及其派生历史中。当前构建无法校验的格式版本或事件结构会让该会话以原因失败，绝不会降级成文本。第一次原生写入前，来源 home 的 `attachments/` 目录会复制到当前 home。

其余九个来源由引擎写入顶层头（`version: 4`、`isSeeded: false`、`delegationDepth: 0`），创建时间取对话首条消息，然后每个用户输入一轮：`turn/start`、`user/message`、`stream` 为空的 `assistant/message`、`turn/end`。连续助手消息合并为一条；来源提供的标题写成 `session/title` 事件。

两种路径最终都通过普通的持久化句柄追加、flush 并关闭，因此 `sessionPersistence.list()` 在下一次侧栏刷新前就会暴露该会话，下一次提问的派生历史也会包含导入的消息。

### 只读来源

文件读取器流式读取 JSONL，并解码拼接的 Zstandard 帧；SQLite 读取器以 `readOnly: true` 打开数据库。计划阶段不写入任何内容，应用阶段从不修改来源根目录。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [会话查询包映射](../README.zh.md)——本包所属的检索包族。
- [Session 持久化](../../session/session-persistence/README.zh.md)——引擎使用的持久写入服务。
- [工作区注册表](../../workspace/workspace/README.zh.md)——实时项目成员服务。

-----

<a id="model-experience"></a>
## 模型体验

### 导入的对话历史

#### 模型看到什么

转换会话中的下一次用户提问之前，会带上前面的导入用户与助手文本，作为普通的派生历史；系统提示、推理、工具调用、工具结果、附件、子 agent 会话与合成提醒都不存在。原生复制的 DeepSeek Harness 会话保留这些记录事件（包括工具调用与结果），并从原会话 id 继续。

#### Token 影响

转换后的文本在下一次请求中消耗输入 token，受 `maxMessages` 与 `maxMessageTextBytes` 限制；被截断的消息以 `[truncated]` 结尾。原生复制重放其记录的事件，token 成本就是原日志本来包含的内容。

#### KV Cache 影响

导入本身没有影响；会话是新的。后续轮次共享正常的会话前缀缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **转换来源仅文本**——Claude Code、Codex、Grok、MiMo Code、OpenCode、OpenClaw、Hermes、Pi 与 Gemini CLI 会丢失工具调用、工具结果、推理、图片与子 agent 记录。DeepSeek Harness 是例外：它的日志按原生方式复制，当前构建无法校验的版本或事件结构会让该会话失败，而不是回退成文本。
- **没有增量同步**——重复导入同一来源会话只报告重复；外部存储中的新消息不会追加到已有的 DSH 会话。
- **未公开存储尽力而为**——OpenClaw 与 Hermes 的载荷结构随版本变化；无法识别角色与文本的事件会被跳过，没有任何可用文本的会话报告为已跳过。
- **一个文件夹一个工作区**——工作区注册表按规范化路径键控项目。向已有项目导入必须经过显式合并确认；无法为同一文件夹创建第二个项目。
- **转换消息窗口**——超出 `maxMessages` 的旧消息不会导入，因此超长的转换历史会从截断的前缀继续；原生复制的 DeepSeek Harness 会话保留完整日志。

<a id="dev-note"></a>
### 开发备注

无。
