---
description: "实验性语音 seam 的 OpenAI 兼容 HTTP 识别器：每段录音一次 multipart 转写请求，按录音时长与上传体积设限。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-speech-to-text-openai

[English](README.md) | 中文

## 概述

本提供方把一段已录制完成的 WAV 文件发送到任何提供 OpenAI 音频转写协议的端点，并返回识别文本。它以具名 `cloud` 识别器的身份注册到实验性语音 seam，因此消费方都通过常规的提供方选择访问它。录音作为一次 multipart 请求中唯一的文件部分传输。

同一个端点在转写产生过程中持续返回文本。本提供方公布 seam 的 `streaming` 能力，模式为 `incremental-output`：调用方提交一份完整录音，并逐步读取返回的文本。它不是双工，因为该端点接受单次上传，而不是实时音频。

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

把本包与[语音 seam](../speech-to-text/README.zh.md)一起列在该 seam 服务的任意组合中。识别器以 `providerId`（默认 `openai-transcription`）注册，调用方省略自己的选择时，seam 的 `defaultProvider` 必须指定它。`name` 是语音界面展示的显示名。

`model` 为必填：兼容端点提供的转写模型各不相同，本包不代为选择。`baseUrl` 默认为 `https://api.openai.com/v1`，即 OpenAI 公共根地址，转写路径会拼接在其后；部署到其他兼容端点时覆盖它。`languages` 声明本次部署接受的提示语言，默认为 `['auto']`，表示请端点自行检测语言，请求中不携带 `language` 字段。

`apiKey` 固定一个字面令牌。推荐使用 `apiKeyEnv`，其默认值 `OPENAI_API_KEY` 经 `credentials` 服务解析；未挂载凭据面时回退到启动环境。没有可用密钥时，调用在发送请求前即失败。

`maxDurationSeconds` 与 `maxUploadBytes` 限定单段录音；两者都在读取令牌之前检查，更紧的限制先拒绝该录音。`timeoutMs` 限定单次请求的端到端耗时。

`ctx.speechToText.resolveStream()` 与 `openStream()` 可到达本提供方公布的流式会话。调用方推入不带容器头的 PCM16 采样——它们会被保留到 `close()`，由后者一次性提交整段录音——并从 `events()` 读取 partial、已关闭的分段与一份最终转写。带说话人的分段只来自模型与格式能产出它们的端点；请求要求的是 `json`。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节——点击展开</summary>

`transcribe()` 先按 seam 的规范 WAV 约定校验录音，拒绝超过 `maxUploadBytes` 的上传，解析令牌，然后向 `<baseUrl>/audio/transcriptions` 发送一次 `POST`，并携带 `Authorization: Bearer <token>` 头。请求体为 `multipart/form-data`，其中录音作为 `file`（`recording.wav`、`audio/wav`）承载，另有配置的 `model`、`response_format: json`，以及解析出的提示不为 `auto` 时的 `language`。成功的响应必须是携带字符串 `text` 的 JSON；其他响应体会使调用失败，而不是返回空转写。

失败状态会抛出错误，其中标明状态码并附上响应体的单行摘录，长度上限 500 个字符。取消通过 deadline 信号中止请求，该信号把调用方信号与 `timeoutMs` 融合：deadline 触发时抛出携带已耗时的 `OpenAiTimeoutError`，而调用方取消则以调用方自己的原因拒绝。

不发布运行时不变式伴生包，因为它不拥有任何可被独立观察者反驳的关系：请求是执行期局部的，而 seam 的注册表是注册事实的唯一来源。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[语音输入子系统](../../../docs/subsystems/voice-input.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，识别器只向调用方返回瞬时文本，不新增模型请求或 Session 事件。

#### KV Cache 影响

无直接影响；把转写文本渲染进请求的消费方拥有每一个对模型可见的字节。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 只接受完整录音。端点在本次上传结束后才作答，因此两条路径都不支持实时麦克风流；这里的 `streaming` 表示逐步返回转写，而不是双工会话。
- 流式需要支持它的模型。端点会忽略 `whisper-1` 的 `stream`，改为返回单个 JSON 响应体，本会话无法把其当作事件读取。
- 仅请求 JSON 文本响应。其他 `response_format` 取值所携带的时间戳分段、说话人标签与词级细节都不进入 seam 的 `Transcript`，后者只保留文本与实测时长。
- 本提供方没有重试策略。连接中断或服务的瞬时故障会使调用失败，是否重试由调用方决定。
- `maxUploadBytes` 默认取 OpenAI 文档所述的 25 MiB 上限。限额不同的端点需要显式设置该字段，因为无法从 `baseUrl` 推断出其他取值。
- 音频会离开本机。必须让录音留在本地的部署应改用 host-local 的提供方；seam 的提供方选择是唯一决定这件事的地方。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节——点击展开</summary>

无。

</details>
