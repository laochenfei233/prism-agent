---
feature: pocket-connector-channels
status: delivered
updated: 2026-11-24
branch: feat/pocket-connector-channels
commits: 待交付时回填
---

# Pocket 的飞书/企微/钉钉改用上游 Connector 实现

English | [中文](pocket-connector-channels.zh.md)

## Report

**What was built** — `plugins/prism-pocket` 退役了飞书、钉钉、企微三个自研 bot 适配器，这三个通道改由上游 CLI connector 承担，口袋设置页仍是九通道的唯一入口。宿主侧：`BotChannelId`/`BOT_CHANNEL_KINDS`/`BOT_SECRET_FIELDS`/`BotConfig` 与 `validate.ts` 的严格读取收窄为六通道；删除 `adapters/{feishu,dingtalk,wecom}.ts`、只为飞书长连接存在的 `shared/protobuf.ts`、企业微信回调路由与 `oneOf` 区域校验；`BotStore` 加载时丢弃这三个通道的旧条目并回写文件，不留残余凭据。浏览器侧：`CHANNEL_META` 保持九张卡与页序，三张卡改为 `connector: true` 的注记卡——品牌 chip、名称、「上游 connector」标签、账号状态（已连接/未连接/检查中/连接中/不可用，来自宿主新增的连接器状态读取）与来源说明，不再渲染凭据表单、开始/停止/测试与控制台链接；只为飞书存在的区域选择器一并删除。组合侧：pocket 的 `cordis.patch.yml` 追加 `feishu`/`dingtalk`/`wecom` 三行（上游 connector 的共享服务 `cli-account`、`upstream-skills` 已是 base bundle 行，Plugins 页账号 UI 已是 web-app bundle 的 `connector-account` 行，均无需重复声明）。

**账号状态读取** — pocket 宿主按可选服务约定用 `ctx.get('connectorAccounts')` 结构化读取 web-app bundle 挂载的连接器账号注册表（pocket 不依赖 workspace 类型，沿用 `session-import` 的结构化读取模式），后台 `watch` 最新账号视图并映射到通道；状态随既有 bots 列表路由的 `connectors` 字段下发，卡片据此显示。注册表缺席时卡片显示「未知」，watch 失败保留最后状态。

**Verification** — `tsc -p plugins/prism-pocket/tsconfig.json --noEmit` 干净；`vitest run` 153/153，其中新增 `tests/client/channel-meta.spec.ts` 钉住九张卡页序、三张 connector 标记、无凭据字段与无回调，`tests/bots/store.spec.ts` 新增「旧 feishu 条目加载时被丢弃并回写文件」，协议/路由/存储用例同步删除三通道断言。组合验证：`pnpm dsh --profile web --patch plugins/prism-pocket/cordis.patch.yml --dump-config` 的输出里 `feishu`/`dingtalk`/`wecom` 行与 base 的 `cli-account`、web-app 的 `ui-connector-account` 并存，兼容预检不再禁用任何 pocket/connector 行（0.2.2-rc.1 基线上曾全部被禁，resync 后自然满足）。环境注意：本机对未打补丁的 master 也复现 `typert-loader` 激活失败使 web 启动中止（Node 24.19.0 低于 engines 要求的 ^24.22.3），属既有环境问题，与本次改动无关；完整启动连接器账号连接按验收标准留待有 CLI 环境时手工验证。

**Known gaps** — 卡片到 Plugins 页的外跳按钮仍缺接缝：`settings.section` 的 owner props 只有 `close()`，跨 section 导航（`openSection`）目前只提供给 onboarding 步骤；卡片先用文案指向 Plugins 页，接缝就绪后再升级为按钮。

## [S1] Problem

`plugins/prism-pocket` 自研了九个 IM 通道的协议适配器（`src/bots/adapters/`：telegram、discord、slack、feishu、dingtalk、qq、wecom、wechat、whatsapp），其中飞书、钉钉、企微三个通道要与厂商的签名/长连接/协议变更长期缠斗。上游 0.2.3-alpha.2 新增了 connector 组：`packages/connector/{feishu,dingtalk,wecom}` 分别封装官方 CLI（lark-cli / dws / wecom-cli）+ 官方技能 + 账号托管（`packages/connector/cli-account` 的 `ctx.cliAccounts`，账号经 `ctx.connectorAccounts` 显示在 Plugins 页），由官方维护协议层。决策：这三个通道改用上游实现方式，但 **pocket 设置页仍是唯一入口**，页面上注明实现来源。

## [S2] Design

### S2.1 入口不变：pocket 页面仍是九通道的唯一入口

