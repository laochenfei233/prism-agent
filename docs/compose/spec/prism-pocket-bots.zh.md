---
feature: prism-pocket-bots
status: delivered
updated: 2026-11-03
branch: feat/pocket-bots
commits: ba06d2162f..9b11180d41
---

# Prism Pocket Bots

[English](prism-pocket-bots.md) | 中文

## Report

**构建内容** — `plugins/prism-pocket` 新增九个聊天 bot 渠道与重设计的口袋页。Node 半（`src/bots/`）每渠道一个适配器——Telegram（长轮询）、Discord（Gateway v10）、Slack（Socket Mode）、飞书/Lark 与钉钉与 QQ（流式 WebSocket 长连接，一次性 URL 每次拨号重新换取）、微信/企业微信/WhatsApp（webserver 上的平台签名回调路由，AES/HMAC 校验、应答握手、无凭据时 404）。supervisor 持有全部连接，按渠道串行启动并实时上报状态；每个 bot 绑定一个会话（`/new`、`/stop`、`/help` 命令，首条消息自动绑定）；助手回复按各平台限制分块回到聊天；待处理的审批和用户提问以编号选项送达聊天，回复即 resolve，120 秒沉默则交回应用自身界面。凭据持久化在 `pocket/bots.json`（0600），保存时服务端合并，绝不出现在路由响应里。浏览器半把页面铺在应用的设置材质上：本地生成的带 token 手机链接二维码、九张回显已存值的渠道凭据卡片，以及推送与 PWA 面板——全部文案走词典。页面样式表现在常驻每个表面（此前搭在移动适配的激活门上，桌面端一直渲染无样式裸 HTML）；只有适配样式保持激活门控。新增一个构建期根 devDependency `qrcode-generator`，内联进 client bundle。

**验证** — `tsc -p tsconfig.json --noEmit` 干净；`vitest run` 97/97（存储持久化与权限、配置合并与区域保持、supervisor 状态迁移、每渠道协议逻辑——帧、签名、微信家族 AES 往返、分块——问答转发 resolve 与超时、入站命令）；双面 tsdown 构建成功且 qrcode-generator 已内联；真实 web profile 冒烟走了一遍路由（`GET /api/pocket/bots` 列出九个脱敏渠道、config/start/stop 循环、未知渠道 400、无凭据回调 404），combo bundle 带二维码与渠道 UI，手机与桌面视口截图均人工检查；`verify-translation-pairing`、`verify-md-links`（2105 文件）与改动文档的 `verify-md-wrap` 通过。评审第 1 轮返回 REQUEST_CHANGES（四个 critical：部分保存往返断裂、飞书区域静默重置、转发层裸 send 撞上 fail-loud 策略、重连复用一次性 WS URL）；四项全部修复后，新评审人返回 COMMENT（可合并）并附两个一行跟进——Telegram 的 `is_bot` 字段名与 QQ 重连的 token 刷新——均已落在 9b11180d41。

**历程记录** — 「丑页面」有结构性根因：整张样式表搭在移动适配的激活门上，桌面设置页一直是无样式 HTML；样式表按生命周期拆分，而非按插件拆分。飞书长连接说 protobuf（`pbbp2.Frame`），不是 JSON——文档页是 JS 渲染拿不到，但 npm/PyPI registry 上的官方 SDK 包给出了确切协议；registry 包是本环境下国内平台协议的可靠来源。宿主的 fail-loud `unhandledRejection` 策略意味着观察者路径里的每个 `void promise()` 都要在注入点包一层捕获——问答转发的提示发送若不包，一次寻常的 Telegram 抖动就会让进程退出。脱敏凭据视图使服务端合并成为部分保存的唯一正确形态：客户端无法重发它从未收到的值，「留空保持已存值」必须由路由兑现。

## [S1] Problem

