# Claude Code Skills 测试

[English](README.md) | 中文

使用 Claude Code CLI 对 Aegis skills 进行的自动化测试。

## 概述

这套测试验证 skills 是否被正确加载，以及 Claude 是否按预期遵循它们。测试以 headless 模式（`claude -p`）调用 Claude Code，并验证其行为。

## 环境要求

- 已安装 Claude Code CLI 且在 PATH 中（`claude --version` 应当可用）
- 已安装本地 Aegis 插件（安装方式见主 README）

## 运行测试

### 运行全部快速测试（推荐）：
```bash
./run-skill-tests.sh
```

### 运行集成测试（较慢，10-30 分钟）：
```bash
./run-skill-tests.sh --integration
```

### 运行指定测试：
```bash
./run-skill-tests.sh --test test-subagent-driven-development.sh
```

### 以 verbose 输出运行：
```bash
./run-skill-tests.sh --verbose
```

### 设置自定义超时：
```bash
./run-skill-tests.sh --timeout 1800  # 30 minutes for integration tests
```

## 测试结构

### test-helpers.sh
skills 测试的公共函数：
- `run_claude "prompt" [timeout]` - 用给定 prompt 运行 Claude
- `assert_contains output pattern name` - 验证模式存在
- `assert_not_contains output pattern name` - 验证模式不存在
- `assert_count output pattern count name` - 验证精确计数
- `assert_order output pattern_a pattern_b name` - 验证顺序
- `create_test_project` - 创建临时测试目录
- `create_test_plan project_dir` - 创建示例计划文件

### 测试文件

每个测试文件：
1. source `test-helpers.sh`
2. 用特定提示词运行 Claude Code
3. 用断言验证预期行为
4. 成功返回 0，失败返回非零

## 测试示例

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo "=== Test: My Skill ==="

# Ask Claude about the skill
output=$(run_claude "What does the my-skill skill do?" 30)

# Verify response
assert_contains "$output" "expected behavior" "Skill describes behavior"

echo "=== All tests passed ==="
```

## 当前的测试

### 快速测试（默认运行）

#### test-subagent-driven-development.sh
测试 skill 的内容与要求（约 2 分钟）：
- skill 的加载与可访问性
- 工作流顺序（先规格符合性，再代码质量）
- 自审要求已有文档记录
- 计划读取效率已有文档记录
- 规格符合性评审者的怀疑立场已有文档记录
- 评审循环已有文档记录
- 任务上下文提供方式已有文档记录

### 集成测试（使用 --integration 标志）

#### test-subagent-driven-development-integration.sh
完整工作流执行测试（约 10-30 分钟）：
- 创建一个带 Node.js 配置的真实测试项目
- 创建含 2 个任务的实施计划
- 用 subagent-driven-development 执行计划
- 验证实际行为：
  - 计划在开始时读取一次（而不是每个任务读一次）
  - subagent 提示词中提供完整任务文本
  - subagent 在汇报之前执行自审
  - 规格符合性评审发生在代码质量评审之前
  - 规格评审者独立阅读代码
  - 产出可工作的实现
  - 测试通过
  - 创建规范的 git 提交

**它测试什么：**
- 该工作流确实端到端可用
- 我们的改进确实被应用
- subagent 正确遵循该 skill
- 最终代码可用且经过测试

## 添加新测试

1. 创建新的测试文件：`test-<skill-name>.sh`
2. source test-helpers.sh
3. 用 `run_claude` 和断言编写测试
4. 加入 `run-skill-tests.sh` 中的测试列表
5. 赋予可执行权限：`chmod +x test-<skill-name>.sh`

## 超时注意事项

- 默认超时：每个测试 5 分钟
- Claude Code 可能需要一些时间才能响应
- 如有需要，用 `--timeout` 调整
- 测试应当保持聚焦，以避免长时间运行

## 调试失败的测试

使用 `--verbose` 时，你会看到完整的 Claude 输出：
```bash
./run-skill-tests.sh --verbose --test test-subagent-driven-development.sh
```

不使用 verbose 时，只有失败会输出内容。

## CI/CD 集成

在 CI 中运行：
```bash
# Run with explicit timeout for CI environments
./run-skill-tests.sh --timeout 900

# Exit code 0 = success, non-zero = failure
```

## 备注

- 测试验证 skill 的*指令*，而不是完整执行
- 完整工作流测试会非常慢
- 聚焦于验证关键的 skill 要求
- 测试应当是确定性的
- 避免测试实现细节
