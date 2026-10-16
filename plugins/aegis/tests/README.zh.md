# Aegis 测试面

[English](README.md) | 中文

本目录划分为两个测试面。

## 公开质量验证

`tests/` 下受跟踪的测试套件属于 Aegis 公开质量验证面的一部分。它们应当可以从一次干净的检出中复现；当它们需要本地 agent CLI、模型访问或插件安装时，应当明确标注为可选的宿主集成检查。

主要的公开入口：

- `e2e/` - 发布与治理验证编排
- `opencode/` - OpenCode 宿主兼容性检查
- `codex-plugin-sync/` - Codex 插件同步与可发布集合的回归检查
- `helpers/` - 共享的解析器与宿主桥接辅助工具

可选或较慢的公开套件：

- `antigravity/`
- `claude-code/`
- `skill-triggering/`
- `explicit-skill-requests/`
- `subagent-driven-dev/`

这些套件可能需要本地宿主配置，除非发布检查清单另有说明，否则不应把它们当作默认的最低验证路径。

## 本地开发测试

把私有或仅开发用的测试用例放在 `tests/local/`，它们在本机有用，但不该进入公开仓库。`tests/local/` 下的一切除其 README 外都被 git 忽略。

仅限本地的测试用例不得成为公开 CI、发布检查、README 命令或当前权威文档的依赖。如果一个本地测试变得普遍有用且可复现，就把它移出 `tests/local/` 到相应的公开套件，并记录它的入口。
