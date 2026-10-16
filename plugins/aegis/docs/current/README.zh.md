# Aegis Current Docs

[English](README.md) | 中文

状态：`Approved`

## 1. 目的

本目录包含 `Aegis Method Pack` 的公开当前基线。

它有意保持精简。内部实现记录、迁移计划、私有 smoke 笔记、切换清单以及仅限本地的审计线索，都不属于这份公开的当前面。

## 2. 仓库边界

当前的仓库形态是：

> `Aegis Method Pack (runtime-ready)`

本仓库拥有：

- skills 与工作流纪律
- 可分发给宿主安装的 method-pack 分发
- runtime-ready 的草稿、提示与投影
- 用户与贡献者所需的公开文档

本仓库不拥有：

- authoritative runtime core
- authoritative `GateDecision`
- authoritative `PolicySnapshot`
- final `completion authority`

## 3. 权威顺序

公开文档相互冲突时，按以下顺序处理：

1. `AGENTS.md`
2. `docs/current/README.md`
3. `docs/adr/` 中已批准的 ADR
4. `docs/current/` 中与任务相关的文档
5. 宿主专属文档，例如 `docs/README.codex.md`,
   `docs/README.opencode.md`, `docs/README.claude-code.md`,
   `docs/README.cc-gui.md`, `docs/README.codebuddy.md`,
   `docs/README.deepseek-tui.md`,
   `docs/README.deepseek-harness.md`,
   `docs/README.trae.md`, `docs/README.copilot.md`,
   `docs/README.qoder.md`, `docs/README.kimi-code.md`,
   `docs/README.pi.md`,
   `docs/README.openclaw.md`, `docs/README.hermes-agent.md`,
   `docs/README.zcode.md`, `docs/README.grok-build.md`,
   `docs/README.omp.md`
6. 测试与 fixture

## 4. 公开当前基线

公开的当前集合是：

- `docs/current/AEGIS_TARGET_STATE.md`
- `docs/current/AEGIS_PRODUCT_BASELINE.md`
- `docs/current/AEGIS_PROCESS_BASELINE.md`
- `docs/current/AEGIS_COMPLEXITY_GOVERNANCE_BASELINE.md`
- `docs/current/AEGIS_FAST_TRACK_PLAYBOOK.md`
- `docs/current/AEGIS_FAST_TRACK_PLAYBOOK_ZH.md`
- `docs/current/AEGIS_WORKFLOW_GUIDE.md`
- `docs/current/AEGIS_WORKFLOW_GUIDE_ZH.md`
- `docs/current/AEGIS_ACTIVATION_MODE.md`
- `docs/current/AEGIS_TDD_MODE.md`
- `docs/current/AEGIS_PROMPT_HYGIENE_AND_INJECTION_BOUNDARY.md`
- `docs/current/AEGIS_RULE_LAYERING.md`
- `docs/current/AEGIS_TRIGGER_HEALTH_BASELINE.md`
- `docs/current/AEGIS_WORKFLOW_QUALITY_BASELINE.md`
- `docs/current/AEGIS_AGENTIC_BENCHMARK_BASELINE.md`
- `docs/current/AEGIS_DEFERRED_LEDGER.md`
- `docs/current/AEGIS_MINIMALITY_REFERENCE.md`
- `docs/current/AEGIS_DUAL_TRACK_GOVERNANCE.md`
- `docs/current/AEGIS_ADR_AUTO_BACKFILL.md`
- `docs/current/AEGIS_ARTIFACT_SCHEMA_BASELINE.md`
- `docs/current/AEGIS_RUNTIME_READY_BOUNDARY.md`
- `docs/current/AEGIS_METHOD_PACK_RELEASE_CHECKLIST.md`
- `docs/current/AEGIS_HOST_COMPATIBILITY_MATRIX_SNAPSHOT.md`
- `docs/current/AEGIS_KNOWN_LIMITATIONS.md`
- `docs/adr/ADR-0001-aegis-method-pack-is-not-runtime-core.md`
- `docs/adr/ADR-0002-kimi-native-plugin-is-the-automatic-entry.md`
- `docs/adr/ADR-0003-current-branch-first-git-lifecycle.md`

## 5. 文档职责

`AEGIS_TARGET_STATE.md`：本仓库力求成为什么的单页摘要。

