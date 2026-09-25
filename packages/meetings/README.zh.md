---
description: "会议纪要能力组：持久化会议与回答、配置化摘要，以及面向模型的会议工具。"
kind: "package-group"
---

# meetings/ — 会议纪要能力族

[English](README.md) | 中文

## Summary

meetings 组在 Session 日志之外持久化会议记录，并向模型提供受控操作。服务负责录音转写、配置化摘要和持久化问答；工具包把这些能力投影为显式模型工具。类型词汇和生成的 Cordis API 见[会议子系统页](../../docs/subsystems/meetings.zh.md)。

## Table of Contents

- [Packages](#packages)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`meeting-minutes/`](meeting-minutes/README.zh.md) | 存储会议和回答，转写完整录音，并执行配置化的摘要和回答 | `ctx.meetingMinutes` |
| [`tool-meeting-minutes/`](tool-meeting-minutes/README.zh.md) | 面向模型的会议创建、列表、读取、摘要和提问工具 | 贡献会议工具 |

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
