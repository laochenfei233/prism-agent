---
description: "面向模型的 meeting_minutes 工具：经实验性语音 seam 转写一段录音，把转写稿存到录音旁边，并返回供智能体填写的纪要结构。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-meeting-minutes

[English](README.md) | 中文

## 概述

`meeting_minutes` 把一段会议录音变成两样智能体可以接着处理的东西：转写稿（以文件形式存放在录音旁边）和会议纪要文档的结构。工具到此为止。写纪要由智能体自己完成，用它日常的文件工具，因此纪要在语言、详略与侧重上都跟随当前对话，而不是依赖第二次固定的模型调用。

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

通过[会议纪要 bundle](../meeting-minutes-bundle/README.zh.md) 加载，或把本包与[语音 seam](../speech-to-text/README.zh.md) 及一个文件系统提供方并列声明。工具需要 `ctx.tools`、`ctx.fs` 与 `ctx.speechToText`，缺少其中任何一个的组合都会让它保持挂起。

模型以录音路径调用它，并指定四种结构之一：

| 参数 | 含义 |
|---|---|
| `audio_path` | 录音路径，相对于会话工作区或绝对路径。必须是 16 kHz 单声道 PCM16 WAV。 |
| `title` | 会议标题；默认取录音文件名。 |
| `participants` | 调用方被告知的参会人姓名。识别器不区分说话人。 |
| `template` | `default`、`detailed`、`action-focused` 或 `decision`。默认 `default`。 |
| `language` | 传给识别器的语言提示；省略即用组合的默认值。 |

`maxAudioBytes` 限制本工具读入内存的录音大小，`maxPreviewCharacters` 限制结果携带的转写稿长度。转写稿文件始终保存完整文本，因此一场长会议付出的是一次 `read` 调用，而不是一段被截断的结果。

四套结构是从本功能来源的会议应用移植而来的产品内容：基础大纲、按议题的详细记录、行动项表格与决策记录。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节——点击展开</summary>

`execute` 经 `ctx.fs` 解析录音，要求它是普通文件，在 `maxAudioBytes` 内读取，并把字节交给 `ctx.speechToText.resolve` 与 `transcribe`。转写稿文档写入录音路径把最后一个扩展名换成 `.transcript.md` 的位置，走的是常规写入路径：`ctx.fs.resolve`、`fs/write-intent` waterfall、`ctx.fs.writeText`，然后 `fs/observed`。规范结果携带预览、字符数、实测时长、所选结构以及两个派生路径。

转写稿文档的头部记录标题、转写时刻、时长、具名参会人与源录音。格式化与预览是 `transcript.ts` 中的纯函数。

工具不写纪要，因此它返回的纪要路径只是一个智能体可以忽略的建议：返回值把 `<录音>.minutes.md` 命名为转写稿旁边的位置，面向模型的渲染则让智能体写到那里。没有任何东西强制这一选择，也不需要——产出的文件归智能体所有。

写入运行在文件系统后端自身的默认围栏之下：工具不解析逐调用沙箱策略，也不提供 `write` 与 `edit` 工具所带的提权字段，因为一份紧邻源文件的派生产物并不是用户为其选定策略的变更。写入被拒绝时，调用以该后端自身的错误失败。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[语音输入子系统](../../../docs/subsystems/voice-input.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### Tool schema

#### What the model sees

The model sees the generated [`meeting_minutes` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-meeting-minutes): one required `audio_path` string plus optional `title`, `participants`, `template`, and `language`. `template` is a closed enumerable set (`default`, `detailed`, `action-focused`, `decision`). The description states the accepted audio format, that the tool writes the transcript, and that the minutes are the agent's own work.

#### Token effect

Fixed schema cost on every request where the tool is visible; the schema is stable for a given configuration and does not vary with the recording.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each call retains its arguments in the assistant tool call until compaction. The result carries the recording path, the transcript path, the suggested minutes path, the transcript's character count, the measured audio and inference durations, the chosen structure, and the transcript preview — followed by that structure's Markdown so the agent can fill it in. When the transcript exceeds `maxPreviewCharacters`, the render says so and names the transcript file to read instead.

#### Token effect

Conditional and caller-controlled: the result grows with `maxPreviewCharacters`, and the structure adds a fixed few hundred tokens. A short meeting returns its whole transcript; a long one returns only the preview plus one instruction sentence.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **只接受 WAV 输入** —— seam 的规范录音约定是 16 kHz 单声道 PCM16 WAV，本工具不解码其他格式。使用压缩录音的调用方需先行转换；工具描述中已写明这一要求。
- **纪要不由本工具写入、校验或套模板** —— 智能体产出的文件质量取决于它自己的写作，且没有任何组件检查返回的结构是否被保留。
- **没有说话人归属** —— seam 的 `Transcript` 只携带文本，因此即使所捆绑的识别器请求了分离标注，转写稿也无法标明谁说了什么。
- **四套结构是中文产品内容** —— 内置的四套大纲与功能来源的会议应用一致。面向其他语言的部署需要在自己的分支中替换；配置目前尚不提供模板覆盖。
- **没有沙箱提权** —— 被文件系统后端拒绝的写入会使调用失败，且没有 `write` 与 `edit` 工具提供的一次性提权。请提高写入模式，或用那些工具写入转写稿。
- **建议的纪要路径不被强制** —— 智能体可以写到任何位置，返回的路径是建议而非约定。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节——点击展开</summary>

无。

</details>
