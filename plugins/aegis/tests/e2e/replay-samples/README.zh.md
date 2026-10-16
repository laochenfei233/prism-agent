# 受控回放样例

[English](README.md) | 中文

本目录包含面向受控 agentic 回放样例的提示词与预期行为约定。

这些样例使用来自 `tests/e2e/fixtures/replay-projects/` 的小型 fixture 项目。它们默认是供已捕获 transcript 使用的回放输入。

实时宿主捕获通过 `tests/e2e/live-replay-capture.sh` 显式开启，并要求 `AEGIS_LIVE_REPLAY=1`。实时捕获路径目前只准备单个 `aegis-auto` arm；它不会伪造一个可信的不使用 Aegis 的基线。
