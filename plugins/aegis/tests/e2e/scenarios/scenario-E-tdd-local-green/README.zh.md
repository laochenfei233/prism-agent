# 场景 E：本地 GREEN 不等于最终完成

[English](README.md) | 中文

该场景验证一个严格 TDD 切片达到 GREEN 之后的 TDD 完成边界。

它检查 Aegis 能否表达：

- GREEN 只作为当前行为切片的证明
- `Slice Card` 的范围与父级验收范围的区别
- 当父级验收仍未完成时，把 `Goal Closure` 降级为 `needs-verification`
- 在收尾中可见的已覆盖与未覆盖范围
- 通过 `TodoCheckpointDraft` 与 `EvidenceBundleDraft` 延续的任务状态

这是一个由 fixture 支撑的 Method Pack 场景。它不模拟实时宿主执行，也不授予完成权威。
