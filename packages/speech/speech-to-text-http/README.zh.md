---
description: "ctx.speechToText 的配置驱动第三方 HTTP 转写提供者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-speech-to-text-http

[English](README.md) | 中文

## Table of Contents

- [摘要](#summary)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## 摘要

这个插件为每个配置的服务在 `ctx.speechToText` 上注册一个识别器，第三方 ASR 服务只靠配置就能接入语音输入和会议页。每个识别器把一段完整的规范 WAV 按配置的请求形态上传到配置的端点——OpenAI `multipart/form-data` 转写形态，或携带音频的 chat-completions 请求——发送从配置字面量、凭据面或启动环境解析出的 bearer key，并从 JSON 应答读取识别文本：转写应答的映射顶层字段，或 chat 应答的 message content。提供者不拥有准备，注册即就绪。未发布运行时不变量伴生包，因为除每次识别的一次 HTTP 请求与应答之外，提供者不拥有任何投影。

## 配置

插件接收 `services` 列表；每个条目注册一个识别器，重复 id 在加载时失败。每个条目命名 `providerId`、可选显示 `name`、`endpoint`、`model` 和接受的 `languages`；`mode` 选择请求形态（默认 `transcriptions`，或 `chat-completions`）；`apiKeyEnv` 命名一个凭据引用，受控部署也支持字面量 `apiKey`，但不应写进普通配置文件。`textField` 命名转写应答的 JSON 响应字段（默认 `text`），`maxAudioBytes`、`maxDurationSeconds` 与 `timeoutMs` 约束每次识别。

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
```

## 模型体验

无；识别结果在被消费者显式持久化或提交之前不会进入模型请求。

#### KV Cache 效应

无直接影响；把识别文本放进模型请求的消费者自行承担前缀效应。

## 已知限制与后续工作

- chat-completions 形态只读取 `choices[0].message.content`，并把语言提示放在 `asr_options.language`（MiMo-V2.5-ASR 的开关）；其他 chat 应答布局不在范围内。
- 仅支持完整录音识别；第三方流式协议不在范围内。
- 无法解析密钥时注册成功，但识别在请求时失败。

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。
</details>
