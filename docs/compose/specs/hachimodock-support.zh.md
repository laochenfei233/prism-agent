---
feature: hachimodock-support
status: delivered
updated: 2026-11-12
branch: feat/hachimodock-support
commits: b898399b3c..2ce3993e0f
---

# HachimoDock 桥接支持：设备状态、审批中继、语音与对话切换

[English](hachimodock-support.md) | 中文

## Report

**交付内容** — `plugins/prism-hachimodock`（@prism/prism-hachimodock），HachimoDock DSH 桥接协议 v2（上游 main `361cb0e`）的 TS/ESM 移植：带 relay/bus/voice 三种 token 角色的 loopback HTTP/SSE 服务、以仅属主权限写到 `~/.claw-pet/prism-bridge/capability.json` 的 capability descriptor v2、紧凑会话摘要与有界事件流、终局 `approval/request` 应答器（认领一次、仅认领前委托）、`/inject` 准入流、以及保持上游 fail-closed 语义的语音端点（prism 不随附浏览器 InputActions 消费者；设备语音走 OS composer 适配器）。在移植之上是新的会话切换能力：`POST /sessions/activate`（bus token）校验活跃会话后经 `GET /api/hachimodock/activation` 扇出给同源 web 客户端；客户端半边经 `uiWorkspace.openSession` 切换列表内会话、不重放、不抢焦点。配置是 patch 行上的 schemastery schema（默认空闲端口并记录进 descriptor；`approvalFallback: delegate`）。

**验证** — `tsc -p tsconfig.json --noEmit` 退出码 0；`tsdown` 产出 `lib/index.js` + `lib/client.js`；vitest 10 文件 / 101 测试通过，含移植的上游套件（approval、events、security、health-sessions、inject+interrupt、语音 fail-closed、windows-acl、package 不变量）与新增的 activation、构建产物 client 套件。`verify-translation-pairing` 已记录 README 三件套。一轮评审（REQUEST_CHANGES：中继自撤销属 HachimoDock 侧；hub keep-alive 泄漏；禁用断言清理；一个会启动真实服务并写真实 descriptor 的 apply 测试）——全部修复并从干净 HEAD `2ce3993e0f` 重验；评审结论 PASS-with-minors。

**Journey log** —
- 上游移植不能砍掉"旧版"语音端点：HachimoDock 的 Rust 调用方（`dsh_desktop.rs`、`dsh_approval.rs`）仍在打 `/voice/status`、`/pair/ticket`、`/approval/decision`、`/relay/close`，协议面没有子集可选；真正无用的只有浏览器 InputActions 消费者。
- `Number.isSafeInteger` 不会窄化 `unknown`——先绑到常量再做 `typeof` 判断；`exactOptionalPropertyTypes` 还要求所有可能收到显式 undefined 的可选字段写成 `prop?: T | undefined`。
- schemastery 字段天然 optional-at-input，没有 `.optional()`（`Schema<number>` 上不存在）；gateway 模式（`z<Config>` + 每字段 `.default()`、接口字段可选）类型最顺。
- out-of-tree 插件的 typecheck 必须把 `@deepseek-ai/cordis` 指向构建好的 `vendor/cordis/lib/types`——tsconfig.base 的 paths 会把 vendor 源码拉进程序并在插件 flags 下报错（master 上 prism-pocket 自己的 tsc 也是这么红的）。
- "执行已记录 effect" 的 vitest 替身必须限定哪些 effect 会执行：执行 bridge effect 会启动真实服务并在插件 cwd 铸造真实 descriptor 凭据。

## [S1] 问题

HachimoDock（面向 AI Agent 的桌面宠物终端，ESP32-P4 设备 + Tauri 桌面管理端）通过一个 loopback 桥接插件适配 DeepSeek Harness，但它的安装器只写 `~/.dsh/profiles/desktop`。Prism 使用 `~/.prism` 隔离，该安装器在这里永远不会生效——prism 用户拿不到设备状态跟随、审批中继和语音目标。另外上游文档写明：设备上选择会话气泡不会切换 DeepSeek 的桌面对话；而 prism 具备原生能力（`uiWorkspace.openSession`）可以让切换真正生效。

## [S2] 设计

### S2.1 新插件 `@prism/prism-hachimodock`

`plugins/prism-hachimodock`（在 pnpm workspace 之外，与其他 `plugins/*` 一致）：上游 `integrations/dsh-hachimodock` 协议 v2 的 TS/ESM 移植，锚定 HachimoDock `main` `361cb0e`。它提供 loopback HTTP+SSE API，三个 Bearer token 角色（`relay`、`bus`、`voice`），并把 capability descriptor v2（64 位十六进制 `epoch`、三个 64 位十六进制 token、`http://127.0.0.1:<port>/` baseUrl）写到 `~/.claw-pet/prism-bridge/capability.json`——独立目录，DeepSeek 桥与 prism 桥可以共存。descriptor 与目录保持仅属主可读（POSIX 0700/0600；Windows 用移植的 `windows-acl.ps1` 语义保护 DACL）。

