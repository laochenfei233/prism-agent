---
feature: meeting-minutes-plugin
status: delivered
updated: 2026-09-26
branch: codex/meeting-minutes-plugin
commits: base..HEAD
---

# Prism 会议插件

[English](meeting-minutes-plugin.md) | 中文

## Report

**已构建内容** — `@prism-ai/prism-meeting` 现在通过 `ctx.storageDomain` 持有持久的会议记录和回答。它可以从转写文本或完整音频创建会议，规范化并限制输入，提供列表、读取和删除，生成配置模型摘要和持久化问答，并确保失败或取消的模型工作不会改变持久状态。

同一个包通过 `@prism-ai/prism-meeting/tools` 暴露创建、列表、读取、摘要和提问工具。语音转文本服务和 DashScope 提供方已提升到 `packages/speech`，基础 bundle 会注册两个入口，并同步了 `deepseek-harness` 的最新桌面修复。

**验证** — `pnpm run test -- packages/prism packages/speech` 通过 6 个文件、52 个测试；会议服务聚焦规范通过 24 个测试，包发现/工作区约束规范通过 108 个测试。移除两处提交前取消检查会让两个晚到取消回归失败，恢复后聚焦套件重新 24/24 通过。`packages/prism packages/speech` 的 `oxlint`、`pnpm run typecheck`、`pnpm run test:snapshot -- -t meeting-minutes-list`、`pnpm run verify-package-invariants`（38 个 companion）、`pnpm run duplication`（0 个克隆）、`publint` 以及 `pnpm run verify-doc-budgets`（8 个文档）通过。同步的桌面文件与 `deepseek-harness` 逐字节一致，且 `cargo fmt --check` 通过。仓库引用门禁仍只报告 `archive-import-prism-agent-e.md`；仓库级 hygiene 仍保留已记录的既存 vendor rescope、工作区约束、desktop license 和 ACP Cordis 配置失败。

**历程记录** — 语音转文本接缝和 DashScope 提供方从 experimental 包提升，使会议音频能够解析一个明确的 Host 提供方。最初的取消测试通过测试 LLM 队列完成，即使没有持久写入前检查仍会通过；最终回归通过一个自定义 awaitable 完成模型工作，并在服务恢复前中止，因此变异测试能够证明每处检查都不可省略。空音频取消在验证之前断言，使调用方取消保持为第一个可观察失败。随后服务和工具包合并到 Prism 所属的 `@prism-ai/prism-meeting` 包，使后续产品可以扩展 DSH 而不占用其包命名空间。

## [S1] 问题

先前的 Electron 版本可以持久化会议元数据和转写、生成 AI 摘要、就会议提问，并记录这些回答。DeepSeek Harness 没有等价能力，因此插件、工具和未来 Host 界面无法使用会议工作。

## [S2] 设计

- 添加 `@prism-ai/prism-meeting`，作为 `ctx.meetingMinutes` 上的 Host 服务提供方。
- 用 `ctx.storageDomain` 保存跨 Session 的会议记录和回答；不要把跨 Session 资源放入 Session 日志。
- 用 `ctx.speechToText` 转写完整录音，用 `ctx.llm` 生成摘要和回答。
- 添加同一个包的 `./tools` 入口作为面向模型的消费者，提供显式的列表/读取/创建/摘要/提问操作。
- 要求部署配置摘要和回答的模型路由、提示词以及转写上限。服务代码不提供隐藏模型默认值。
- 在公共操作输入处规范化标题、参与者名称、转写和问题；持久记录 schema 校验要保存的 JSON。
- 跟踪服务拥有的工作，使释放时中止音频/模型工作、等待结算并关闭存储域。
- 包含工作区中已准备好的 DashScope 转写提供方，使语音选择拥有宿主云提供方。

## [S3] 范围

- 属于范围：服务、持久存储、音频和转写导入、摘要、问答持久化、面向模型的工具、测试、README、组合注册、文档/能力组/配置注册，以及同步 `deepseek-harness` 的最新桌面更新。
- 不属于范围：Web 卡片或 Host 会议界面、流式语音识别、日历集成、说话人分离、文件/音频附件持久化以及导出格式。

## Tasks

- [x] T1：实现持久会议服务和音频/转写导入。
- [x] T2：实现摘要和持久化问答操作。
- [x] T3：实现面向模型的会议工具。
- [x] T4：集成 DashScope 语音提供方，并在基础 bundle 中注册两个 Prism 会议入口。
- [x] T5：运行聚焦验证并修复失败。

## [S4] 验收

- [x] 可以从转写或音频创建会议，并列表、读取和删除；删除会移除其回答。
- [x] 摘要调用配置的 LLM 路由并持久化成功的摘要；失败时记录保持已转写状态。
- [x] 提问调用配置的 LLM 路由，返回回答，并持久化问答对。
- [x] `@prism-ai/prism-meeting/tools` 入口可以通过 `ctx.meetingMinutes` 执行列表/读取/创建/摘要/提问，并安全注册/释放。
- [x] 语音转音频导入使用显式解析的语音提供方，并响应取消。
- [x] 与变更面相关的 TypeScript、聚焦测试、lint、duplication、hygiene 和文档门禁通过。
