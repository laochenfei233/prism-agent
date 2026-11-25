---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-05-cron-message-source

[English](2026-11-05-cron-message-source.md) | 中文

## 概述

cron 任务的投递消息携带自己的消息来源变体，读者可以据此把定时投递与人工输入、Schedule 提醒区分开。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-05-cron-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-19-cua-input-notices"
    after: "d3dcdc21130c63631548151bc26929a3f05a7ca29cc957f1eea8da1cfe2d0868"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-19-cua-input-notices"
    after: "1e42757fe16ef9e2dd45ec328710e337ec8d6c4791304a048d2c9a374e8c4755"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-19-cua-input-notices"
    after: "04229f2fff9e243d02092dc26aa27924a4f126f66b5f90cfdd8374f9c7f76090"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-19-cua-input-notices"
    after: "3e61772c5b1261ba3e69f5ee569feccb13f5d90aa70fbdbf24869a3ac140d0c9"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

MessageSourceMap 经声明合并保持可扩展，持久化读者从不穷举 source kind：会话投影落在有文档记录的 default 分支上，按持久化 kind 保持未知生产者可见（packages/client/ui-chat/src/client/conversation-nodes/event-projection.ts 与 ui-trajectory 投影同构）。旧读者回放带 source kind "cron" 的日志时会正常渲染该行而不是失败；新读者回放旧日志不受影响，因为该变体只是缺席。session/title-llm-request 的 messages 联合变大仅因 cron 来源的用户消息可以进入请求；消费方按消息内容转发，与生产者 kind 无关。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/client/ui-chat/tests/event-projection.client.spec.ts packages/client/ui-chat/tests/chat-node-source.client.spec.ts——12 个测试通过，含覆盖 default 分支的插件生产者用例。

<a id="dev-note"></a>
## 开发备注

无。