端点、载荷结构与协议字符串与上游完全一致（sessions 载荷 `version: 2`；语音协议 `hachimodock-scoped-input-v1`）：`GET /health`、`GET /sessions`、`GET /events`（SSE）、`GET /inject`（SSE）、`POST /interrupt`、`POST /pair`、`POST /pair/ticket`、`POST /approval/decision`、`GET /voice/status`、`POST /voice/begin`、`POST /voice/draft`、`POST /voice/submit`、`POST /voice/ack`、`POST /relay/close`，外加新的 `POST /sessions/activate`（S2.5）。传输边界照搬：严格 JSON 对象 ≤64KiB 且拒绝原型链键、仅 loopback 绑定并精确校验 Host/peer、SSE 有界订阅队列（128KiB 断开、8 流上限）、approval 挂起 ≤16 且终态回执 ≤256、voice 挂起 ≤64 且 120s 生命周期、epoch 绑定的游标与 512 事件环、旧的 approval/voice 命令永不重放。

### S2.2 配置

patch 入口上的 schemastery `Config`，加载期 fail-loud：`port?: number`（固定 loopback 端口；默认启动时绑定空闲端口并记录进 descriptor）、`approvalTimeoutMs: number = 30000`、`approvalFallback: 'delegate' = 'delegate'`（应答器只在认领前、且无已认证 USB 中继时经 `next()` 委托）、`descriptorPath?: string`（测试用）。

### S2.3 宿主接线

`cordis.patch.yml` 以 `inject: [webStartup]` 插入插件。插件消费宿主 `sessions`、`agents`、`sessionController`（与上游一样鸭子类型），只在中继已挂接时对 `approval/request` 瀑布做终局应答。会话摘要与事件流按上游相同方式从活跃会话构建。

### S2.4 语音

语音端点按上游的 fail-closed 语义移植。浏览器 InputActions 消费者保持缺位——客户端模块只注册激活面（S2.5），与上游桌面管理端一致：设备语音输入走 OS composer 适配器，`allowedOrigins` 保持为空。

### S2.5 会话切换（新能力）

`POST /sessions/activate {sessionId}`（bus token，仅 loopback）校验 id 对应活跃会话，然后经同源已认证路由 `GET /api/hachimodock/activation`（通过 `connection.fetch.register` 注册；webserver 对 `text/event-stream` 免压缩直通）广播 `{ type: 'session-activated', sessionId, at }`。客户端半边（`dsh.client.platform: web`）用已认证 fetch 流订阅，丢弃客户端会话列表中不存在的 id，并调用 `ctx.uiWorkspace.openSession(sessionId)`。激活是 UI 命令：订阅者只收实时事件、不重放，且从不抢占 prism 窗口焦点——选择只就地切换会话。

### S2.6 打包与文档

`tsdown` 按 `plugins/*` 惯例产出 `lib/index.js` + `lib/client.js`（`bundle-runtime.mjs` 把构建好的插件拷进桌面运行时；`ensure_local_bundles` 安装并追加 bundle 名）。README 三件套加本 spec。

## [S3] 范围

- 范围内：插件移植（与锚定上游修订版协议对齐）、prism capability descriptor、激活推送路由与客户端模块、patch 接线、测试、README。
- 范围外：HachimoDock 桌面端改动（该仓库的独立 feature）、向 prism profile 的 managed-install、浏览器语音配对 UI、ASR/LLM 服务、`packages/*` 下的改动。

## Tasks

- [x] T1: 搭建 `plugins/prism-hachimodock`（package.json、cordis.patch.yml、tsdown、tsconfig、vitest）（依赖：无）
- [x] T2: capability descriptor 存取 + Windows ACL 移植（依赖：T1）（覆盖：S2.1）
- [x] T3: loopback HTTP+SSE 服务、token 认证与传输边界（依赖：T1）（覆盖：S2.1）
- [x] T4: bridge 胶水——会话摘要、事件流、审批应答、inject/interrupt、语音端点（依赖：T3）（覆盖：S2.3、S2.4）
- [x] T5: 激活推送路由 + 客户端模块（依赖：T3）（覆盖：S2.5）
- [x] T6: 上游协议测试的 vitest 移植 + 激活测试（依赖：T2、T4、T5）（覆盖：S2.1–S2.5）
- [x] T7: README 三件套（依赖：T6）（覆盖：S2.6）

## [S4] 验收

- [ ] descriptor v2 以仅属主权限写到配置路径；带 bus token 的 `GET /sessions` 返回活跃会话的 `version: 2` 载荷。
- [ ] `approval/request` 在中继挂接时被终局应答；没有中继时瀑布经 `next()` 委托。
- [ ] `GET /inject` 经 `sessionController.prompt` 流式返回 SSE 准入回执（`done/stopReason: admitted`）；`POST /interrupt` 调用 `sessionController.cancel`。
- [ ] 未知会话 id 的 `POST /sessions/activate` 被拒绝；活跃 id 能到达已连接的同源订阅者，客户端模块对列表内会话调用 `uiWorkspace.openSession`、对未知 id 忽略。
- [ ] 认证与边界：缺 token/错 token → 401；非 loopback 绑定或 Host → 拒绝；>64KiB 或原型链键 JSON → 拒绝。
- [ ] 上游测试套件移植版（approval、events、health-sessions、inject、interrupt、security、voice、windows-acl）以 vitest 等价物通过；`pnpm run typecheck` 干净；插件 `build` 产出 `lib/`。