Pocket 设置区目前用一个可复制链接回答"手机能不能打开这里",但整页过于单薄:三个纯文本面板、没有二维码、也无法从聊天 App 进入工作区。上游的 `@xmanrui/dsh-im` 插件(dsh-plugin.org)展示了成熟形态:远程控制界面配二维码手机链接,以及微信、飞书、钉钉、企业微信、QQ、Slack、Telegram、Discord、WhatsApp 九个 bot 渠道,每个渠道把聊天机器人接入工作区,支持流式回复与问答转发。Prism Pocket 应当达到同等水准,同时保持 fork 原生、运行时零新增依赖,并对"没有公网回调时哪些渠道真正可用"保持诚实。

## [S2] Design

### S2.1 形态:扩展 `plugins/prism-pocket`,双面共用

本特性扩展现有的 `@prism/prism-pocket` out-of-tree 插件,不新建包。Node 半新增 `src/bots/` 子树(适配器、存储、supervisor、会话绑定、问答转发)与新路由;浏览器半新增重设计的 `PocketSection`,含九张渠道卡片与二维码块。不改 `packages/` 与 `apps/`。仓库根新增一个仅构建期使用的 devDependency:`qrcode-generator`(MIT、零依赖、单文件),由 tsdown 内联进 client bundle;发布包不引入 profile 之外的任何运行时依赖。

### S2.2 重设计的 Pocket 页面(浏览器半)

设置区对齐应用自身的设置页:一条 720px 纵列、16/24 的区块标题配三级色引言、settings-material 卡片(`--dsw-alias-settings-card-*` token)、13/20 行文、字重 ≤ 500、可见的 `:focus-visible` 圈。四个面板:

1. **手机访问** — 二维码卡(左)与判定条、带复制动作的鉴权链接、缺失步骤列表(右)并排。二维码编码带 token 的手机链接,全程本地生成;token 除二维码本体与复制动作外不离页。560px 以下收拢为单列。
2. **Bot 渠道** — 九张渠道卡片,单列纵向排布。每张卡带品牌色 logo 徽标、渠道名及区域标签(如有:飞书/Lark)、状态点与状态文字、可展开的凭据表单、启动/停止/测试动作。表单回显已保存的非敏感字段值(含飞书/Lark 区域);保存时留空的已存字段保持原值,由服务端合并。回调型渠道额外展示公网回调地址与可达性提示。
3. **通知** — 现有推送面板,套用同样的卡片材质。
4. **安装到主屏幕** — 现有 PWA 面板,同样重排。

所有文案经 `pocket.settings` 命名空间;渠道名是 locale 键。两种主题都需验证;品牌色只出现在 logo 徽标与状态点上,不用于正文。

### S2.3 Bot 渠道(Node 半)

`src/bots/adapters/` 下九个适配器,每渠道一个,各导出 `createAdapter(config, hooks)` 工厂,返回带 `start()`、`stop()`、`send(chatId, text)` 的句柄。IO 只留薄壳;所有协议变换(帧解析/构造、签名、加密、分块)都是带单测的纯导出函数。适配器互不引用;共享 IO 助手在 `src/bots/shared/`(`http.ts` 超时,`ws.ts` 带退避重连的 WebSocket,`sign.ts` 微信家族 AES 与 HMAC,`xml.ts` 微信家族扁平信封)。

| 渠道 | 连接 | 接收 | 发送 | 限制 |
| --- | --- | --- | --- | --- |
| Telegram | 长轮询 `getUpdates` | 轮询循环 | `sendMessage` | 4096 字符 |
| Discord | Gateway v10 WebSocket | `MESSAGE_CREATE` dispatch | REST `POST /channels/{id}/messages` | 2000 字符 |
| Slack | Socket Mode WebSocket | `events_api` 信封(需 ack) | `chat.postMessage` | 4000 字符 |
| 飞书 / Lark | 开放平台 WebSocket 长连接 | `im.message.receive_v1` | `POST /im/v1/messages` | 4000 字符 |
| 钉钉 | Stream Mode WebSocket | 机器人消息 topic | `sessionWebhook` POST | 实现时钉死 |
| QQ | 开放平台 WebSocket 网关 | `C2C_MESSAGE_CREATE` / 群事件 | REST v2 messages | 实现时钉死 |
| 企业微信 | 回调 URL(webserver 路由) | 加密回调 POST | `POST /message/send` + access token | 实现时钉死 |
| 微信 | 回调 URL(webserver 路由) | 加密回调 POST(公众号/测试号) | 被动加密回复或客服消息 API | 实现时钉死 |
| WhatsApp | 回调 URL(webserver 路由) | Cloud API webhook POST | Graph API `/{phoneNumberId}/messages` | 4096 字符 |

