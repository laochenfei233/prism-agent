---
description: "ctx.speechToText 的 DashScope 完整录音识别提供者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-speech-to-text-dashscope

[English](README.md) | 中文

## 目录

- [概述](#summary)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

## 概述

这个 Provider 在 `ctx.speechToText` 上注册 DashScope 实时识别器。它通过双工 WebSocket 把一个完整 WAV 录音转换为纯文本闭合句，按请求解析 `DASHSCOPE_API_KEY` 或配置的凭据引用，并拥有连接超时和结果清空期限。未发布运行时不变量伴生包，因为 Provider 没有在这些 WebSocket 生命周期观察之外的独立维护投影。

## 配置

组合选择提供者 id、支持的语言提示、端点、模型、说话人分离开关、最大录音时长和两个超时。`apiKeyEnv` 指定凭据引用；受控部署可以使用字面量 `apiKey`，但不应写入普通配置文件。

## 模型体验

无，因为识别结果在消费者显式持久化或提交文本之前不会进入模型请求。

#### KV 缓存影响

没有直接影响；把识别文本放入模型请求的消费者拥有相应前缀影响。

## 已知限制与后续工作

- 只支持完整录音识别；流式麦克风会话不在范围内。
- 说话人标签依赖提供者，不会规范化为持久说话人身份。
- 没有解析到 DashScope key 时，注册成功但识别在请求时失败。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

None.

</details>
