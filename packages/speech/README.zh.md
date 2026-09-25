---
description: "语音识别能力组：服务路由、云端转写，以及面向模型的会议消费。"
kind: "package-group"
---

# speech/ — 语音能力族

[English](README.md) | 中文

## 概述

speech 组定义具名转写 Provider seam，并维护 DashScope 云 Provider。服务在执行前解析显式识别器；meeting-minutes 用它转写完整录音。类型词汇和生成的 Cordis API 见[语音输入子系统页](../../docs/subsystems/voice-input.zh.md)。

## 目录

- [Packages](#packages)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`speech-to-text/`](speech-to-text/README.zh.md) | 路由具名 Provider，拥有取消操作和易变默认值，并校验 WAV 输入 | `ctx.speechToText` |
| [`speech-to-text-dashscope/`](speech-to-text-dashscope/README.zh.md) | 注册面向完整 WAV 录音的 DashScope 实时识别器 | 贡献 `dashscope-funasr` |

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

本地 SenseVoice Provider 保留在 experimental 组，因为其模型下载和原生运行时仍处于稳定前阶段。

</details>
