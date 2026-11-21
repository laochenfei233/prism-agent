---
feature: http-asr-provider
status: delivered
updated: 2026-11-05
branch: feat/http-asr-provider
commits: bc4508fd0b..HEAD # filled at delivery
---

# HTTP ASR 提供者

[English](http-asr-provider.md) | 中文

## Report

**构建内容** —— `packages/speech/speech-to-text-http`（`@deepseek-ai/dsh-speech-to-text-http`）把第三方 ASR 服务变成配置。插件接收 `services` 列表，为每个条目在 `ctx.speechToText` 上注册一个识别器：OpenAI 兼容端点（OpenAI Whisper API、Groq、SiliconFlow、自建 whisper.cpp 服务）以及任何以 JSON 文本应答的服务，无需一行 provider 代码即可出现在语音输入选择器和会议页。每个识别器把规范 WAV 按 OpenAI 形态的 `multipart/form-data` 上传，携带 model 与 language（`auto` 时省略），从配置字面量、凭据面或启动环境解析 bearer key，以 `maxAudioBytes`、`maxDurationSeconds`、`timeoutMs` 约束每次识别，并从配置的顶层 JSON 字段读取文本；空应答是合法的“未识别到语音”转写。不完整条目、重复 id、缺失密钥、非规范 WAV、超限录音、非 2xx 或畸形应答都以操作者可读的消息响亮失败。

消费方按设计不变：语音输入与会议页跟随部署的默认选择，选中第三方提供者即路由过去。注册文档让新包跟上了仓库的生成与手维护名册（tsconfig paths 与 host solution、配置目录中英文、插件包 skill 参考、speech 组 README、语音输入子系统页）。

**验证** —— `pnpm exec vitest run packages/speech/speech-to-text-http` —— 15 个测试通过（multipart 形态、语言处理、密钥解析分支、失败映射、注册/撤回、重复 id、不完整条目）。包内 `tsc -b` —— 干净；`run-oxlint packages/speech` —— 0/0；`jscpd` —— 0 克隆；`verify-package-invariants`、`verify-config-catalog`、`verify-plugin-packages`、`verify-doc-budgets`、`verify-translation-pairing` —— 全绿（配对仅剩两个已记录的既有红项）。独立评审在修复两个 critical（过期的生成目录；四个身份字段缺 `.required()`）与若干小项后通过。**既有问题，非本次变更面：** 根级 `pnpm run build:lib:host` 在 `packages/prism/prism-meeting/src/client/**` 下报 4 个 TS6307 —— 父功能的 client face 认领 `src/client/**`，而根 host include 扫到其 `client-*.spec` 测试导入这些文件；该问题早于本增量（被陈旧 tsbuildinfo 掩盖），不涉及本变更的任何文件，属于父功能的聚合接线决策。

**Journey log** —— 注册接缝从来不是问题：`ctx.speechToText.register` 加持久化选择早已把所有消费者路由好，所以整个功能就是一个配置驱动的 provider 包。Schemastery 对非 `.required()` 字段的缺失键解析为 `undefined` 而不报错——配置数组条目默默以 `undefined` 键注册，正是必须在加载时响亮失败的错误配置。生成目录是单侧的：`gen-config-catalog` 只写英文文档，中文对应物需要手工投影段落并重录配对。陈旧 tsbuildinfo 掩盖了根 host 构建中真实的聚合接线错误，直到 `--force` 与全新构建才暴露。

## [S1] 问题

`ctx.speechToText.register` 就是提供者接缝，写成 Cordis 插件的第三方识别器会出现在所有地方（语音输入选择器、会议页、默认选择）——但今天接入一个第三方 ASR 服务意味着为每家服务写一个 TypeScript provider 包。绝大多数第三方服务（OpenAI Whisper API、Groq、SiliconFlow、自建 whisper.cpp 服务）共享同一种形态：带鉴权的 HTTP POST 一段规范 WAV，应答 JSON 携带识别文本。

## [S2] 设计

### S2.1 一个配置驱动包，多个服务

- `packages/speech/speech-to-text-http`（`@deepseek-ai/dsh-speech-to-text-http`）为每个配置的服务条目注册一个 `SpeechProvider`；插件接收 `services: []`，重复 id 在加载时响亮失败。
- 每个服务条目携带：`providerId`、可选显示 `name`、`endpoint`、`apiKey`（secret）与 `apiKeyEnv`（凭据引用，像 DashScope 一样回退到启动环境）、`model`、`languages`、`textField`（顶层 JSON 响应字段，默认 `text`）、`maxAudioBytes` 与 `timeoutMs`。
- 请求预设为 OpenAI `/audio/transcriptions` 形态：`multipart/form-data` 携带 `file`（规范 WAV）、`model` 与 `language`（`auto` 时省略）。密钥解析、注册 effect 与释放都镜像 DashScope 提供者。
- 无准备控制的提供者注册后即为就绪，语音输入与会议页都能看到它，全局选择切过去无需写代码。

### S2.2 消费方不变

- 会议页跟随部署的默认选择，因此在语音输入选择器或 profile 配置里选中第三方提供者，会议转写就路由过去。本轮不加会议页选择器。

## [S3] 范围

- 范围内：speech-to-text-http 包（provider、插件配置、测试、README 中英文）、tsconfig 路径注册、包门禁。
- 范围外：第三方流式/实时协议、顶层 text 字段之外的响应格式、会议页 provider 选择器、工具里的按会议选择。

## Tasks

- [x] T1: Provider 与插件配置及测试（依赖：无）
- [x] T2: 包注册（tsconfig paths、invariants、文档）（依赖：T1）
- [x] T3: 验证 + 评审 + 收尾（依赖：T2）

## [S4] 验收

- [x] 每个配置的服务注册一个提供者，把规范 WAV 经 HTTP 用凭据引用的 bearer key 转写，并应答映射的 text 字段。
- [x] `language: 'auto'` 省略表单字段；配置的语言会发送。
- [x] 缺少 API key、非规范 WAV、超限录音、非 2xx 应答各自以操作者可读的消息失败。
- [x] 重复 provider id 在加载时失败；释放撤回所有注册。
- [x] 变更面上的聚焦测试、typecheck、lint、duplication 与包门禁通过。
