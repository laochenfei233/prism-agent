---
description: "Prism 在 ctx.meetingMinutes 提供持久会议记录、配置化摘要与持久问答，以及面向模型的工具。"
kind: "package-reference"
---

# @prism-ai/prism-meeting

[English](README.md) | 中文

<a id="summary"></a>
## 概述

`ctx.meetingMinutes` 在 `meeting-minutes` 存储域中保存会议元数据、转写、摘要和问答。`createFromTranscript` 导入文本；`createFromAudio` 先解析显式语音提供者。`summarize` 和 `ask` 调用一个配置的 LLM 路由并持久化成功文本；模型失败不会改变既有持久状态。`./tools` 子路径注册面向模型的创建、列表、读取、摘要和提问操作。

<a id="configuration"></a>
## 配置

`summaryProvider`、`summaryModel`、`summarySystemPrompt`、`answerSystemPrompt` 和 `maxTranscriptChars` 是必需的 volatile 字段。组合拥有默认值；服务不隐藏模型路由、提示词或转写上限。变更从后续操作开始生效。

## 目录

- [概述](#summary)
- [安装](#installation)
- [配置](#configuration)
- [服务 API](#service-api)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="installation"></a>
## 安装

把 tarball 安装到基于 base 的 DSH profile，然后重启该 profile：

```sh
dsh plugin --profile <profile> add /absolute/path/to/prism-ai-prism-meeting-0.1.0.tgz
dsh --profile <profile>
```

本包声明了 `dsh.bundle.patch`。base bundle 已提供 `prism-meeting` 和 `tool-prism-meeting` 时，insert 会复用这些 id；缺少这些行的 profile 会新增两个入口。profile 需要 base 的 LLM、storage-domain、speech-to-text 和 tools 服务。音频识别需要设置 `DASHSCOPE_API_KEY`。

<a id="service-api"></a>
## 服务 API

`list`、`get` 和 `listAnswers` 返回分离记录；会议不存在时 `get` 和 `listAnswers` 失败。`summarize`、`ask` 和 `delete` 在既有变更后串行执行。`delete` 先删除依赖回答，再删除会议。每个异步操作都加入服务释放流程并响应取消信号。未发布运行时不变量伴生包，因为服务是变更顺序和依赖记录删除的唯一独立观察方。

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

`./tools` 子路径在[生成的工具目录](../../../docs/tool-catalog.zh.md#prism-aiprism-meeting)中注册 `meeting_minutes_create`、`meeting_minutes_list`、`meeting_minutes_get`、`meeting_minutes_summarize` 和 `meeting_minutes_ask`。创建需要标题和完整转写；列表无输入；读取、摘要和提问需要会议 id，提问还需要问题。成功结果是紧凑 JSON 投影；失败保留验证、未找到、模型、存储和取消错误。

#### Token 影响

插件可见时，五个固定 schema 会出现在每个请求中。转写文本只出现在创建参数和 `meeting_minutes_get` 结果中；`meeting_minutes_list` 返回转写长度而不是内容。

#### KV 缓存影响

插件可见性不变时，工具定义保持前缀稳定。较长的读取结果和创建参数按正常仅追加历史增长。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 记录只有一个最新摘要；不暴露摘要修订和回答删除。
- 工具面不提供删除、回答列表、更新或音频导入操作。
- 模型不能选择语音提供者；工具创建路径只支持文本导入。
- 说话人分离、流式识别和导出格式不在范围内。
- `audioSeconds` 信任语音提供者或调用者，不会独立解码音频。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

Prism 拥有此包；服务保留 DSH 的 `ctx.meetingMinutes` 能力名。

</details>
