---
feature: meeting-minutes-preparation-and-answers
status: delivered
updated: 2026-11-05
branch: codex/meeting-minutes-plugin
commits: base..HEAD # filled at delivery
---

# 会议纪要：语音准备与页面内问答

[English](meeting-minutes-preparation-and-answers.md) | 中文

## Report

**构建内容** —— 会议页现在能把语音提供者准备到位，而不是只在录音注定失败时给出提示。`speech()` 投影每个提供者的准备进度（阶段、失败消息、下载资源与字节数），`prepareSpeech`/`cancelSpeechPreparation` 通过语音服务启动和取消所选提供者的准备，`speech/prepare` 与 `speech/cancel` 路由把两者暴露给浏览器。`transcribe` 把识别推进到提供者可转写为止：处于 `unprepared`、`failed` 或 `cancelled` 的提供者先启动准备，进行中的准备直接加入，失败时以提供者自身的消息拒绝，因此实时分段、收尾完整转写与音频导入都随之自愈。页面显示准备栏，含启动操作、下载进度与取消操作，并持续轮询直到提供者进入可转写状态；`standby` 如实读作已就绪的常态。

页面还补上了服务端一直持久化的问答面：详情栏新增第三个页签，就当前会议向配置的模型路由提问，并按新到旧列出已存的问答；推送到会话保持不变。详情栏做了令牌级打磨：统一的提示条加左侧强调线、选中行强调与 focus-visible 状态、更收敛的空态、限宽的转录文本、有区分度的录音条。共享客户端打包器现在会探测 `src/client/index.tsx` 入口，这个包的 TSX 客户端半区得以重新打包。

**验证** —— `pnpm exec vitest run packages/prism/prism-meeting` —— 175 个测试、8 个文件全部通过（服务准备矩阵、路由、api 收窄、presentation 折叠、页面交互）。`pnpm exec tsc -b` 覆盖包的 host 与 client 两面 —— 干净。对 `packages/prism/prism-meeting`、`packages/speech`、`packages/client` 跑 `run-oxlint` —— 0 警告 0 错误。对包源码跑 `jscpd` —— 0 克隆（update/finish 录音对被抽成单一 `writeRecording` 路径和一个 `recordingRoute` 助手）。`pnpm run verify-type-equiv` —— 465 个块匹配。`pnpm run verify-package-invariants` —— 38 个伴生包合规。包内 `tsdown` 构建 host 与 client 两面。`verify-translation-pairing` 为 spec 三件套、meetings 子系统文档与包 README 重新录制。本变更面之外已知的既有红门：`docs/config-catalog.md` 配对失步，以及 `docs/compose/spec/archive-import-prism-agent-e.md` 缺少双语对应物。

**Journey log** —— 自动等待最初只做在服务里；配上页面级准备栏之后，模型下载才从一次静默等待变成可见的进度。评审者抓到 `standby`——已就绪提供者的正常驻留阶段——会渲染出永久的假"未就绪"警告；要跨每个消费者复制的是阶段词汇表，而不是布尔值。重写问答 effect 时把 `tab` 丢出了依赖数组，页签抓取随之失效；交互测试立刻抓到了它，这正是页面测试物有所值的原因。共享客户端打包器硬编码了 `.ts` 入口，在加入探测之前，这个包的 `.tsx` 客户端入口根本打不了包。

## [S1] 问题

会议页对着一个它无法准备的语音提供者录音。本地提供者尚未下载模型时保持 `unprepared`，于是每一段实时转写和最终完整转写都以 "Prepare the local speech provider before recording" 失败，页面只能展示一条指向别的页面的建议。服务端还持久化了会议问答（`ask`/`listAnswers`），页面却从不渲染，唯一提问路径会离开 DSH。

## [S2] 设计

### S2.1 语音准备暴露

