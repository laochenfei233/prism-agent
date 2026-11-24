---
kind: upgrade-guide
description: "prism-memory 的模型辅助沉淀现在按来源信任档录取候选，assistedDistillConfidence 配置键已移除。"
---

# prism-memory 模型读取的主张遵循来源信任档

[English](guide.md) | 中文

## 变更

在 v0.2.2-rc.1 及之前，模型辅助沉淀的候选一律以 `assistedDistillConfidence`（默认 `0.5`）写成 `pending`，无论它依据的那句话是谁说的，因此每条模型读取的主张都要在待审收件箱里等。现在候选与句式蒸馏器的主张走同一套信任档位，按它所引用消息的说话人分级：依据用户本人消息的候选以 `autoDistillUserConfidence`（默认 `0.7`）写入，在出厂默认下可以直接落 `active`；依据助手陈述的候选以 `autoDistillConfidence`（默认 `0.4`）写入，挂起直到写入路径或整合巡检印证它。配置键 `assistedDistillConfidence` 已移除。设置过该键的部署，以及依赖「每条模型读取的主张都先等审」的部署，会受影响。

## 迁移

1. 在部署的 `cordis.yml`、patch 或 overlay 里，删除 prism-memory 配置下的 `assistedDistillConfidence` 一行；插件不再读取它。
2. 如果模型读取的主张必须继续等待人工审批，在同一配置行里设 `autoDistillStatus: pending` —— 这会把包括本通道在内的所有自动生产线收回先审后入。
3. 重启并打开记忆页：升级后窗口写入的主张会带上档位证据注记，待审收件箱里只列出分级策略挂起的主张。
