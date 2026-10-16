---
description: "实验性语音 seam 的 DashScope 实时识别提供方：每个录音一个双工 WebSocket 会话、有界的 PCM16 上传，以及按句成稿的文本装配。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-speech-to-text-dashscope

[English](README.md) | 中文

## 概述

这个提供方把一段已经录好的 WAV 录音交给 DashScope 实时识别服务，并返回识别出的文本。它作为具名 `cloud` 识别器注册到实验性语音 seam 上，因此该 seam 的所有消费方都通过常规的提供方选择到达它。录音以 PCM16 经一个双工 WebSocket 会话上传，服务确认的文本按句装配。

同一个端点也提供实时识别：本提供方公布 seam 的 `streaming` 能力，模式为 `duplex`，因此消费方可以一边推入音频，一边接收 partial 与带说话人标注的分段。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过[会议纪要 bundle](../meeting-minutes-bundle/README.zh.md) 加载，或在任何使用该 seam 的组合中，把本包与[语音 seam](../speech-to-text/README.zh.md) 并列声明。识别器以 `providerId`（默认 `dashscope-funasr`）注册，调用方未自行指定时，seam 的 `defaultProvider` 必须指向它。

`apiKey` 用于固定一个字面密钥。更推荐 `apiKeyEnv`，其默认值 `DASHSCOPE_API_KEY` 经 `credentials` 服务解析；未挂载凭据平面时回落到启动环境。没有可用密钥时，调用在建立连接之前即失败。

`url` 与 `model` 选择端点与实时模型（默认 `wss://dashscope.aliyuncs.com/api-ws/v1/inference` 与 `fun-asr-realtime`）。`languages` 声明本部署接受的语言提示，解析后的提示会作为任务的 `language_hints` 参数发送，除非它是 `auto`。`speakerDiarization` 要求模型在其句子中标注说话人。`maxDurationSeconds` 限制可接受的录音时长。`timeoutMs` 限制整个会话，`drainTimeoutMs` 限制对上传结束后服务所发结果的等待。

`ctx.speechToText.resolveStream()` 与 `openStream()` 可到达本提供方公布的实时会话。调用方推入不带容器头的 PCM16 采样，并读取 partial、已关闭的分段与一份最终转写；`speakerDiarization` 决定这些更新是否携带说话人标注。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节——点击展开</summary>

一个会话向 `<url>?authorization=Bearer%20<key>` 打开 WebSocket——令牌走查询参数，因为不支持请求头的 WebSocket 客户端无法发送授权头——随后发送 `run-task`，等待 `task-started`，跳过 44 字节 WAV 头后上传录音的 PCM 采样，发送 `finish-task`，并读取结果直到 `task-finished`。

客户端最多保留八秒未发送的 PCM；`upload` 在发送下一个一秒帧之前，会等待 `socket.bufferedAmount` 降下来。结果以 `result-generated` 事件到达，其文本对未完成的句子是累积的，因此会话为每个句子保留服务最后发送的文本，并在该句结束时提交。事件名无法识别时该帧被忽略；不是带事件名的 JSON 对象时，会话以 `RecognitionProtocolError` 失败。

取消会关闭 socket，使待处理的等待失败，而不是把它留给定时器；各阶段截止时间与调用方信号合并，因此调用方取消与两个截止时间都到达同一个待处理等待。每个截止时间内部的 `TimeoutReason` 在离开提供方之前都会被翻译：会话截止时间触发抛出 `DashScopeTimeoutError` 且 `phase: 'recognition'`，排空截止时间触发则抛出 `phase: 'results'`。

录音必须满足 seam 的规范 WAV 约定，`validateWave` 在任何连接建立之前就会检查；不是 16 kHz 单声道 PCM16 WAV 的录音在到达服务之前即失败。本提供方不发布运行时不变式伴随包，因为它不拥有任何可能被独立观察者推翻的关系：会话自身状态只在执行内可见，而 seam 的注册表是注册事实的唯一来源。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[语音输入子系统](../../../docs/subsystems/voice-input.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

None, as the recognizer returns transient text to its caller without adding model requests or Session events.

#### KV Cache effect

No direct effect; the consumer that renders the transcript into a request owns every model-visible byte.

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 只有完整录音会进入 `transcribe()`。该路径把服务的实时帧用于上传一个已结束的文件；实时音频改走 `streaming` 能力。
- 说话人标注会到达实时会话的更新及其最终 `segments`，但不会到达批量 `Transcript`，后者的约定仍只携带文本。
- 提供方没有重试策略。连接中断或服务的瞬时失败会使调用失败，是否重试由调用方决定。
- 端点、模型与参数集合沿用了本包移植来源中已验证的协议。其他 DashScope 实时模型可能拒绝会话所发送的参数。
- 音频会离开本机。必须让录音留在本地的部署应改用主机本地的提供方；seam 的提供方选择是唯一做此决定的地方。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节——点击展开</summary>

无。

</details>
