# Agentic Benchmark Evidence

[English](README.md) | 中文

本目录只用于存放已经通过仓库离线校验和单独发布审批的脱敏、不可变的 Agentic Benchmark 结果快照。

`benchmarks/results/` 中只能包含公开安全的建议性 JSON 报告，以及由这些报告生成的 SVG 与双语文档投影。current matrix-v7 报告记录冻结批次与 profile 身份、宿主/模型版本、请求的模型与 reasoning effort、观测到的模型身份或显式的宿主事件不可用状态、33 案例组合与 22 案例 held-out 设计、全部 44 个 `standard-held-out` 或 132 个 `extended-held-out` 可观测结果、案例簇区间、无效尝试次数、profile 限制、复核状态以及不支持的声明。生成的 SVG 与双语 Markdown 投影必须来自同一份已校验的 JSON；其中展示的百分比、样本量、profile 名称、模型设置与限制都不得手工录入。

三份已提交的 v7 之前 JSON 快照保留它们原有的 30 案例、20 案例、40/120 次运行设计。它们只在渲染器精确的批次身份与规范报告哈希白名单下，用于仅验证、逐字节一致的投影检查；它们不是当前的 matrix-v7 证据，而新生成或经编辑、仍带遗留形态的报告会被拒绝。私有的 v7 之前报告需要先有单独版本化的 schema，才能被脱敏。

原始日志、提示词、工作区、宿主推理、凭据、auth/config 路径、会话标识、rollout 标识与机器本地路径只属于仓库本地的 `.tmp/` 证据，不得提交到这里。

这些快照是 benchmark 专属的建议性证据。它们不是 `GateDecision`，不是 `PolicySnapshot`，不是 runtime authority，不是普遍的 agent 质量声明，不是候选的自动晋级，也不是 final completion authority。中性或负面的完整结果可以发布；部分、受污染、经挑选或未解决证据不得作为有效快照呈现。

standard profile 每个案例只做一次观测，因此不支持重复运行证据。extended profile 有三组按案例聚类的重复，因此最多只支持有界的建议性重复运行证据；这些重复在统计上并不独立，也不能证明普遍质量、外部因果、候选晋级、runtime authority 或 completion authority。

## 已发布结果

最新发布的 extended-held-out（v7 之前）快照是 Aegis 2.7.6 的 `gpt-5.6-sol` / `xhigh` `extended-held-out` 对比：

- [脱敏报告](results/gpt-5-6-sol-xhigh-extended-20260811-v2-7-6.json)
- [确定性 SVG](results/gpt-5-6-sol-xhigh-extended-20260811-v2-7-6.svg)
- [English table](results/gpt-5-6-sol-xhigh-extended-20260811-v2-7-6.en.md)
- [中文表格](results/gpt-5-6-sol-xhigh-extended-20260811-v2-7-6.zh-CN.md)

它包含 20 个案例、每个 arm/案例组合三次重复的 120 个有效 held-out 结果，无效尝试为零。它的 6 个混合结果受试对象与 12 个无区分度案例在发布前经过了隐藏分组的技术复核；该复核没有改写任何冻结结果，也不是独立人工评审。

## 首份 matrix-v7 快照

第一份发布的 matrix-v7 快照是 Aegis 2.10.1（批次完成于 2026-09-13 UTC）的 `gpt-5.6-sol` / `xhigh` `standard-held-out` 对比：

- [脱敏报告](results/gpt-5-6-sol-xhigh-standard-20260913-v2-10-1.json)
- [确定性 SVG](results/gpt-5-6-sol-xhigh-standard-20260913-v2-10-1.svg)
- [English table](results/gpt-5-6-sol-xhigh-standard-20260913-v2-10-1.en.md)
- [中文表格](results/gpt-5-6-sol-xhigh-standard-20260913-v2-10-1.zh-CN.md)

它包含 22 个案例、每个 arm/案例组合一次观测的 44 个有效 held-out 结果，无效尝试为零。standard profile 不支持重复运行证据，因此这份快照仅为建议性，且不能与上文 extended-held-out 快照比较；它不会取代后者作为根 README 头条的地位。

贡献者在可见 arm 标签的情况下复核了它唯一的 `non-discriminating-arm-outcomes` 标记（14 个受试对象）。维护者把所提供的尝试台账与公开批次身份及全部 44 个计分结果比对，然后接受了贡献者对这份建议性快照的处理结论，而没有独立检查原始尝试输出。报告把这次复核标记为 `attested`；它不声称进行了隐藏分组复核或独立复核。冻结结果未被改动。

公开结果与冻结的案例角色显示，13 个受试对象是 `sentinel` 案例，两组都如回归防护所预期那样通过。剩下的 `long-task-preservation-boundary` 受试对象是一个 `discriminator` 案例，两组都失败了。贡献者报告说两次尝试都完成了迁移，并注意到进度消息中有一处错误继承的 handoff 声明，但两份最终回复都没有重述该更正。维护者没有依据原始输出独立验证这一解释；公开发布的约定通过值仍然是主要测量结果。

同一冻结构建上的第二批 `standard-held-out` 运行是作为建议性复制进行的。它仍未发布，其私有报告未经复核或脱敏，因此它不是仓库证据，也没有被并入上述任何图表。

## 测量状态

最新发布的 extended-held-out 快照覆盖 Aegis 2.7.6（2026-08-11）。它报告的约定通过率为 61.67% → 93.33%（+31.67 个百分点），不安全结果为 13.33% → 0%，通过率差值的 95% 案例簇区间为 +15.00 至 +50.00 个百分点。第一份 matrix-v7 standard-held-out 快照覆盖 Aegis 2.10.1（2026-09-13）。它报告的约定通过率为 59.09% → 95.45%（+36.36 个百分点），不安全结果为 9.09% → 0%，95% 案例簇区间为 +18.18 至 +54.55 个百分点，且每个案例只有一次观测。任何预测或中期数字都不会被当作证据呈现，来自较旧快照的数字也不构成较新版本的证据。
