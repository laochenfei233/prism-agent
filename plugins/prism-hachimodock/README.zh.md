# @prism/prism-hachimodock

[English](README.md) | 中文

Prism 的 HachimoDock 桥接：桌面宠物终端跟随 prism 会话、在设备上应答审批、定位语音输入，并切换设备选中的会话。

一个 patch 插件，移植自 HachimoDock 的 `integrations/dsh-hachimodock` 协议 v2（HachimoDock main `361cb0e`）。一条供 HachimoDock 桌面管理端访问的 loopback HTTP/SSE 通道；对 web 应用零改动。

## Features

- **会话状态跟随**：紧凑摘要（`GET /sessions`）与紧凑事件流（`GET /events`）——回合边界、工具调用/结果对、标题更新与审批审计边缘。会话正文绝不离开宿主。
- **审批中继**：唯一的终局 `approval/request` 应答器。被认领的请求由精确的中继租约（epoch + 连接 + 会话）持有；超时、中止或断开一律 fail closed。配置 `approvalFallback: delegate` 时，无中继挂接的请求委托给常驻审批 UI。
- **语音目标**：`/voice/status` 报告 scoped-input 契约（`hachimodock-scoped-input-v1`）并拒绝猜测编辑器。浏览器 InputActions 消费者有意缺位——prism 的设备语音输入走 HachimoDock 的 OS composer 适配器，`allowedOrigins` 保持为空。
- **会话切换**（prism 新增）：`POST /sessions/activate`（bus token）校验活跃会话后，经同源已认证的 `GET /api/hachimodock/activation` 流扇出给 web 客户端；客户端半边对列表内会话调用 `uiWorkspace.openSession`，未知 id 一律忽略。只发实时事件、不重放、不抢窗口焦点。
- **Capability descriptor v2**：桥接铸造 epoch 与三个 token 角色（`relay`、`bus`、`voice`），并以仅属主权限写入（POSIX 0700/0600；Windows 经字节一致的 `windows-acl.ps1` 保护 DACL）到 `~/.claw-pet/prism-bridge/capability.json`——独立目录，DeepSeek 桥与本桥可共存。descriptor 是唯一凭据通道；绝不出现在 URL、日志或应用资源里。

## Install

桌面运行时会把 `plugins/*` 拷入 profile 并追加 bundle 名（`bundle-runtime.mjs` + `ensure_local_bundles`）；prism 桌面安装无需手工接线。打包或让开发 profile 指向本插件前先构建：

```sh
pnpm exec tsdown --config tsdown.config.ts
```

HachimoDock 桌面管理端通过读取 capability descriptor 发现本桥；不存在也不需要向 prism profile 的 managed install。

## Configuration (cordis.patch.yml)

- `port` — 固定 loopback 端口；默认启动时绑定空闲端口并记录进 descriptor。
- `approvalTimeoutMs` — 审批 fail closed 前的等待（默认 30000；`99999` 为永不哨兵）。
- `approvalFallback` — `'delegate'`（默认）把无法应答的请求交给下一个应答器；`'unavailable'` 直接 fail closed。
- `injectTimeoutMs` — 提示准入截止，超时报 `inject-timeout`（默认 600000）。
- `allowedOrigins` — 允许配对的精确浏览器 Origin；为空即禁用浏览器语音。
- `descriptorPath` — capability descriptor 覆盖（测试用）。

审批等待还可以不经 profile 重建在线调整：共享的 HachimoDock 桥接 profile（`~/.claw-pet/pet-bridge.json`，键 `dshApprovalTimeoutMs`，或环境变量 `HACHIMODOCK_PRISM_APPROVAL_TIMEOUT_MS`）；`0` 表示永久等待。缺省或非法值回落到 `approvalTimeoutMs`。

## Notes and limits

- 传输边界照搬上游契约：严格 JSON 对象 ≤64KiB 且拒绝原型链键、仅 loopback 绑定并精确校验 Host、有界 SSE 队列与重放环、epoch 绑定的游标、旧的审批/语音命令永不重放。
- 线契约锚定上游 main `361cb0e`：端点、载荷结构与协议字符串（`version: 2`、`hachimodock-scoped-input-v1`、`live-session-seq-turn-call-v1`）逐字节一致，仅缺 prism 不随附的旧版浏览器 InputActions 消费者。
