---
description: "把一个 DashScope 会议转写器与 meeting_minutes 工具组合成一个可安装单元的按需启用 bundle。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-meeting-minutes-bundle

[English](README.md) | 中文

## 概述

这个 bundle 用一次开关为 harness 部署加上会议纪要能力：实验性语音 seam、其后的 DashScope 识别器，以及面向模型的 `meeting_minutes` 工具。它出厂即关闭，因为识别器会把录音上传到云服务，并且需要一个本 bundle 无法提供的密钥。

## 目录

- [使用本 bundle](#use-this-bundle)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-bundle"></a>
## 使用本 bundle

通过插件管理器启用（它被列在出厂的可选 bundle 之中），或在某个 profile 的 bundle 列表中指名。请在 harness 启动所在的环境中设置 `DASHSCOPE_API_KEY`，或用 `credentials` 服务以该名存储；也可以在 `speech-to-text-dashscope` 行的 `apiKey` 上固定一个字面密钥。

本 bundle 的补丁插入三行：[语音注册表](../speech-to-text/README.zh.md)（`defaultProvider: dashscope-funasr`）、以该 id 注册的 [DashScope 识别器](../speech-to-text-dashscope/README.zh.md)，以及[会议纪要工具](../tool-meeting-minutes/README.zh.md)。替换识别器意味着替换它那一行；工具与其结构集合保持不变。

本 bundle 与语音输入 bundle 共用同一个语音注册表。两者为不同识别器配置同一个 `defaultProvider`，因此一个部署应启用其中之一，而不是两者。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>维护者细节——点击展开</summary>

`cordis.patch.yml` 就是全部组合；`src/index.ts` 不导出任何东西，因为本 bundle 不贡献自己的代码。补丁与其他 bundle 层一起应用，因此它的行与任何其他条目行为一致：id 正是后续 profile 补丁用于替换识别器、停用工具或调整两个上限的定位点。

本 bundle 不带图标、不带客户端界面：它为智能体增加一项能力，而不是为 UI 增加一个页面。转写稿落在会话工作区内，用智能体日常的文件工具读取。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

[语音输入子系统](../../../docs/subsystems/voice-input.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

Indirectly, through [`dsh-experimental-tool-meeting-minutes`](../tool-meeting-minutes/README.zh.md), whose schema, description, and result the bundle composes into an agent.

#### KV Cache effect

No direct effect; the tool row owns every model-visible byte the bundle contributes.

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **仅云端** —— 所捆绑的识别器会把录音上传到 DashScope。必须让音频留在本机的部署应改用语音输入 bundle 的本地识别器，并自备面向文件的消费方。
- **没有密钥就无法转写** —— 本 bundle 出厂即关闭，且识别器在没有可用 `DASHSCOPE_API_KEY` 时会让调用失败；没有任何环节提示输入密钥或在加载时校验它。
- **与语音输入互斥** —— 两个 bundle 都配置 `speech-to-text` 的 `defaultProvider`，因此同时启用会让一个识别器成为两个功能的默认值。
- **工具行不绑定任何 preset** —— 会话运行在智能体 preset 之后的部署，还必须把该工具加入 preset 的插件列表；仅有本 bundle 的行只会把它注册到主机注册表中。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者细节——点击展开</summary>

无。

</details>
