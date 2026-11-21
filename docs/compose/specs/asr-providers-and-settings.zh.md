---
feature: asr-providers-and-settings
status: delivered
updated: 2026-11-18
branch: feat/asr-providers-and-settings
commits: f5baf8f73f..760b99e11c
---

# ASR 提供者扩展：六家服务、时长分段、语音设置分区

[English](asr-providers-and-settings.md) | 中文

## Report

**做了什么** —— 语音注册表把超出提供者声明请求上限的录音在安静 20 ms 窗口(最短 1 秒切片)处切片,按序识别并合并文本、平移分段时刻与时长总和;每个识别器都声明自己的上限。HTTP ASR 提供者覆盖九种请求形态——可选 model 的 OpenAI multipart、chat-completions、raw-body、腾讯 SentenceRecognition(TC3-HMAC-SHA256,黄金向量钉住)、讯飞 lfasr(四步任务流)、豆包极速版、Google Speech v1、Azure 快速转写、Amazon Transcribe(SigV4 走 S3)——配合可配置凭据头与点路径响应映射,DeepSeek、DashScope qwen3-asr、Deepgram、ElevenLabs、Groq、Mistral 均可纯配置接入。语音输入 Bundle 内置 deepseek-asr 与 dashscope-qwen3,新的语音设置分区(order 11,紧跟模型设置)渲染服务卡片、凭据管理与默认识别器切换。

**验证** —— 七个触及包 343/343 聚焦测试(seam 分段 35、HTTP 提供者 43、DashScope/OpenAI/SenseVoice/voice-input/settings-speech 全套);触及包逐包与聚合 `tsc -b` 干净,client/host 聚合对触及文件零错误;触及面的文档门禁全绿(doc-standard 22/22、package-README limitations 390 文件、doc budgets、doc references 5024 文件、每个编辑过的配对都重录通过,config/cordis/tool/client 目录重新生成)。聚合残余红项均为基线(2026-11-05 基线 + 后续 resync 漂移):早期 fork spec 的陈旧双语记录、tool-catalog zh 漂移、webserver README 摘要、以及已知 Windows TMP/esbuild 文档构建问题;duplication 27 个克隆、新文件零克隆(2026-10-31 记录的 13 基线,余为后续会话漂移)。全部 adapter 流程与签名均为假服务/golden 向量测试;本环境未对接任何真实服务。

**历程** —— 安静边界切点最初在窗口等能量时选中第一个扫描窗口,把均匀音调碎成 20 ms 小片;以目标窗口自身能量为比较基线并强制 1 秒最小切片后修复。第一版 TC3 黄金向量与实现共享同一处规范头构造错误(每头换行重复);按腾讯文档拼接式重算后实现与向量一起修正。火山标准版 submit/query 只收音频 URL,特性改落在收 base64 字节的极速版。注册表预读时长曾让非规范音频变成 seam 层错误、遮住提供者自己的 Prepare 报错;不可解析音频现在整段透传。

## [S1] 问题

会议页与语音输入当前暴露的识别器花名册很窄：`dashscope-funasr`（WebSocket）、`sensevoice-local`（本地 ONNX）、`openai-transcription`，外加用户手工写进 cordis patch 的 `speech-to-text-http` 服务。接入任何第三方 ASR 都要手工改 YAML；设置界面没有任何编辑入口。国内主流提供者均未覆盖：DeepSeek ASR、阿里 DashScope qwen3-asr、字节火山豆包、腾讯云、科大讯飞都需要逐家接入。另一方面，提供者对单次请求接受的音频时长设有上限（MiMo 30 分钟、DeepSeek 120 秒、腾讯一句话 60 秒），导入长录音会直接以 "Audio exceeds N seconds" 失败，超过上限后也无法继续转写。

## [S2] 设计

### S2.1 seam 层分段转写

`SpeechProviderInfo` 增加可选 `maxAudioSeconds?: number`。每个提供者包把它配置的请求上限映射进注册信息（`speech-to-text-http` 逐服务取 `maxDurationSeconds`；`dashscope`、`openai`、`sensevoice` 取各自既有配置字段；`sensevoice` 按 `input.ts` 既有做法从 `maxAudioBytes` 推导秒数）。

`packages/experimental/speech-to-text/src/wave.ts` 增加 `readWaveSeconds(audio)`（从 `validateWave` 抽出）与 `sliceWave(audio, startSample, endSample)`，产出规范 16 kHz 单声道 PCM16 WAV。

`SpeechToText.transcribe()`（seam，`src/index.ts`）在解析到的提供者声明了上限且输入超限时切片：切点在时长上限前最多 3 秒的范围内搜索能量最低（安静）的 20 ms 窗口，否则硬切；切片按现有 abort/pending 跟踪顺序转写。结果合并：文本以 `\n` 拼接，提供者分段的时间按切片起点平移（无分段的切片合成一条覆盖分段），`audioSeconds` 与 `inferenceSeconds` 求和。

