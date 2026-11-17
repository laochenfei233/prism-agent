---
description: "ctx.speechToText 的配置驱动第三方 HTTP 转写提供者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-speech-to-text-http

[English](README.md) | 中文

## 目录

- [概述](#summary)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## 概述

这个插件为每个配置的服务在 `ctx.speechToText` 上注册一个识别器，第三方 ASR 服务只靠配置就能接入语音输入和会议页。每个识别器把规范 WAV 按配置的请求形态上传到配置的端点，并从 JSON 应答读取文本；注册表会把超出请求形态时长上限的录音在安静边界切片并合并各片。提供者不拥有准备，注册即就绪。语音识别设置分区编辑这个插件的服务列表与密钥；语音输入 Bundle 内置 DeepSeek ASR 与 DashScope qwen3-asr。

## 配置

插件接收 `services` 列表；每个条目注册一个识别器，重复 id 在加载时失败。每个条目命名 `providerId`、可选显示 `name`、`endpoint` 和接受的 `languages`；`mode` 选择请求形态。`apiKeyEnv` 命名一个凭据引用，受控部署也支持字面量 `apiKey`，但不应写进普通配置文件；`authHeader` 与 `authStyle`（默认 `bearer`，或 `token`、`raw`）把凭据放进服务期望的头。`textField` 以点路径（对象键与数组下标）命名应答的响应字段（默认 `text`），`maxAudioBytes`、`maxDurationSeconds` 与 `timeoutMs` 约束每次识别；缺省 `model` 时不发送 model 字段。

请求形态：

- `transcriptions`（默认）——OpenAI `multipart/form-data` 形态，带可选 `model` 与 `language` 字段；覆盖 OpenAI 兼容服务（Groq、Mistral、DashScope 兼容端点）。
- `chat-completions`——携带音频的 chat 请求，语言提示放在 `asr_options.language`（MiMo-V2.5-ASR 的开关）。
- `raw-body`——WAV 作为整个请求体并以 `audio/wav` 发送；固定的 model 或语言参数写在端点 URL 里（Deepgram `/v1/listen` 配 `authStyle: token`）。
- `tencent-sentence`——腾讯云 `SentenceRecognition`，TC3-HMAC-SHA256 签名；配置 `engineModel`（默认 `16k_zh`）与 `secretId` 或 `secretIdEnv` 身份，`apiKeyEnv` 放 SecretKey；60 秒上限。
- `xfyun-filetrans`——讯飞长语音转写，运行 prepare、有序 10 MiB 分片上传、merge、进度轮询（`pollIntervalMs`，默认 5 秒）与结果读取；配置 `appId` 或 `appIdEnv` 身份，`apiKeyEnv` 放 SecretKey。
- `volcano-flash`——豆包录音文件识别极速版：base64 音频发往一个同步端点，使用控制台 key；2 小时上限。
- `google-speech`——Google Cloud Speech-to-Text v1 `speech:recognize` 信封，API key 放在端点 URL；`model` 命名识别模型；60 秒上限。
- `azure-fasttranscribe`——Azure AI Speech 快速转写，订阅密钥头，语言提示作为 `definition.locales`。
- `aws-transcribe`——Amazon Transcribe 批量转写：SigV4 签名上传到 `awsRegion` 的 `awsBucket`，启动并轮询任务，读取转写文本；`secretId` 或 `secretIdEnv` 放访问密钥 ID，`apiKeyEnv` 放秘密访问密钥；需要一个凭据可写的 bucket。

密钥每次请求从配置字面量、凭据面或启动环境解析；密钥解析为空的服务仍会注册，并在识别时以该指引失败。

```yaml
plugins:
  - name: '@deepseek-ai/dsh-experimental-speech-to-text-http'
    config:
      services:
        - providerId: groq-whisper
          endpoint: https://api.groq.com/openai/v1/audio/transcriptions
          apiKeyEnv: GROQ_API_KEY
          model: whisper-large-v3
          languages: [auto, zh, en]
        - providerId: xiaomi-mimo-asr
          name: MiMo ASR
          endpoint: https://api.xiaomimimo.com/v1/chat/completions
          apiKeyEnv: MIMO_API_KEY
          model: mimo-v2.5-asr
          mode: chat-completions
          languages: [auto, zh, en]
          # The service caps one request at 30 minutes; the registry splits
          # longer imports at quiet boundaries automatically.
          maxDurationSeconds: 1800
        - providerId: tencent-sentence
          endpoint: https://asr.tencentcloudapi.com/
          apiKeyEnv: TENCENT_SECRET_KEY
          secretIdEnv: TENCENT_SECRET_ID
          mode: tencent-sentence
          languages: [auto]
```

## 模型体验

无；识别结果在被消费者显式持久化或提交之前不会进入模型请求。

#### KV Cache 效应

无直接影响；把识别文本放进模型请求的消费者自行承担前缀效应。

## 已知限制与后续工作

- chat-completions 形态只读取 `choices[0].message.content`；其他 chat 应答布局不在范围内。
- `raw-body` 形态不传输语言提示；固定的 model 与语言参数写在端点 URL 里。
- 仅支持完整录音识别；第三方流式协议不在范围内。
- 无法解析密钥时注册成功，但识别在请求时失败。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。
</details>