`src/client/channel-meta.ts` 的 `CHANNEL_META` 保持九通道及页序；feishu/dingtalk/wecom 三张卡片留在原位，仅改卡片内容（S2.3）。pocket 的 `cordis.patch.yml`（单 `pocket` 行，inject webStartup）结构不变，仅追加 connector 行。

### S2.2 实现切换： retire 三个自研适配器

- `src/bots/adapters/index.ts` 的 `BOT_ADAPTERS` 移除 `feishu`/`dingtalk`/`wecom` 三个工厂；删除 `adapters/{feishu,dingtalk,wecom}.ts`。
- `BotChannelId` 与配置校验（`bots/validate.ts`、`bots/types.ts`）同步收窄；逐个核对 `bots/shared/{protobuf,sign,xml,ws,dedup}.ts` 的使用方，只为这三个通道存在的辅助代码一并删除，共用的保留。
- 这三个通道不再接受 bot 凭证表单；pocket hub 不再为它们维护 webhook/长连接收发。

### S2.3 卡片改版：connector 状态卡 + 来源注记

三张卡片改为"上游 connector 实现"状态卡：

- 卡片增加注记文案（`src/client/locales.ts` 新增 locale key，中英双语）："此通道由上游官方 CLI connector 实现（lark-cli / dws / wecom-cli）"。
- 状态读取 `ctx.connectorAccounts`：显示账号是否已连接、对应 connector 是否启用。
- 配置动作引导到 Plugins 页对应 connector 卡；pocket 卡片不渲染 token/secret 表单，`BotFieldMeta` 对这三通道为空字段集。

### S2.4 组合接线

- pocket 的 `cordis.patch.yml` 追加 connector insert 行（`@deepseek-ai/dsh-feishu`、`@deepseek-ai/dsh-dingtalk`、`@deepseek-ai/dsh-wecom`），随 pocket 启用而可用；`cli-account` 与 `upstream-skills` 由 base bundle 提供，账号 UI 由 web-app bundle 的 `connector-account` 行提供，均不重复声明。
- 三个 connector 包是 workspace 包（`packages/connector/*`），经既有 runtime resolution 解析，不新增 fork 包、不改 apps/cli 依赖。

### S2.5 行为变化（已向用户明示）

这三个通道从"bot webhook/长连接推送"变为"官方 CLI 技能 + 账号托管"：模型经 connector 的 `SKILL.md` 技能主动收发消息；pocket 不再把这三平台的入站消息自动投递到会话。README 中英与 pocket 页面 hint 都写明了这一差异。其余六通道（telegram/discord/slack/qq/wechat/whatsapp）行为不变。

### S2.6 既有数据的处置

`pocket/bots.json` 里这三个通道的条目在 `BotStore` 加载时丢弃，并在确有丢弃时立即回写文件：退役通道的 `appSecret`/`corpSecret` 等不继续留在磁盘上。配对码不受影响。

## [S3] Scope

- In scope：pocket 三个适配器退役、`BotChannelId` 收窄、三张卡片改版与注记、pocket patch 追加 connector 行、locales、pocket 测试与 README。
- Out of scope：connector 包自身的修改；其余六通道；手机端 shell；上游 connector 的消息推送能力（若未来上游提供入站推送，另行评估回归 bot 形态）。

## Tasks

- [x] T1: 删除三个适配器与只为它们存在的 shared 辅助，收窄 `BotChannelId`/校验，清洗 `bots.json` 旧条目 (depends: none)
- [x] T2: 三张卡片改版（`channel-meta` 空字段集 + `connector` 标记 + 注记与账号状态）+ locales 中英 (depends: T1)
- [x] T3: pocket cordis.patch.yml 追加 connector 行，keyless 组合验证 (depends: T2)
- [x] T4: pocket 测试更新（卡片名册、校验、存储清洗）+ README 中英 (depends: T3)
- [x] T5: 账号状态读取（`ctx.get('connectorAccounts')` + bots 列表路由 `connectors` 字段 + 卡片状态显示）(depends: T3)
- [ ] T6: 卡片外跳 Plugins 页按钮 (depends: settings section 级导航接缝，见 Report Known gaps)

## [S4] Acceptance

- [x] `BOT_ADAPTERS` 不含 feishu/dingtalk/wecom 键；被删文件无残留引用。
- [x] pocket 页面九张卡齐全，三张显示"上游 connector 实现"注记与账号状态，不再出现 bot token 表单。
- [x] pocket 启用的组合中 connector 行生效：`--dump-config` 可见三行且预检不禁用。
- [ ] Plugins 页可完成飞书账号连接（有 CLI 环境时手工验证；本机 `typert-loader` 环境问题阻止完整启动，见 Report）。
- [x] 其余六通道的 pocket 测试回归通过（153/153）。