- `MeetingSpeechProvider` 在现有 `phase` 旁携带 JSON 安全的 `preparation` 投影（`phase`、`message`、`resource`、`completedBytes`、`totalBytes`）；`speech()` 从提供者视图填充。
- `MeetingMinutesService.prepareSpeech(providerId?)` 通过 `ctx.speechToText.prepare` 启动或加入所选（或指定）提供者的准备，并返回新的 `speech()` 状态。
- `MeetingMinutesService.cancelSpeechPreparation(providerId?)` 取消该准备并返回新状态。
- Web 路由 `POST /api/prism-meeting/speech/prepare` 与 `POST /api/prism-meeting/speech/cancel` 在既有信封之后暴露这两个操作。

### S2.2 转写等待准备

- `MeetingMinutesService.transcribe()` 解析提供者后：无准备控制的提供者照旧直接进行；`ready`/`standby` 照旧；`unprepared`/`failed`/`cancelled` 先启动准备；其余阶段加入进行中的任务。
- 等待订阅提供者的准备状态：`ready`/`standby` 返回，`failed` 以提供者的失败消息拒绝，`cancelled` 或调用方/服务取消时拒绝。除调用方信号外不设超时：模型下载本来就长，页面会报告进度。
- 就绪后走提供者原有的转写路径，实时分段、最终完整转写与音频导入都随之自愈，不再直接失败。

### S2.3 页面内问答

- Web 路由 `POST /api/prism-meeting/ask`（`{id, question}`）与 `POST /api/prism-meeting/answers`（`{id}`）把 `MeetingMinutesService.ask` 与 `listAnswers` 以 `answerView` 投影暴露出来。
- 页面在摘要与转录旁新增问答页签：持久化问答按新到旧排列，带输入框与提问按钮；会议录音中或请求进行中时禁用。推送到会话保持不变。

### S2.4 页面打磨

- 在既有设计令牌内做纯 CSS 打磨：统一提示条并加左侧强调线、选中行强调与 `:focus-visible` 状态、收敛占位与空态层级、限制转录文本行长、录音条加区分底色。不做结构性重设计。

## [S3] 范围

- 范围内：会议服务的准备暴露与自动等待，prepare/cancel/ask/answers 路由，客户端 api、页面问答与准备 UI，中英文文案，页面 CSS 打磨，聚焦测试，README 与子系统文档，以及本 spec。
- 范围外：提供者实现变更（SenseVoice/DashScope）、流式准备进度（仅轮询）、导出格式、说话人改名、提供者与语言选择 UI。

## Tasks

- [x] T1: 服务 — `speech()` 的准备投影、`prepareSpeech`/`cancelSpeechPreparation`、转写自动等待（依赖：无）
- [x] T2: Web — `speech/prepare`、`speech/cancel`、`ask`、`answers` 路由（依赖：T1）
- [x] T3: 客户端 — api 操作、带进度的准备条、问答页签、文案键（依赖：T2）
- [x] T4: 按 S2.4 做 CSS 打磨（依赖：T3）
- [x] T5: 测试 — service、web、client-api、client-page、presentation（依赖：T1–T3）
- [x] T6: 文档 — README 中英文、子系统文档、spec 状态（依赖：T1–T4）

## [S4] 验收

- [x] 所选提供者未准备时，`transcribe()` 启动准备、等待并返回识别文本；准备失败以提供者的失败消息拒绝；等待期间调用方取消会拒绝。
- [x] `speech()` 报告准备投影，`prepareSpeech`/`cancelSpeechPreparation` 启动并取消所选提供者的准备。
- [x] Web 路由 `speech/prepare`、`speech/cancel`、`ask`、`answers` 按设计返回信封值。
- [x] 页面对所选提供者提供带进度的准备操作；问答页签可提问、列出持久化问答；录音中的会议展示实时转写而不是页签组，服务端在录音中拒绝提问。
- [x] 无准备控制的提供者转写行为不变。
- [x] 变更面上的聚焦包测试、typecheck、lint、duplication 通过。
