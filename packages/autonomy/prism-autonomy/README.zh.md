---
description: "在 autonomous-guarded 权限预设下自动应答审批请求，同时让沙箱升级与拒绝栏杆保留人工控制。"
kind: "package-reference"
---
# Prism Autonomy

[English](README.md) | 中文

## 概述

`@prism/prism-autonomy` 实现权限预设的自主档。`autonomous-guarded` 预设（随 base bundle 的权限表发布，`workspace-write` + `ask`）触发本插件：此类会话中产生的每个审批请求都会经审批接缝自动应答为 `allowed-once`，不再到达客户端的审批卡片；命中"仍需人工"匹配器的请求除外——出厂默认是沙箱升级（`escalate sandbox to …`）。deny 栏杆不会产生 ask，因此命令守卫与 plan-mode 拒绝保持原样。每次自动应答都保留 `approval/asked` + `approval/decided` 审计对，在日志中与人工允许完全同形。

## 目录

- [使用本包](#use-this-package)
- [切换](#switching)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Host 侧是 `dsh-web-app` 里的一个 Loader 行（`prism-autonomy`），依赖 `sessionProjections`、`permissionPresets` 与 `agents`。配置有两项：`preset` 指定触发自主模式的权限预设（默认 `autonomous-guarded`；该名称必须存在于 permission-presets 目录，否则插件加载即失败），`requireHuman` 列出保留人工决定的匹配器（`tool`、`reasonPrefix`）。

会话当前预设从持久化的 `permission/preset` 事件折叠进 session projection（`autonomy`），因此派生状态在重载与重启后仍然成立。在其他任何预设下，应答器原样委托——默认会话行为与之前完全一致。`never` 审批策略对自主模式无效：审批服务会在任何应答器运行前直接拒绝，所以该预设刻意把 `workspace-write` 与 `ask` 配对。

<a id="switching"></a>
## 切换

切换走现有权限入口：`/permission autonomous-guarded` 命令或设置页的权限选择器。实时切入或切出触发预设时，插件恰好注入一条面向模型的用户消息（`prism-autonomy` source），告知模型审批现已自动放行——或恢复人工。重放与会话恢复不会重复注入通知；恢复的会话直接继续自动应答。

<a id="model-experience"></a>
## 模型体验

### 自主审批

#### What the model sees

在触发预设（`autonomous-guarded`）下，原本要等用户的请求会立即落定为已允许，工具结果与任何其他成功无异；命中"仍需人工"的请求（出厂默认：沙箱升级）仍走正常询问。唯一新增的模型可见输入是切换通知——一条用户消息，说明审批已自动放行（沙箱升级除外）且拒绝规则仍然生效。

#### Token effect

每次实时切入或切出预设注入一条通知消息。被自动应答的请求省去了人工拒绝时会产生拒绝加重试的工具文本。

#### KV Cache effect

切换通知像任何用户消息一样追加在保留历史之后；不改写提示前缀，自动应答也不改动任何缓存前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 切到自主预设的 ACP 托管会话同样会被自动应答；其 ACP 权限通道会被绕过。默认 off，需要显式切换才会发生。
- 审计对不区分自动应答与人工允许；独立的 autonomy 事件类型被延后。
- 无客户端 UI：模式走现有权限选择器与 `/permission`。
- 仅发布一档（`autonomous-guarded`）；更细的档位（仅编辑、完全 yolo）被延后。

<a id="dev-note"></a>
### 开发备注

应答器以 `prepend` 注册在 `approval/request` waterfall 上，位于远程客户端桥接之前，因此被自动应答的请求不会渲染卡片。单元测试覆盖阶梯、匹配器、响亮失败校验、实时通知与恢复；切换通知（模型可见）由 recorded-session 快照覆盖。
