# Aegis E2E Bootstrap

[English](README.md) | 中文

本目录承载 Aegis fork 的 Phase 5 E2E 验证套件。

当前状态：

- `Phase 5 E2E verification slice` 已在批准范围内完成
- `layer1-fast-check.sh` 现在可以运行，且默认使用 fast 宿主 profile
- `layer2-behavior-check.sh` 现在可以运行，具备 fixture 支撑的 transcript 分析与使用/不使用 Aegis 的对比
- `layer3-scenario-check.sh` 现在可以运行，具备 fixture 支撑的场景编排与跨宿主对比
- 场景定义、产物 fixture 与 transcript fixture 作为建议性验证输入存在，而不是最终权威

当前的公开基线：

- `docs/current/README.md`
- `docs/current/AEGIS_RUNTIME_READY_BOUNDARY.md`
- `docs/current/AEGIS_ARTIFACT_SCHEMA_BASELINE.md`

Bootstrap 入口：

- `run-all.sh`
- `layer1-fast-check.sh`
- `layer2-behavior-check.sh`
- `boundary-compliance-check.sh`
- `artifact-schema-check.sh`
- `aegis-workspace-check.sh`
- `aegis-doctor-check.sh`
- `workspace-helper-wiring-check.sh`
- `workspace-helper-resolution-check.sh`
- `project-bootstrap-policy-check.sh`
- `trigger-health-check.sh`
- `context-semantic-infrastructure-check.sh`
- `context-semantic-infrastructure-live-check.sh`
- `workflow-quality-check.sh`
- `agentic-benchmark-check.sh`
- `controlled-replay-check.sh`
- `live-replay-capture-check.sh`
- `live-replay-capture.sh`
- `host-instruction-invariants-check.sh`
- `bootstrap-adapter-contract-check.sh`
- `deferred-ledger-check.sh`
- `minimality-reference-check.sh`
- `host-adapter-smoke-check.sh`
- `goal-framing-check.sh`
- `first-principles-review-check.sh`
- `long-task-continuation-check.sh`
- `grok-build-host-boundary-check.sh`
- `analyze-transcript.sh`

Layer 1 宿主 profile：

- `fast`（默认）：代表性的 Codex 自然语句 + 显式 smoke、OpenCode 基础套件、插件同步
- `matrix`：完整的 Codex 矩阵，外加 OpenCode 基础套件与插件同步
- `none`：仅静态边界 + schema 检查

支撑用的 bootstrap 资产：

- `fixtures/artifacts/`
- `fixtures/replay-projects/`
- `fixtures/transcripts/`
- `replay-samples/`
- `scenarios/`
- `scenarios/scenario-D-interrupted-long-task/`
- `baselines/without-aegis/`
- `prompts/`

工作区 helper 覆盖范围：