各渠道限制在实现时按平台文档钉死,作为分块器旁边的每适配器常量。

### S2.4 凭据与状态

每渠道凭据与启用开关持久化在 DSH home 的 `pocket/bots.json`(mode 0600),由镜像 `push/store.ts` 的串行化存储写入。路由层按渠道严格校验(parser/config 信任级);畸形请求体返回 400 并指明出错字段。`GET /api/pocket/bots` 返回状态(`off | starting | online | error`)、出错信息与脱敏配置摘要——secret 字段只报告是否已设置,永不回显。supervisor 在启动时拉起已启用渠道、配置变更即重启、断线按有上限的指数退避重连、停用或销毁时停止;每次状态迁移都更新页面轮询到的状态。

### S2.5 入站消息 → 会话

每个 bot 绑定一个会话(v1 为单会话绑定)。无绑定的 bot 收到首条入站消息时,经 `sessionController.create({})` 新建空白会话并记录 id。入站文本以 `createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'pocket-bot' } })` 经 `agent.followup(...)` 加 `sessions.flush(...)` 送达 agent,整体包在 `agents.withoutInitiator(...)` 内——即 schedule 的投递模式。`'pocket-bot'` 成员声明进 `MessageSourceMap`,该消息与其他所有模型可见输入一样进入会话日志。命令:`/new` 重绑到新的空白会话,`/stop` 在会话暴露中止入口时中止当前回合,`/help` 列出命令;其余文本照常转发。绑定的会话无法 resolve 时,绑定重置,下一条消息新建会话。

### S2.6 回复

Node 半观察 `session/event`;`assistant/message` 事件所属会话绑定了 bot 会话时,消息的文本内容按会话排队,经适配器按渠道限制分块送达。多步回合的每条 assistant 消息完成即发送;逐 token 流式不在本特性范围。投递失败只记日志,不抛进 agent loop,也不清除绑定。

### S2.7 问答转发(审批与用户提问)

当 bot 会话存在待处理的审批或用户提问时,转发层在聊天里渲染——审批显示工具名,提问显示问题与编号选项——并让 answerer 链有界等待(120s)。该会话绑定的聊天里下一条回复将 resolve 该请求:`1`/`y` 对应审批的第一个选项(批准/接受),`2`/`n` 对应拒绝;提问则按编号映射请求携带的选项。超时或无关回复经 `next()` 委托,让请求落回宿主自身界面;每个会话同一时刻只有一个待处理请求,等待期内后来的请求立即委托。转发层只观察;会话未绑定聊天时绝不 claim 请求。

### S2.8 回调型渠道

三个回调渠道注册非鉴权 webserver 路由(`/pocket/bots/<channel>/callback`,GET 用于验证握手,POST 用于消息投递)——与 PWA 静态资源同路径机制。每个请求先过其平台的校验再处理:微信与企业微信用 (token, timestamp, nonce) 的 SHA-1 签名加 encodingAESKey 信封解密并校验时间戳新鲜度;WhatsApp 用原始请求体的 `X-Hub-Signature-256` HMAC 与 verify-token 应答。页面展示各回调渠道的公网地址与可达性提示(Tailscale Funnel 或既有反向代理);插件自身绝不改动代理状态。没有存储凭据的回调路由返回 404。

### S2.9 路由

