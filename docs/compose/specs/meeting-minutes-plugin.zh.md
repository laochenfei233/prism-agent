---
feature: meeting-minutes-plugin
status: in-progress
updated: 2026-09-25
branch: codex/meeting-minutes-plugin
commits: base..HEAD
---

# 会议纪要插件

[English](meeting-minutes-plugin.md) | 中文

## Report

实现仍在进行中。

## [S1] 问题

先前的 Electron 版本可以持久化会议元数据和转写、生成 AI 摘要、就会议提问，并记录这些回答。DeepSeek Harness 没有等价能力，因此插件、工具和未来 Host 界面无法使用会议工作。

## [S2] 设计

- 添加 `@deepseek-ai/dsh-meeting-minutes`，作为 `ctx.meetingMinutes` 上的 Host 服务提供方。
- 用 `ctx.storageDomain` 保存跨 Session 的会议记录和回答；不要把跨 Session 资源放入 Session 日志。
- 用 `ctx.speechToText` 转写完整录音，用 `ctx.llm` 生成摘要和回答。
- 添加 `@deepseek-ai/dsh-tool-meeting-minutes` 作为面向模型的消费者，提供显式的列表/读取/创建/摘要/提问操作。
- 要求部署配置摘要和回答的模型路由、提示词以及转写上限。服务代码不提供隐藏模型默认值。
- 在公共操作输入处规范化标题、参与者名称、转写和问题；持久记录 schema 校验要保存的 JSON。
- 跟踪服务拥有的工作，使释放时中止音频/模型工作、等待结算并关闭存储域。
- 包含工作区中已准备好的 DashScope 转写提供方，使语音选择拥有宿主云提供方。

## [S3] 范围

- 属于范围：服务、持久存储、音频和转写导入、摘要、问答持久化、面向模型的工具、测试、README、组合注册以及文档/能力组/配置注册。
- 不属于范围：Web 卡片或 Host 会议界面、流式语音识别、日历集成、说话人分离、文件/音频附件持久化以及导出格式。

## Tasks

- [ ] T1：实现持久会议服务和音频/转写导入。
- [ ] T2：实现摘要和持久化问答操作。
- [ ] T3：实现面向模型的会议工具。
- [ ] T4：集成 DashScope 语音提供方，并在基础 bundle 中注册会议插件。
- [ ] T5：运行聚焦验证并修复失败。

## [S4] 验收

- [ ] 可以从转写或音频创建会议，并列表、读取和删除；删除会移除其回答。
- [ ] 摘要调用配置的 LLM 路由并持久化成功的摘要；失败时记录保持已转写状态。
- [ ] 提问调用配置的 LLM 路由，返回回答，并持久化问答对。
- [ ] 模型工具可以通过 `ctx.meetingMinutes` 执行列表/读取/创建/摘要/提问，并安全注册/释放。
- [ ] 语音转音频导入使用显式解析的语音提供方，并响应取消。
- [ ] 与变更面相关的 TypeScript、聚焦测试、lint、duplication、hygiene 和文档门禁通过。
