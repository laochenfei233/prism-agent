---
description: "ctx.meetingMinutes 提供持久会议记录、配置化摘要与持久问答。"
kind: "package-reference"
---

# @deepseek-ai/dsh-meeting-minutes

[English](README.md) | 中文

## 概述

`ctx.meetingMinutes` 在 `meeting-minutes` 存储域中保存会议元数据、转写、摘要和问答。`createFromTranscript` 导入文本；`createFromAudio` 先解析显式语音提供者。`summarize` 和 `ask` 调用一个配置的 LLM 路由并持久化成功文本；模型失败不会改变既有持久状态。

## 配置

`summaryProvider`、`summaryModel`、`summarySystemPrompt`、`answerSystemPrompt` 和 `maxTranscriptChars` 是必需的 volatile 字段。组合拥有默认值；服务不隐藏模型路由、提示词或转写上限。变更从后续操作开始生效。

## 目录

- [概述](#summary)
- [配置](#configuration)
- [服务 API](#service-api)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="service-api"></a>
## 服务 API

`list`、`get` 和 `listAnswers` 返回分离记录；会议不存在时 `get` 和 `listAnswers` 失败。`summarize`、`ask` 和 `delete` 在既有变更后串行执行。`delete` 先删除依赖回答，再删除会议。每个异步操作都加入服务释放流程并响应取消信号。未发布运行时不变量伴生包，因为服务是变更顺序和依赖记录删除的唯一独立观察方。

## 模型体验

无，因为本服务调用配置的模型并保存调用者拥有的结果，不贡献请求上下文。

#### KV 缓存影响

没有直接影响；把持久摘要或回答放入模型请求的消费者拥有相应前缀影响。

## 已知限制与后续工作

- 记录只有一个最新摘要；不暴露摘要修订和回答删除。
- 说话人分离、流式识别和导出格式不在范围内。
- `audioSeconds` 信任语音提供者或调用者，不会独立解码音频。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

None.

</details>