鉴权 `/api` 通道上单个端点承载列表与全部动作:`GET /api/pocket/bots`,以及携带 `{ channel, action: 'config' | 'start' | 'stop' | 'test' }` 的 `POST /api/pocket/bots`(config 动作携带提交的字段与是否启用)。config 提交在已存凭据之上合并——省略或留空的字段保持原值——且对运行中的渠道保存后即刻重启,让新凭据生效。`test` 执行各渠道最便宜的凭据探测(`getMe`、`/gateway/bot`、`apps.connections.open`、tenant token、stream ticket、网关 ticket),只报结果不发送聊天消息;已停止的渠道为探测临时启动一次再停止,开关状态不变。误配置大声失败:未知渠道或动作、任何未通过严格校验的配置,都以 400 返回并指明出错字段。

### S2.10 文案归属

页面文案全部经 `ctx.locale` 走 zh/en 词典;九个渠道名、区域标签与所有状态/字段标签都是 locale 键。service worker 不动。

## [S3] Scope

- In scope:重设计的 Pocket 页(二维码、九张渠道卡片、推送、PWA),九个渠道适配器及其协议单测,凭据存储与 supervisor,会话绑定与命令,带分块的回复投递,问答转发,鉴权 bot 路由,三条回调路由,根 devDependency `qrcode-generator`,zh/en 词典,README 配对,spec 配对。
- Out of scope:逐 token 流式卡片,媒体与文件往返,飞书/企业微信扫码建应用(仅凭据字段),群与多机器人管理,自动改动代理状态,`packages/`/`apps/` 编辑,harness-connector 式云中继,桌面(Tauri)面改动。

## Tasks

- [x] T1: bots 地基 — `types.ts` 渠道/配置/状态判别联合,`bots.json` 存储(0600、串行写),supervisor 生命周期(启动拉起、配置变更重启、有上限退避、销毁)(covers: S2.3, S2.4)
- [x] T2: 出站适配器 — telegram、discord、slack、feishu/lark、dingtalk、qq,纯协议函数 + 薄 IO(covers: S2.3)
- [x] T3: 回调适配器 — wechat、wecom、whatsapp:签名/加密纯函数、webserver 回调路由、发送 API(covers: S2.3, S2.8)
- [x] T4: 会话绑定、入站命令、带分块的回复 outbox、审批与提问转发(covers: S2.5, S2.6, S2.7)
- [x] T5: 鉴权路由(list/config/start/stop/test),按渠道严格校验与脱敏读取(covers: S2.4, S2.9)
- [x] T6: 客户端重设计 — 720px 设置页,内联 `qrcode-generator` 的二维码面板,九张渠道卡片(表单与动作),推送与 PWA 面板重排,响应式收拢,焦点圈,zh/en 词典(covers: S2.2, S2.3, S2.10)
- [x] T7: 测试 — 存储持久化与权限,配置合并与区域保持,supervisor 状态迁移,每个适配器的协议逻辑(帧、签名、AES 往返、分块),问答转发的 resolve 与超时,入站命令判定(covers: S2.3–S2.7)
- [x] T8: 验证 — tsc、vitest、tsdown 双面构建,真实 web profile 启动并含 bots 路由,手机视口浏览器检查重设计页(covers: S4)
- [x] T9: 文档 — README en+zh,spec en+zh 配对并记录哈希,changelog 条目(covers: S2.10)

## [S4] Acceptance

- 插件通过类型检查、全部测试通过、双面构建成功;web profile 带插件启动并提供 bot 路由。
- 重设计页在 settings 材质上渲染四个面板,窄视口收拢单列,展示可扫描的二维码(编码带 token 的手机链接),无硬编码文案。
- 九个渠道都能经卡片配置;保存严格校验,start/stop 状态即时反映,`test` 报告真实探测结果。
- 已连接渠道的入站消息到达绑定会话,assistant 回复送回聊天并按渠道限制分块。
- 绑定会话的待处理审批或提问渲染进聊天;编号回复即可 resolve,120s 沉默经 `next()` 委托。
- 微信、企业微信、WhatsApp 回调路由校验签名、解密信封、应答平台握手;无存储凭据时返回 404。
- 凭据持久化在 `pocket/bots.json`(mode 0600),绝不出现在任何路由响应里。
- 文档:README 与 spec 通过 `verify-md-wrap`、`verify-md-links`、`verify-translation-pairing`。
