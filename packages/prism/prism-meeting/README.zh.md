---
description: "Prism 会议 profile 层：持久会议记录、实时麦克风转写、配置化摘要、面向模型的会议工具，以及 Web 会议页面，供用户在 dsh profile 中加入会议记录能力。"
kind: "package-bundle"
---

# @prism-ai/prism-meeting

[English](README.md) | 中文

## 概述

这个 bundle 为基于 base 的 `dsh` profile 加入会议记录能力：持久会议存储、实时麦克风转写、一个用于摘要和提问的配置化模型路由、面向模型的会议工具，以及 Web 会议页面。目前没有随包发布的 profile 包含它，profile 通过安装这个包并重启来获得它。该 profile 需要 base 的 LLM、storage-domain、speech-to-text 和 tools 服务，以及用于识别的语音提供者密钥。没有 Web Connection 的 profile 会让页面那一行保持 pending 而不是失败；这个包是可安装的层，而不是一个库。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

把 tarball 安装到基于 base 的 DSH profile，然后重启该 profile：

```sh
dsh plugin --profile <profile> add /absolute/path/to/prism-ai-prism-meeting-0.1.0.tgz
dsh --profile <profile>
dsh plugin --profile <profile> remove @prism-ai/prism-meeting
```

本包声明了 `dsh.bundle.patch`，因此 `dsh plugin` 会把它作为 profile 层来协调，而不是挂载单个插件。该 profile 需要 base 的 LLM、storage-domain、speech-to-text 和 tools 服务。音频识别需要设置 `DASHSCOPE_API_KEY`，或为该 profile 配置其他语音提供者。

### 你获得什么

patch 插入三行，每一行的行为都由其包拥有。

- `prism-meeting` 注册 `ctx.meetingMinutes`：`meeting_minutes` 存储域、部署配置的用于摘要和会议提问的模型路由，以及语音提供者准备控制。
- `tool-prism-meeting` 注册五个面向模型的操作：`meeting_minutes_create`、`meeting_minutes_list`、`meeting_minutes_get`、`meeting_minutes_summarize` 和 `meeting_minutes_ask`。
- `prism-meeting-web` 注册 `/api/prism-meeting` 下的浏览器路由，以及侧边栏面板栏中的会议页面。页面可就地启动并跟踪语音提供者准备及其进度，并在页面内保存问答。

缺少 Web Connection 的 profile 会让 `prism-meeting-web` 保持 pending 而不是失败，因此无头 profile 拥有服务和工具而没有页面。客户端模块在启动时扫描，因此页面在 profile 重启后出现。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

这个 bundle 是一份 patch 文档，只有一条 `insert` 列表；它命名的服务、工具和浏览器条目都是本包同时发布的普通插件。

### 组合机制

patch 条目会整体替换目标行的 `config` 而不是合并进去，后续 bundle 层和用户自己的 profile patch 按 id 覆盖行，后者胜出。insert 列表复用了 `prism-meeting` 和 `tool-prism-meeting` 两个 id，因此已经挂载这些行的 base profile 各保留一行，而更早的 profile 会从这个 bundle 获得它们。`prism-meeting-web` 注入 `connection`，这正是它在没有 Web Connection 的 profile 中保持 pending 的原因。

### 源码对照

| 文件 | 作用 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | bundle 本体：插入的三行，以及作为行内注释的逐行理由 |
| [`src/index.ts`](src/index.ts) | `ctx.meetingMinutes`：持久记录、录音生命周期、配置化摘要与回答 |
| [`src/spec.ts`](src/spec.ts) | `meeting_minutes` 存储域声明 |
| [`src/types.ts`](src/types.ts) | 公开的请求与记录词汇 |
| [`src/tools.ts`](src/tools.ts) | 面向模型的工具行 |
| [`src/web.ts`](src/web.ts) | 浏览器路由行 |
| [`src/client/`](src/client/) | 会议页面及其侧边栏入口 |
| [`tests/`](tests/) | 服务、路由、工具和页面行为 |

### 不变量归属

未发布运行时不变量伴生包：服务是变更顺序和依赖记录删除的唯一独立观察方，浏览器和工具行通过它读取，而不持有第二份副本。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [会议子系统](../../../docs/subsystems/meetings.zh.md) —— 记录词汇、录音生命周期、服务语义和浏览器接口。
- [语音转文字](../../speech/speech-to-text/README.zh.md) —— `ctx.meetingMinutes` 解析的识别接缝。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#prism-aiprism-meeting) —— 模型看到的精确 schema。
- [生成的组合图](../../../apps/cli/composition.md) —— 随包发布的 profile 如何解析这些行。
- [Prism 包分组](../README.zh.md) —— 其他 Prism 能力面。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

`./tools` 子路径在[生成的工具目录](../../../docs/tool-catalog.zh.md#prism-aiprism-meeting)中注册 `meeting_minutes_create`、`meeting_minutes_list`、`meeting_minutes_get`、`meeting_minutes_summarize` 和 `meeting_minutes_ask`。创建需要标题和完整转写；列表无输入；读取、摘要和提问需要会议 id，提问还需要问题。成功结果是紧凑 JSON 投影；失败保留验证、未找到、模型、存储和取消错误。

#### Token 影响

插件可见时，五个固定 schema 会出现在每个请求中。转写文本只出现在创建参数和 `meeting_minutes_get` 结果中；`meeting_minutes_list` 返回转写长度而不是内容。

#### KV 缓存影响

插件可见性不变时，工具定义保持前缀稳定。较长的读取结果和创建参数按正常仅追加历史增长。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些是当前这一层的约束，不是泛泛的比较。

- **记录只有一个最新摘要** —— 不暴露摘要修订和回答删除。
- **工具面不提供删除、回答列表、更新或音频导入操作** —— 模型不能选择语音提供者，工具创建路径只支持文本导入。
- **只有语音提供者会区分说话人时才有说话人标签** —— 不区分的提供者不存片段，且标签只在其所在的那次录音内有意义。
- **流式识别和导出格式不在范围内。**
- **`audioSeconds` 信任语音提供者或调用者**，不会独立解码音频。
- **实时转写每八秒新增音频向语音提供者请求一次** —— 最后一段之后的音频不会被识别，会议以分段文本原样结束。
- **页面中途关闭而留在录音状态的记录**只保留最后写入的片段，直到操作者关闭它。
- **推送的会话属于目录中的第一个 Workspace**，因为没有任何客户端服务暴露当前会话所用的 Workspace。
- **页面音频上传由 Connection 缓冲**，并受其请求体上限约束。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者信息 — 点击展开</summary>

Prism 拥有此包；服务保留 DSH 的 `ctx.meetingMinutes` 能力名。bundle 载体是一个包，它同时发布自己插入的服务、工具和浏览器条目，因此其 README 遵循 bundle 模板，而「模型体验」一节保持结构化形式：工具行正是本包自己的贡献。

</details>
