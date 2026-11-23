---
kind: upgrade-guide
description: "prism-memory 现在把蒸馏与导入的 claim 自动存为 active、印证后自动转正 pending、按新旧自动裁决矛盾，并可用模型调用逐回合读取；先审后收的行为改为显式配置。"
---

# prism-memory 默认值从先审后收翻转为自动驾驶

[English](guide.md) | 中文

## 变更

在 v0.2.1-rc.4 及之前，`prism-memory` 把自动生产线写下的每条 claim——从回合蒸馏的、从其他工具导入的、以及生成的主题摘要——全部写成 `pending`，由人通过 `/memory review` 或记忆页逐条批准。矛盾只报告不裁决，卫生整理（`/memory maintain`）只能由操作者手动运行。

现在出厂默认即自动驾驶：

- 从用户本人消息蒸馏的 claim 以 `autoDistillUserConfidence`（新增，默认 `0.7`）写入，高于预审线 `pendingBelowConfidence`（`0.5`），直接落为 `active` 并参与注入；从助手陈述蒸馏的仍以 `autoDistillConfidence`（`0.4`）写入并保持 `pending`。`autoDistillStatus` 与 `importStatus` 默认翻转为 `active`，主题摘要跟随新增的 `dreamDigestStatus`（默认 `active`）进入关键词召回。
- `pending` claim 被以 active confidence 重述时由写入路径就地转正；被另一会话印证时由整合 pass（`dream`）转正——印证即审批。
- `dream` apply 时按新旧自动裁决矛盾（新增 `dreamAutoResolveConflicts`，默认开）：较新的 claim 取代较旧的；裁错可用 `/memory restore` 回滚。随后自动执行卫生整理（新增 `dreamAutoMaintain`）。
- 新增可选的模型读取提炼（`llmDistill`，插件默认关，由本 bundle 的 `cordis.patch.yml` 开启）：每回合一次辅助模型调用，读取正则认不出的 claim。开启而上下文没有 llm 服务时插件装载即失败。

所有运行 prism-memory 的部署升级后都会看到新的准入行为；除上述 pass 外不重写任何已存记录，且升级前的 `pending` 存量中来自导入与本人话语层（`user`、`rule`）的记录会在首次装载（未开 `requireApproval`）时转正。

## 迁移

1. 采用自动驾驶无需任何操作。
2. 保持先审后收：在 `prism-memory` 行（或更晚的 patch 层）设置 `autoDistillStatus: pending`、`importStatus: pending`、`dreamDigestStatus: pending`。`requireApproval: true` 仍然压住一切，包括印证转正与存量转正。
3. 关闭本 bundle 开启的模型读取提炼：在 `prism-memory` 行设置 `llmDistill: false`。
4. 保持矛盾由人裁决：设置 `dreamAutoResolveConflicts: false`；保持卫生整理手动运行：设置 `dreamAutoMaintain: false`。
5. 确认：`/memory status` 里 `pending` 只剩既非本人话语也非导入来源的 claim；`/memory dream apply` 会报告已裁决的矛盾与卫生摘要。
