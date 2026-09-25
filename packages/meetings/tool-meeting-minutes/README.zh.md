---
description: "面向模型的会议创建、列表、读取、摘要与提问工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-meeting-minutes

[English](README.md) | 中文

## 概述

本消费者通过 `ctx.meetingMinutes` 注册五个显式工具：`meeting_minutes_create`、`meeting_minutes_list`、`meeting_minutes_get`、`meeting_minutes_summarize` 和 `meeting_minutes_ask`。注册和释放是一个 effect；每次调用都接收工具执行取消信号。未发布运行时不变量伴生包，因为每次工具调用都是对应会议服务操作的直接投影。

## 目录

- [概述](#summary)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

### 工具 Schema

#### 模型看到什么

模型看到[生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-meeting-minutes)中的五个稳定 JSON Schema 工具定义。创建需要标题和完整转写；列表没有输入；读取、摘要和提问需要会议 id，提问还需要问题。成功结果是紧凑 JSON 投影，标签分别为 `Created meeting`、`Meeting list`、`Meeting`、`Summarized meeting` 或 `Meeting answer`；失败保留会议服务的校验、未找到、模型、存储和取消错误。

#### Token 影响

插件可见时，五个固定 schema 出现在每个请求中。转写文本只出现在创建参数和 `meeting_minutes_get` 结果中；`meeting_minutes_list` 返回长度而不是内容。

#### KV 缓存影响

插件可见性不变时，工具定义保持前缀稳定。较长的 get 结果和创建参数按普通追加历史增长。


## 已知限制与后续工作

- 工具面没有删除、回答列表、更新或音频导入操作。
- 模型不能选择语音提供者；文本导入是唯一创建路径。
- get 结果中的长转写可能占据工具结果预算。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

None.

</details>
