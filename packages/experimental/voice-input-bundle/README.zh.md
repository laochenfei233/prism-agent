---
description: "从插件管理页启用实验性语音输入。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-voice-input-bundle

[English](README.md) | 中文

## 概述

此可选 Bundle 组合语音服务定义、本地 SenseVoice 识别器、在线 DashScope 识别器、带认证的 Remote 与浏览器麦克风控件。随包配置默认禁用。识别默认在本机完成；选择在线识别器后音频改为流式发送到该服务，且无需下载模型。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

打开 Web 侧栏的插件管理页并启用带蓝色声波图标的“语音输入”。模型需要准备时，弹窗提供“前往安装”和“稍后”选项；“前往安装”打开 Bundle 详情。缓存完整时不会提示安装。在详情中选择“下载并准备”；默认折叠的当前步骤摘要可展开为完整步骤列表。下载报告真实字节，校验和加载显示等待时间。就绪后点击模型选择器与发送按钮之间的麦克风，再点击停止以插入转写文字。Bundle 详情通过 Settings 服务保存识别器和语言。禁用 Bundle 会取消当前任务；缓存资源保留在磁盘上。

### 识别器

Bundle 详情列出已组合的每个识别器以及各自的处理位置。

- **SenseVoiceSmall** 在本机运行。首次使用时下载原生运行时与模型，支持自动语言检测，不把音频发送到任何地方。
- **DashScope fun-asr-realtime** 在线运行。它通过双工 WebSocket 把单段录音流式发送到 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`，不下载任何内容，并立即报告就绪。选择它意味着把录音发送到该服务，因此需要 key：在 profile 凭据或 Harness home 的 `.env` 中设置 `DASHSCOPE_API_KEY`，受控部署也可直接设置该条目的 `apiKey`。没有 key 时识别器仍会注册，并在请求时以该提示失败。

两个识别器都接受 `zh`，也就是组合的默认语言。SenseVoice 另外支持 `en`、`yue`、`ja`、`ko` 及自身的 `auto` 检测；在线识别器不接受 `auto`。所选识别器未声明的语言会让偏好写入失败，而不是被静默忽略。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>维护者信息 — 点击展开</summary>

静态 `cordis.patch.yml` 添加五个语音条目，选择 `sensevoice-local` 作为默认识别器，通过 `dshHomePath` 提供 SenseVoice 缓存目录，并在其旁挂载在线识别器。语音条目声明了 `language: zh`：patch 会整体替换目标条目的 config，若省略该字段，在 base 层之上启用本 Bundle 会丢掉 base 层的语言设置，并使云端识别器无法被选中。可选 Bundle 安装使插件管理器能够发现此包，但不会在默认配置中选择它。浏览器贡献拥有其生成 Remote 的挂载；稳定 API Remotes 不导入实验性代码。此纯配置包没有独立可变的运行时状态，因此不发布不变量伴随模块。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[语音输入子系统](../../../docs/subsystems/voice-input.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，因为录音与准备不进入模型请求；之后的文字由普通用户提交拥有。

#### KV 缓存影响

没有直接影响；普通提交拥有消息内容。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 此 Bundle 只组合两个识别器。需要第三个的部署应使用自己的 id 注册到同一服务并添加条目；Bundle 不增加模型工具或修改智能体循环。
- 在线识别器会把录音发送到 DashScope，且在没有解析到 key 时于请求时失败；Bundle 不会在注册识别器时校验 key。
- 安装 dsh 时会一并安装 `sherpa-onnx-node` 及其平台原生运行时（含 ONNX Runtime），即使此 Bundle 处于禁用状态。运行时的磁盘占用和下载量独立于“下载并准备”所下载的模型；原生包体积随平台和版本变化。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

无。

</details>