未超限的输入与今天完全一致（单次提供者调用）；各提供者自身的内部校验继续作为兜底。会议页在线路径（8 秒切片）不会触发分段；文件导入路径是主要受益者。

### S2.2 speech-to-text-http 请求形态扩展

服务条目的 `mode` 在 `transcriptions` 与 `chat-completions` 之外新增：

- `tencent-sentence` — `POST https://asr.tencentcloudapi.com`，`SentenceRecognition` / `2019-06-14`，以 SecretId + SecretKey 做 TC3-HMAC-SHA256 签名，`SourceType: 1`（base64 WAV 放 `Audio`），`EngSerViceType` 来自 `engineModel`（默认 `16k_zh`），文本读自 `Response.Result`。上限 60 秒。
- `xfyun-filetrans` — 讯飞 lfasr，走 `https://raasr.xfyun.cn/api`：prepare、有序 10 MiB 分片上传、merge、进度轮询（`signa` = base64(HMAC-SHA1(secretKey, MD5(appid+ts)))）与分句结果读取。上限 5 小时；轮询受 `timeoutMs` 约束。
- `volcano-flash` — 豆包录音文件识别*极速版*：一次 `POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash` 携带 `audio.data`（base64），`X-Api-Key`，状态在 `X-Api-Status-Code` 响应头，文本与分句分段在响应体。上限 2 小时。标准的 submit/query 版只收音频 URL，不在范围内。

`model` 对所有形态变为可选：缺省的 `model`/`language` 表单字段直接省略（`transcriptions` 对 OpenAI/Groq/Qwen/DashScope 兼容端点继续可用）。因此 DeepSeek ASR 是纯配置：`endpoint: https://api.deepseek.com/v1/tools/asr`、无 `model`、上限 120 秒、`maxAudioBytes` 8 MiB。

在共享请求层加入通用认证与响应机制，让多家国际服务保持纯配置或接近纯配置：

- `authHeader?: string` + `authStyle?: 'bearer' | 'token' | 'raw'` — 非 Authorization 键（ElevenLabs `xi-api-key`，raw）与带前缀的 Authorization 形态（Deepgram 的 `Token <key>`）复用既有密钥解析，不需要专门 adapter。
- `textField` 支持点路径访问（`results.channels.0.alternatives.0.transcript`）。
- 新增 `raw-body` 请求形态：WAV 字节作为整个请求体、`audio/wav`，固定的 model 或语言参数写在端点 URL 里——这就是 Deepgram `/v1/listen` 的全部故事。

在此之上提供专门形态：

- `deepgram-listen` — raw-body 发往 `https://api.deepgram.com/v1/listen`，`Authorization: Token <key>`，model/language 作查询参数，文本取自 `results.channels.0.alternatives.0.transcript`。
- `google-speech-v1` — `POST https://speech.googleapis.com/v1/speech:recognize?key=<apiKey>`，JSON 信封 `{config: {encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode, model}, audio: {content: <base64>}}`，拼接 `results[].alternatives[0].transcript`。上限 60 秒。
- `azure-fasttranscribe` — `POST https://{region}.stt.speech.microsoft.com/speechtotext/fasttranscriptions:transcribe`（api-version 按现行文档），`Ocp-Apim-Subscription-Key` 头，multipart `audio` + `definition` JSON（locales），同步应答。上限约 120 秒，长导入按 S2.1 分段。

密钥解析保留既有三级链（字面量 → 凭据 → 启动环境），并推广到各形态的秘密字段（SecretId/SecretKey、AppId/secret key、访问令牌、订阅密钥），逐字段走同一链路。

### S2.2.1 AWS Transcribe（S3 前提）

AWS 批量识别没有内联音频 API：`StartTranscriptionJob` 接收 S3 URI，转写文本落成 S3 JSON。`aws-transcribe` adapter 因此要求配置 S3 bucket，并执行：SigV4 签名 `PutObject` 上传 WAV → SigV4 签名 `StartTranscriptionJob` → 轮询 `GetTranscriptionJob` → 签名 GET 转写 URI → 拼接转写分段。配置：region、`accessKeyIdEnv`/`secretAccessKeyEnv`、bucket、语言代码；上限 4 小时。这是本特性最大的 adapter，放最后实现，使其体量不能拖累其余部分；若 SigV4 + S3 在实现时被证明不成比例，停下来重新商量而不是交付一条半测试的路径。

### S2.3 基础 profile 的内置服务

语音 Bundle 装配语音提供者之处，基础 profile 注册 `speech-to-text-http` 并带两个内置服务：

- `deepseek-asr` — 如上；`DEEPSEEK_API_KEY`（应用唯一随附凭据）。
- `dashscope-qwen3` — `https://dashscope.aliyuncs.com/compatible-mode/v1/audio/transcriptions`，模型 `qwen3-asr-flash`，`DASHSCOPE_API_KEY`。