- `aegis-workspace-check.sh` 用临时目标项目验证 `scripts/aegis-workspace.py`。
- `aegis-doctor-check.sh` 通过临时目标项目验证完整安装的就绪状态：关键 skills、method-pack 根目录与项目工作区支持。
- `project-bootstrap-policy-check.sh` 验证流程基线与各 skills 中的 Project Baseline Bootstrap、Spec Brief、Workspace Shell、Task Work Record 以及惰性工作区措辞。
- `trigger-health-check.sh` 验证触发链路诊断基线，以及在 Aegis 已安装但预期 skill 无法可靠触发时使用的代表性正/负触发健康矩阵。
- `context-semantic-infrastructure-check.sh` 以确定性方式验证语义上下文的 owner、被动/主动消费方边界、生命周期/安全矩阵、自托管词汇表、遗留兼容性以及权威不漂移的约定。它不声称宿主模型执行了这些状态变更。
- `context-semantic-infrastructure-live-check.sh` 是一个需显式开启、面向有状态宿主行为的临时项目 runner。它对待测 skill 源码取指纹，并让检出内显式证据与原生安装路由证据保持区分。
- `workflow-quality-check.sh` 验证工作流质量基线、紧凑的输出约定，以及针对 fast path 低成本、证据新鲜度、产物稳定度与工作区惰性的代表性样例。
- `agentic-benchmark-check.sh` 验证 benchmark 设计 fixture，涵盖使用/不使用 Aegis 的场景覆盖、隔离控制、指标边界以及不越权的声明。
- `controlled-replay-check.sh` 验证可用于 benchmark 的受控回放样例：把预置 fixture 项目复制到按 arm 划分的临时工作区，通过 `analyze-transcript.sh` 分析捕获的 transcript，并检查使用/不使用 Aegis 的对比，全程不使用本地用户项目或实时宿主执行。
- `live-replay-capture-check.sh` 空跑实时回放捕获入口，使 Layer 1 能在不调用宿主模型的情况下验证工作区准备、显式开启以及没有伪造的无 Aegis 基线。
- `live-replay-capture.sh` 是一个依赖环境、需显式开启的 runner，用于从受控回放样例中捕获一个实时的 `aegis-auto` arm。它要求 `AEGIS_LIVE_REPLAY=1`，只写入仓库本地的 `.tmp/`，为 `analyze-transcript.sh` 规范化原始宿主日志，并且不授予 benchmark 或完成权威。
- `host-instruction-invariants-check.sh` 验证手工复制的全局规则投影与薄宿主指令适配器保持激活、优先级、证据、权威、投影预算，以及 Lite-base / Advanced-overlay 的角色划分，并且不做逐字节的复制检查。
- `bootstrap-adapter-contract-check.sh` 验证 bootstrap 适配器引用规范的 `using-aegis` 热路径或宿主原生引用，同时把宿主专属的激活、TDD mode、JSON、发现、警告与工具映射逻辑留在可移植的方法体之外。
- `deferred-ledger-check.sh` 验证延期标记约定、解析器，以及对当前仓库中格式错误的保留跟进 / 退役条目的扫描。
- `minimality-reference-check.sh` 验证 Aegis 专属的参考：在新增 skills、产物、适配器、fallback 或 benchmark 指标之前先检查。
- `host-adapter-smoke-check.sh` 解析核心宿主 manifest 与 hook 配置，检查版本对齐、预期路径、资产以及不落地实时工作区的边界。
- `tests/kimi-code/run-tests.sh` 是确定性的 Kimi Code 入口，用于元数据、manifest、doctor profile、重复暴露与宿主边界检查。它的 `--integration` 模式与 `run-live-smoke.sh` 依赖环境，当 CLI、登录、提供方或信任前提缺失时，不得把它们表示为通过。
- `goal-framing-check.sh` 验证需显式开启的 goal-framing 入口、可选的 `TaskIntentDraft` 目标字段、SubagentContextPacket 的形态以及默认不写文件的策略。
- `first-principles-review-check.sh` 验证 first-principles review 作为一个轻量的组合式 skill 可用，且不进入始终加载的热路径，也不声称权威。
- `grok-build-host-boundary-check.sh` 验证 Grok Build 原生的 direct-child 发现默认值、显式的 config 备选方案、重复暴露防护、更新器注册与结构性支持措辞。
- `deepseek-harness-host-boundary-check.sh` 验证官方 DeepSeek Harness 身份、原生 DSH bundle manifest/适配器、包自有的 skill 暴露、显式的 direct-child 兼容路径、重复暴露防护以及 developer-preview 支持边界，且不与 DeepSeek-TUI 混为一谈。当本地存在 `dsh` 与 `pnpm` 时，`tests/deepseek-harness/run-tests.sh --integration` 会追加一次隔离的 profile 安装/加载/移除 smoke。
- Aegis method-pack 仓库不得交付一个实时的 `docs/aegis/` 工作区。helper 只在调用方传入的目标项目根目录中初始化并检查该工作区。
- helper 从结构上验证可识别的 JSON 伴随产物，但不评判证据是否充分，也不授予完成权威。
- helper 可以创建由 helper 支撑的任务生命周期记录，并为评审或交接组装一份结构性的证明 bundle。该 bundle 仍然只是建议性的 method-pack 证据，不是最终门禁。
- helper 还可以创建、修订和取代目标项目的 `docs/aegis/adr/` 记录，同时把 ADR 编号、取代标记与 `INDEX.md` 覆盖范围保持在同一个仅限目标项目的边界内。
- `workspace-helper-wiring-check.sh` 验证写入 `docs/aegis/` 记录的 skills 会经由共享 helper 路由，或运行 helper 检查。
- `workspace-helper-resolution-check.sh` 验证工作流从已安装 method-pack 的支持路径解析 helper，并用 `--root` 单独传入目标项目。
- `long-task-continuation-check.sh` 验证长任务记录经由工作区 helper 纪律路由。
