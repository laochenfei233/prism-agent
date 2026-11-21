# Transcript Fixture

[English](README.md) | 中文

本目录包含用于当前 Layer 2 行为检查与受控回放样例、由 fixture 支撑的 transcript。

- `with-aegis/` 存放正向 transcript，它们应当满足场景行为约定
- `tests/e2e/baselines/without-aegis/` 存放对照 transcript，它们有意缺少同等程度的 method-pack 行为

这些 fixture 是建议性验证输入，不是权威的运行时输出。
