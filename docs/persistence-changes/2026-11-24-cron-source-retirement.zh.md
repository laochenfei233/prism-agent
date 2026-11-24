---
description: "记录一次持久化类型变迁及其兼容性确认。"
kind: persistence-change
---

# 2026-11-24-cron-source-retirement

[English](2026-11-24-cron-source-retirement.md) | 中文

## 概述

退役 Cron 调度相关包会移除一个 `MessageSource` 变体 `{ kind: "cron", jobId }`，因此承载 user 角色消息归属的四个 Session 事件根发生变化。曾记录过 Cron 投递的已提交会话保留该归属且仍可读取；没有其他持久化类型发生变化。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-24-cron-source-retirement
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-cron-message-source"
    after: "02e873a375eab467d83c4b26cc303a15bdf09dd15cbe8eb5dcffff6bccbb8715"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-cron-message-source"
    after: "485185a7f0b054d26ed1a617eb0ed65e12ea8e931949779270bbf0d630084130"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-cron-message-source"
    after: "431f7d2823dfc50f714ff5bddb8ee15f8db63505a151f59060ab796af0870ce0"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-cron-message-source"
    after: "89fa7972288b9fdee82649ab02260e52af977b22d03225e1c6a4aa9093aabe09"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读取方保留历史语义。已提交的 V4 记录按 `source` 的形态被接受，而不是按闭合的 kind 列表：[message-sources.ts](../../packages/session/session-format-v3-to-v4/src/message-sources.ts) 要求非空的产出方自有 `kind` 字符串，只拒绝已退役的 `plugin` 包装；[message.ts](../../packages/llm/llm/src/message.ts) 把 `MessageSource` 记录为可合并扩展，并写明「消费方跳过未知的 kind」。因此历史记录中的 `{ kind: "cron", jobId }` 会像任何其他无法识别的归属一样通过接受与渲染：消息来源只是描述性元数据，不是分发键，而这次移除既不新增必填字段，也不改动任何既有字段。

旧读取方行为不变，因为「缺失」并不是新数据：仍然声明 `cron` 变体的读取方只是在本次变更之后写入的记录里再也遇不到它，它认识的其他 kind 语义保持不变。不需要迁移、重建索引或截断，因此 Session 头部版本保持不变。

这次确认涉及的持久化后果仅限归属。`cron` storage domain 本身不是 Session 格式；其记录原样留在磁盘上且不再被读取，详见[升级指南](../upgrade-guide/v0.2.2-rc.1/cron-removal/guide.zh.md)。

<a id="verification"></a>
## 验证

`pnpm run gen-persistence-catalog` 重写了 catalog、中文对照件与 `docs/persistence-schema.json`；上面四个根摘要即为该输出。把 `docs/persistence-schema.json` 与已提交清册对比，显示恰好这四个根变化，没有新增根，也没有删除根。

`pnpm --silent run verify-persistence-changes` 在本检出中无法完成：已提交的伴随文件 `docs/persistence-changes/2026-11-05-cron-message-source.schema.json` 没有 `nodes` 表，历史装载器在到达本记录之前就失败。该缺陷早于本次变更；等那条记录的快照恢复后，本确认覆盖当前源码引起的全部根变化。

<a id="dev-note"></a>
## 开发备注

无。