`AEGIS_PRODUCT_BASELINE.md`：产品边界、拥有的面和明确的非目标。

`AEGIS_PROCESS_BASELINE.md`：方法层的工作流基线、证据纪律，以及 `Design Defect` / `Implementation Drift` 等共享方法术语。

`AEGIS_COMPLEXITY_GOVERNANCE_BASELINE.md`：复杂度治理在源码、测试、计划/决策与流程产物上的共享当前基线。

`AEGIS_FAST_TRACK_PLAYBOOK.md`：面向用户的英文快速上手说明，涵盖自然入口语句、能力选择、模式控制、边界与延伸阅读。

`AEGIS_FAST_TRACK_PLAYBOOK_ZH.md`：面向用户的中文快速上手说明，涵盖自然入口语句、能力选择、模式控制、边界与延伸阅读。

`AEGIS_WORKFLOW_GUIDE.md`：面向用户与贡献者的英文工作流说明。它解释当前的 Aegis 工作流，且不新增 runtime authority。

`AEGIS_WORKFLOW_GUIDE_ZH.md`：面向用户与贡献者的中文工作流说明。它解释当前的 Aegis 工作流，且不新增 runtime authority。

`AEGIS_ACTIVATION_MODE.md`：`auto` 与 `explicit` 两种 activation mode 的语义。

`AEGIS_TDD_MODE.md`：`auto` 与 `off` 两种 TDD mode 的语义，用于自动的 test-first 路由。

`AEGIS_PROMPT_HYGIENE_AND_INJECTION_BOUNDARY.md`：有界上下文摄入、证据索引以及日志/输出卫生。

`AEGIS_RULE_LAYERING.md`：方法、宿主与仓库规则的层次划分。

`AEGIS_TRIGGER_HEALTH_BASELINE.md`：针对「已安装但没有可靠地调用正确 skill」的触发链路诊断，涵盖安装、发现、激活、路由、执行深度与误报这几层。

`AEGIS_WORKFLOW_QUALITY_BASELINE.md`：高频工作流的质量基线，涵盖紧凑的输出约定、代表性样例、fast path 的低成本、证据新鲜度、产物稳定度、工作区惰性与权威边界。

`AEGIS_AGENTIC_BENCHMARK_BASELINE.md`：在代表性 agentic 任务中衡量 Aegis 的公开基线，并且不会把 benchmark 输出变成 runtime authority 或泛化的节省声明。

`AEGIS_DEFERRED_LEDGER.md`：轻量的标记约定，用于可检索的延期跟进与退役工作。

`AEGIS_MINIMALITY_REFERENCE.md`：Aegis 专属的「添加之前先检查」参考，涵盖 skills、产物、适配器、fallback 与 benchmark 指标。

`AEGIS_DUAL_TRACK_GOVERNANCE.md`：修复轨道加退役轨道的治理。

`AEGIS_ADR_AUTO_BACKFILL.md`：完成时依据工作、计划、规格与验证证据回填 ADR，包含 ADR 与基线的同步规则。

`AEGIS_ARTIFACT_SCHEMA_BASELINE.md`：最小的 runtime-ready 产物形态。

`AEGIS_RUNTIME_READY_BOUNDARY.md`：method pack 可以输出什么，以及只有未来的 runtime core 才能决定什么。

`AEGIS_METHOD_PACK_RELEASE_CHECKLIST.md`：最低发布门禁与验证回读。

`AEGIS_HOST_COMPATIBILITY_MATRIX_SNAPSHOT.md`：当前的宿主兼容性快照与证据边界。

`AEGIS_KNOWN_LIMITATIONS.md`：当前的限制与保留的兼容边界。

## 6. 本地归档规则

`docs/archive/` 仅限本地，并被 git 忽略。

把它用于不应作为公开仓库一部分交付的实现历史、内部迁移记录、私有暂存笔记与旧的切换材料。

不要在公开 README 文件、宿主安装文档或发布说明中引用 `docs/archive/`。

## 7. 更新规则

当一次变更影响公开行为、宿主安装、发布门禁、runtime-ready 产物或 method-pack 与 runtime-core 的边界时，先更新最小范围内的相关当前文档，再改实现。

如果一份文档只作为流程证据有用，就不要把它放进 `docs/current`。
