---
description: "语音识别设置：管理转写服务、密钥与默认识别器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-settings-speech

[English](README.md) | 中文

## 目录

- [概述](#summary)
- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="summary"></a>
## 概述

这个可选浏览器插件在设置里添加「语音识别」入口，紧邻模型设置。它为[语音 HTTP 提供者](../../speech/speech-to-text-http/README.zh.md)配置的每个转写服务渲染一张卡片，编辑卡片的显示名称、端点、模型与凭据引用，并通过凭据库管理每个服务的 API 密钥（带已配置/未配置徽标）。添加操作追加一张草稿卡片；删除操作移除一张卡片。卡片上方的选择器在[语音注册表](../../experimental/speech-to-text/README.zh.md)给出的实时花名册上切换默认识别器，选择经语音 Remote 持久化。

<a id="use-this-package"></a>
## 使用本包

在插件管理页启用[语音输入 Bundle](../voice-input-bundle/README.zh.md)；Bundle 把本分区与它管理的识别器一起装配。只有部署在服务语音 HTTP 插件的配置命名空间时本分区才注册，禁用 Bundle 后设置里不会留下痕迹。卡片上写入的密钥按服务命名的引用存入凭据库（内置 DeepSeek ASR 用 `DEEPSEEK_API_KEY`，内置 DashScope qwen3-asr 用 `DASHSCOPE_API_KEY`），从不进入配置文件。切换默认识别器的请求遵循与会议页选择器相同的校验，识别器未声明的语言提示会让写入失败。

<a id="understand-the-implementation"></a>
## 理解实现

本分区是按数据分区装配模式注入的设置页：在 Host 服务 `speech-to-text-http` 命名空间期间，经设置域的 while-served 监视注册进 `settings.section`（id `speech`、order 11）。卡片编辑把服务列表作为一次设置变更写入；凭据状态来自批量凭据 describe，并在推送失效（设置文档、凭据记录与引用、连接重置）时刷新。花名册与默认选择写入走可选的语音 Remote，经 service store 读取，未装配语音 Bundle 的部署仍可使用服务卡片。

<a id="model-experience"></a>
## 模型体验

无；本分区只编辑配置与凭据。

#### KV Cache 效应

无直接影响。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 卡片只编辑通用字段；腾讯的引擎模型、讯飞的轮询间隔、AWS 的区域与 bucket 等形态专属字段仍走配置文件。
- 删除服务经浏览器对话框确认；被移除服务的密钥保留在凭据库，需显式移除。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。
</details>
