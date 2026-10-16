# 产物 Bootstrap Fixture

[English](README.md) | 中文

这些示例 manifest 是 `artifact-schema-check.sh` 的 bootstrap fixture。

它们不是权威的运行时输出。它们的存在是为了让 Phase 5 能够校验以下文件中定义的最小字段集：

- `docs/current/AEGIS_ARTIFACT_SCHEMA_BASELINE.md`

长任务续做 fixture 还额外覆盖：

- `BaselineUsageDraft`
- `TodoCheckpointDraft`
- `ResumeStateHint`
- `DriftCheckDraft`

goal-framing 与 subagent 交接 fixture 还额外覆盖：

- 可选的 `TaskIntentDraft` 目标字段
- `SubagentContextPacket`

这些只是草稿 / 提示 fixture。它们不是持久的运行时记录，也不授予完成权威。