云提供者注册即 `ready`，两者都直接出现在会议页选择器且无需准备。用户既有的 MiMo patch 条目保持不变；它的 30 分钟续转来自 S2.1，其条目把 `maxDurationSeconds` 设为 `1800` 即生效（升级指南说明，设置分区可编辑）。

### S2.4 设置分区：语音识别

新包 `packages/client/ui-settings-speech`，以与数据分区相同的注入方式注册 `settings.section`：`id: 'speech'`、`order: 11`（紧跟 models）、locale 命名空间 `settings.speech`（zh `语音识别` / en `Speech recognition`）。

内容仿模型设置区的卡片布局：

- 默认识别器切换器，绑定语音 seam 的持久化选择（花名册 `id`/`name`/`phase`/`languages` 来自远端语音面）。
- 每个配置的 `speech-to-text-http` 服务一张卡：名称、端点、模型、凭据引用，以及经 `credentials/set` 与派生引用写入的 API key（模型设置区 `storeCredential` 的模式）。服务列表编辑以设置变更落在 `speech-to-text-http` 配置命名空间；卡片展示密钥状态（是否已配置）。形态专属字段仍走配置文件。

Host 接线：http 包的 `Config` 注册为设置描述符命名空间（Host `SettingsForms` 投影），既有实验性 api speech-to-text 远端面按需补齐分区所需的 list/configure 操作（先核实其现有面；扩展而非复制）。

### S2.5 文档与门禁

重新生成配置目录（双语并校验配对），更新 http 包 README 对，在包 README 对里说明新配置面与分段行为，添加变更记录，若花名册或设置面出现在既有期望输出中则刷新录制快照。

## [S3] 范围

- 范围内：seam 分段转写；可选 `model` 与通用 auth-header/点路径/raw-body 机制；国内形态（tencent-sentence、xfyun-filetrans、volcano-flash）与国际形态（deepgram-listen、google-speech-v1、azure-fasttranscribe、aws-transcribe）；内置 `deepseek-asr` + `dashscope-qwen3`；语音设置分区；文档/目录/快照/变更记录更新。OpenAI 兼容的国际服务（OpenAI、Groq、Mistral）无需代码——以配置配方记录。
- 范围外：WebSocket 流式 adapter（实时提供者）；新提供者的说话人分离；会议页识别器选择器超出花名册既有展示的改动；zh/en 对之外的本地化；Azure 批量转写与任何只收音频 URL 的提供者（豆包标准 submit/query 版）。

## Tasks

- [ ] T1: seam 分段转写 — info 上限字段、wave 读取/切片助手、安静边界切片循环、合并语义、单元测试（依赖：无）
- [ ] T2: 通用请求层 — 可选 model、authHeader/authStyle、点路径 textField、raw-body 形态（依赖：无）
- [ ] T3: 国内形态 — tencent-sentence、xfyun-filetrans、volcano-flash、逐形态密钥字段、单元测试（依赖：T2）
- [ ] T4: 国际形态 — deepgram-listen、google-speech-v1、azure-fasttranscribe、aws-transcribe（最后；重商量点）、单元测试（依赖：T2）
- [ ] T5: 基础语音 profile 内置 deepseek-asr + dashscope-qwen3（依赖：T3）
- [ ] T6: 语音设置分区包 + Host 面接线（依赖：T3、T4）
- [ ] T7: 文档、目录、升级指南、变更记录、快照（依赖：T1–T6）

## [S4] 验收

- [ ] 带 `DEEPSEEK_API_KEY` 的新 profile 在会议花名册显示 `deepseek-asr`，并通过 `/v1/tools/asr` 转写 8 秒片段（不发送 `model` 字段）。
- [ ] 带 `DASHSCOPE_API_KEY` 的 profile 显示 `dashscope-qwen3`，经兼容端点转写。
- [ ] 向上限低于 40 分钟的服务导入 40 分钟 WAV 产出合并转写（文本拼接、分段时间平移、总时求和），无 "Audio exceeds" 错误；单元测试覆盖切片边界、合并与安静边界兜底。
- [ ] `tencent-sentence` 对固定时钟产出确定性 TC3 签名（单元测试）并解析 `Response.Result`。
- [ ] `xfyun-filetrans` 上传、轮询至完成并返回文本（假服务单元测试）。
- [ ] `volcano-flash` 按文档头发送 base64 音频并读取文本与分句分段（假服务单元测试）。
- [ ] `deepgram-listen`、`google-speech-v1`、`azure-fasttranscribe` 各自构造文档化的请求形态并解析文档化的应答（假服务单元测试）。
- [ ] `aws-transcribe` 通过假服务往返（上传 → 启动 → 轮询 → 读取），或本特性带着重商量结论与理由回到用户。
- [ ] 设置分区列出内置与用户服务，经设置变更编辑服务字段，经凭据设置与移除密钥，切换默认识别器；全部持久化到 profile。
- [ ] 聚焦测试、类型检查与 doc-sync 通过；locale 对校验通过。
