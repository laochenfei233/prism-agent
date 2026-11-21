---
feature: meeting-transcribe-followups
status: delivered
updated: 2026-11-06
branch: fix/meeting-transcribe-followups
commits: e13f05ae1c..HEAD # filled at delivery
---

# 会议转写后续修复

[English](meeting-transcribe-followups.md) | 中文

## Report

**构建内容** —— 结束会议不再重转写整段录音：`onFinish` 等待未完成的分段写入、释放麦克风，用分段已保存的转写与录制时长关闭记录。实时提示与结束阶段文案如实说明，`liveFinalFailed` 路径从中英文字典移除。工具栏增加由语音状态驱动的识别器选择器：切换经 `selectSpeech` → `ctx.speechToText.configure` 持久化部署的语音选择（`speech/select` 路由承载），并挑选提供者接受的语言（当前选择语言，否则 `auto`，否则其第一个语言），分段与导入随之路由到所选提供者——云端或 HTTP 提供者终结了向本地模型的引导。关闭语音提示改为记住被关闭的文本而非粘性开关：选择器与轮询照常工作，文本变化（例如下载转为失败）会再次显示。

**验证** —— `pnpm exec vitest run packages/prism/prism-meeting` —— 182 个测试、8 个文件全部通过（结束不做第二次识别、选择器切换与失败呈现、关闭后保留且变化后重现、compatibleLanguage、select 请求形态与收窄）。包 host/client 两面 `tsc -b` —— 0 个自有错误（`packages/api/*` client face 的 50 个错误是干净工作树上暴露的 fork 既有聚合问题，本变更未触及）。`run-oxlint` —— 0/0。`verify-cordis-api` —— 重新生成目录后转绿（`selectSpeech` 与 `languages`/`language` 投影已录入子系统文档与 tool-cordis api 目录；生成器在该基线已可干净运行）。`verify-translation-pairing` —— 仅剩已记录的既有红项。重建的 tarball 已覆盖 `web` profile 里的 9 月包（patch 行不变；profile 重启加载新客户端包）。

**Journey log** —— 多余的收尾转写正是操作者看到的唯一失败点；删掉它也删掉了失败模式。选择在下一层早已存在（`ctx.speechToText.configure`），页面功能只是一个投影加一条路由，不是第二套设置系统。桩返回同一个可变对象让 React 跳过了关闭测试需要的重渲染——状态持有者必须交出新引用。生成器健康度在我们脚下变了：`gen-cordis-catalog` 记录为基线损坏、现已干净运行，手工投影的 workaround 用一次即退役。

## [S1] 问题

已安装的会议页有三条操作者反馈：(1) 分段转写仍报 "Prepare the local speech provider before recording"——部署的 profile 跑的是 9 月的插件包，没有转写自动等待；(2) 结束会议时明明八秒分段已经保存了转写，还要把整段录音重新转写一遍——这个多余步骤正是失败的那一步，识别成本也翻倍；(3) 页面没有识别器选择，配置了云端/HTTP 提供者的部署仍被引向本地模型。

## [S2] 设计

### S2.1 结束时保存实时转写

- `onFinish` 等待未完成的分段写入、停麦克风，然后用已积累的实时转写（`liveBody`）`finish`——不做第二次识别调用，没有 `liveFinalFailed` 路径。`audioSeconds` 用录制的实际时长，与请求类型的文档回退语义一致。
- 文案更新：实时提示改为“每 N 秒保存一次分段”（不再承诺结束时重转写整段），结束阶段文案改为“正在结束”，`liveFinalFailed` 键从中英文字典移除。

### S2.2 页面上的识别器选择

- `MeetingSpeechProvider` 增加 `languages`（宿主视图本就携带）；`MeetingMinutesService.selectSpeech(providerId, language?)` 通过 `ctx.speechToText.configure` 持久化选择并返回新状态；`speech/select` 路由暴露它。
- 工具栏增加识别器 `<select>`，由语音状态驱动；切换时页面挑选兼容语言（当前选择语言被接受则用之，否则接受 `auto` 则用 `auto`，否则用提供者的第一个语言）并调用 `selectSpeech`；警告条的关闭不再丢弃状态，选择器与轮询照常工作。
- 选中云端或 HTTP 提供者后，分段与导入经既有默认选择路由过去；除非选中本地提供者，否则不触发本地模型下载。

### S2.3 修复的部署

- 在工作树重新构建插件并打包，把 tarball 覆盖安装到 `web` profile 里陈旧的 9 月包上，让已落地的自动等待与本次修改真正跑起来；profile 重启以加载新客户端包。

## [S3] 范围

- 范围内：页面结束/分段行为与文案、语音提供者投影与选择服务/路由/api/页面、中英文文案、触及行为的测试、插件重建与安装到 `web` profile、spec 三件套。
- 范围外：SenseVoice/DashScope 提供者包、独立的 `feat/huiji-integration` 会议血脉、流式识别、按会议（非持久化）的提供者覆盖。

## Tasks

- [x] T1: 结束时保存实时转写；文案更新（依赖：无）
- [x] T2: 提供者选择——投影、服务、路由、api、页面、文案（依赖：无）
- [x] T3: T1–T2 的测试（依赖：T1、T2）
- [x] T4: 验证 + 评审 + 收尾；重建并把插件安装进 `web` profile（依赖：T3）

## [S4] 验收

- [x] 结束会议不发起第二次识别请求；持久记录携带已积累的分段转写与录制时长。
- [x] `liveFinalFailed` 文案移除；实时提示不再承诺结束时的整段重转写。
- [x] 页面列出已注册识别器及其语言，切换经语音选择持久化，其后的分段使用新选中的提供者。
- [x] 选择失败以操作者可读的错误呈现，原选择保持不变。
- [x] 触及面上的聚焦测试、typecheck、lint 通过；重建的 tarball 安装进 `web` profile 且其 `lib/index.js` 含自动等待符号。
