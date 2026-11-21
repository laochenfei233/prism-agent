# Agent Note: Prism-owned package scope

Status: implemented

[English](2026-09-26-prism-owned-package-scope.md) | 中文

## Problem

Prism 需要构建在 DeepSeek Harness 之上的产品能力，同时不能把这些能力伪装成上游 DSH 包。复用 `@deepseek-ai/dsh-*` 命名空间会模糊发布归属，迫使 Prism 发布跟随 DSH 版本序列，也会让后续上游同步更难区分。

第一个这类能力是会议纪要。它组合了 Host 服务、持久存储、配置化模型调用、语音导入和面向模型的工具，因此所有权规则必须支持真实的多入口插件，而不只是库包。

## Decision

Prism 所属包位于 `packages/prism/<package>`，使用 `@prism-ai/` npm 作用域。其 repository 元数据指向 `git+https://github.com/laochenfei233/prism-agent-e.git` 和包自身目录，而不是上游 DeepSeek Harness 仓库。

`@prism-ai/prism-meeting` 是这条规则下的第一个包。它位于 `packages/prism/prism-meeting`，根入口导出会议服务，`./tools` 导出面向模型的插件。基础 bundle 把两个入口注册在所消费 DSH 服务旁边。

Workspace 工具把两个包作用域都识别为第一方源码：

- `check-workspace-constraints` 接受 `@prism-ai/` release member 的 Prism repository URL，同时继续对 `@deepseek-ai/dsh-*` 应用 DSH 专属的版本、Cordis peer 和发布载荷规则。
- `collectPackageGraph` 包含 `@prism-ai/` 包，并为两个已识别作用域去除前缀后生成图节点简称。
- `tsconfig.base.json` 为 Prism 维护显式路径别名，因为生成别名只覆盖 DSH 作用域。

上游 DSH 包保留其名称、版本、repository 元数据和发布族。Prism 不会因为组合使用而上游包而重命名它们。

## Alternatives considered

**保留 `@deepseek-ai/dsh-meeting-minutes` 和 `@deepseek-ai/dsh-tool-meeting-minutes`。** 这保留了原包拆分，但把 Prism 所属行为占用了上游命名空间，把功能绑定到 DSH 发布序列，并使未来同步无法区分上游复制代码与 Prism 新增内容。

**使用 `@prism-ai/prism-meeting-service` 和 `@prism-ai/prism-meeting-tools`。** 两个包能保留独立依赖面，但服务和工具拥有同一部署生命周期，也没有独立版本化需求。根服务加 `./tools` 导出保持单一包身份和单一 repository 目录。

**继续放在 `packages/meetings/`。** 该路径描述能力，但不描述所有者。`packages/prism/` 让所有权可审查，并为未来 Prism 包提供统一位置，而无需改变上游分组分类。

## Consequences

Prism 可以添加产品专属包，而不会占用 DSH 包名或改变上游包版本。导入和文档工具现在识别第二个作用域，因此未来修改包发现逻辑时必须覆盖两个作用域。

Prism 包不属于 `dsh` 发布族。通过 npm 发布它们需要明确的 Prism 发布流程或直接发布包；本次变更建立包身份与 repository 所有权，不建立自动发布通道。
