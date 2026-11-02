---
feature: prism-pocket
status: delivered
updated: 2026-11-02
branch: feat/prism-pocket
commits: 8c5ed274ee..2f3a5b8ca1
---

# Prism Pocket（口袋 Prism）

[English](prism-pocket.md) | 中文

## Report

**构建内容** —— `plugins/prism-pocket`（`@prism/prism-pocket`），一个仓库外双面 Cordis 插件，把现有 Web 表面变成手机可用的远程控制台，不改动 `packages/` 与 `apps/`。浏览器半增加按激活条件生效的移动适配（窄屏触摸视口或 `?pocket=`）：左边缘内滑把应用自己的侧栏变成覆盖抽屉、返回手势关闭、`visualViewport` 跟踪软键盘、触摸键盘上普通 `Enter` 换行，样式表只锚定应用自身的 `[data-slot]` 接缝。批准请求、用户提问与运行失败经应用自己的事件桥弹出页内卡片与隐藏页系统通知；页面关闭时节点半投递 Web Push（RFC 8291/8292 以 `node:crypto` 实现，零运行时依赖）加可选的 Bark 通道，订阅与 VAPID 密钥对存于 DSH home 的 `pocket/` 目录。「口袋」设置分区探测本机 Tailscale、按镜像规则校验当前连接与信任围栏的一致性，并给出直连 IP 与 MagicDNS 两条路径的可复制命令；插件还提供 PWA 的 manifest、service worker 与图标。

**验证** —— `tsc -p tsconfig.json --noEmit` 干净；`vitest run` 43/43（RFC 8291 经独立实现的接收方往返、VAPID ES256 JWT 对存储公钥验证、存储持久化/清理、发送端头部契约、触发决策（含合并扩展静默）、Tailscale 解析、贴合围栏的信任判定、激活/手势逻辑）；tsdown 双面构建；实机 web profile 启动后 `/pocket.webmanifest` 与 `/pocket-sw.js` 可访问、`GET /api/pocket/remote` 返回真实 Tailscale 事实、订阅被接受且被严格校验、测试路由软失败、抽屉/popstate 关闭/设置分区在手机视口浏览器中实测并截图。评审第一轮 REQUEST_CHANGES（缺 README.zh、浏览器半失败卡片、背板关闭、信任徽章保真），四项全部修复后复审 APPROVE，另留两条仅显示层的漂移（`--trusted-host` 的默认端口与大小写）作为后续项。

**历程日志** —— 载体服务名是 `webServer` 而非 `webserver`；启动审计日志会精确写出等待者，先读日志再猜注入名。slot 锚点内联渲染 `display: contents`，插件 CSS 必须先用 `!important` 把它还原成真实盒子再定位。可转发宿主事件白名单在 `packages/api/remotes/src/remote-events.ts`，其中已有 `api-session/error`——客户端半应复用既有白名单事件，而不是提议新增。信任围栏在绑定 loopback 时接受任意 loopback origin、无端口 trusted host 匹配任意端口；显示侧徽章必须镜像 `api-request-trust.ts`，而不是凭直觉。

## [S1] 问题

手机浏览器访问 Prism Web UI 时，拿到的只是一个仅会退化为 56 px 图标轨的桌面布局（1024 px 以下）：侧栏没有触摸抽屉，软键盘弹起时没有任何 `visualViewport` 处理、直接盖住输入区，触摸键盘上 `Enter` 仍然发送消息，模型/权限行换行溢出，没有任何 safe-area 适配。远程访问还有额外门槛：webserver 只绑一个具体地址，Host/Origin 信任围栏拒绝其余一切，产品内没有任何文字解释如何通过 Tailscale 配对手机。最致命的是，手机放在旁边时什么都不知道——agent 请求批准或提出问题时，页面静静躺在那里，没人看就没人知道。

`dsh-meow-smooth` 为上游 dsh 解决过这个问题，方式是在仓库外给桌面 DOM 打补丁，每个版本都要维护一次选择器。Prism 有同样的需求；本特性交付的是 fork 原生、形态更正确的版本。

## [S2] 设计

### S2.1 形态：客户端补丁插件，不是独立应用，不改本体

`plugins/prism-pocket`（`@prism/prism-pocket`），双面 Cordis 插件，沿用 `plugins/prism-progress` 的形态：节点半 `lib/index.js`（ESM），浏览器半 `lib/client.js`（经 `window.__ModuleLoader__` 注册的闭包工厂产物），`dsh.bundle.patch` + `dsh.client` 清单，`./client` 导出。不改动 `packages/` 与 `apps/`。所有适配只锚定应用自己声明的表面——`[data-slot="<key>"]` 容器（`packages/client/ui-renderer/src/client/scoped-slots.tsx` 写明的 addressable seam）、`data-testid` 属性、标准 ARIA 角色——每个适配都是一个能力探针，锚点缺失时跳过并在控制台留一行说明。这是相对 meow-smooth 的自觉改进：不猜选择器，不随版本碎裂。

### S2.2 激活条件

视口较窄且指针为触摸（`pointer: coarse` 且 `width <= 768`）时激活；URL 带 `?pocket=1` / `?pocket=0` 可显式覆盖，最后一次显式选择记入 `localStorage`。桌面外观不受影响。

### S2.3 移动适配层（浏览器半）

- 侧栏抽屉：从左边缘内滑打开侧栏；浏览器返回手势先关抽屉（popstate 拦截）而不是离开页面；抽屉是带暗色背景遮罩的 overlay sheet，选中会话即关闭。
- 软键盘：`visualViewport` 跟踪，键盘弹起时收起顶栏，输入坞保持可见；坞和抽屉尊重 safe-area inset。
- 触摸输入：触摸指针上 `Enter` 换行（IME 组合与 Shift/Ctrl+Enter 不受影响）；若运行态没有暴露停止入口，插件在输入坞补一个。
- 行不换行：模型、权限、上下文条在窄屏截断或收成图标；消息内表格横向滚动。
- 禁止误触缩放与橡皮筋滚动；窄屏切换会话后侧栏回到收起态。设置页尺寸交给宿主布局处理（范围外，见 S3）。

视觉新增（抽屉、卡片）复用应用主题 token；唯一签名元素是呈现为 overlay sheet 的边缘侧滑抽屉。

### S2.4 通知（浏览器半）

agent 请求批准、提出用户问题、运行失败时，在插件自有的 portal（`document.body` 子元素，不碰应用 DOM）上弹页内卡片；同样的触发在页面隐藏时发系统 `Notification`，页面聚焦时绝不打扰。只对最终失败提醒，瞬时重试状态不提醒。触发源订阅自带批准/提问表面已在消费的客户端投影与 Cordis 客户端事件；具体成员名在 T3 落定。

### S2.5 推送投递（节点半）

页面关闭后由节点半投递：Web Push（RFC 8291 `aes128gcm` 载荷加密 + RFC 8292 VAPID ES256 JWT，用 `node:crypto` 实现——本环境 npm registry 不可达，不引入推送库）与可选的 Bark webhook。触发：批准请求、用户提问、回合完成（可配置，默认开）、运行失败。VAPID 密钥对只生成一次，存于 DSH home 的 `pocket/` 目录（`keys.json`，0600）；订阅存于同目录 `subscriptions.json`；应答 404/410 的端点即删除。路由经 `connection.fetch.register` 挂在已认证的 `/api` 通道上：`GET /api/pocket/remote`、`POST /api/pocket/push/subscribe`、`POST /api/pocket/push/test`。推送载荷是结构化的（`kind`、`sessionId`、`sessionTitle`）；service worker 按 `navigator.language` 组织本地化文案。Config 字段（schemastery `Config`）：`pushEnabled`（默认 true）、`notifyTurnComplete`（默认 true）、`barkUrl`（可选）。仅当存在至少一个订阅或已配置 webhook 时，节点半才发送推送与 Bark。

### S2.6 Tailscale 远程访问（节点半 + 设置页）

节点半探测 Tailscale（`tailscale status --json --peers=false`，包含 Windows 路径 `C:\Program Files\Tailscale\tailscale.exe`），报告自身 MagicDNS 域名与 100.x 地址。设置分区只回答一个问题——手机现在能不能打开——并且用请求而不是配置来回答：桌面应用以固定参数在本机回环端口启动 `dsh web`，`webStartup` 既没有围栏接受的绑定地址也没有受信任的 authority，而按这些旗标推断的页面会把一个其实可用的部署报成打不开。因此节点半从主机侧请求对外地址的 `/api/pocket/remote`：没有回应说明还没人代理这个端口，`403` 是围栏拒绝了该 authority，其余任何回应都说明请求已经到达服务器。

结论为「能打开」时，页面给出 `connection.authenticatedUrl(<ts.net 根地址>)` 供复制——手机打开它即用其中的登录令牌换取会话 Cookie——并展示把令牌隐去后的同一 URL。否则按顺序列出还缺的步骤：先用 `tailscale serve --bg --https=443 http://127.0.0.1:<port>` 代理回环监听，再把 ts.net authority 加进 `trustedHosts`，桌面应用从 profile 补丁而不是旗标取得这一项。

内核信任策略（`packages/client/connection/src/api-request-trust.ts`）、webserver 的通配符拒绝、全部 CLI 旗标一律不动；插件只读取并解释它们，`--trusted-host` 仍是同一授权的命令行写法。

### S2.7 PWA 安装

节点半在 webserver 上注册自有静态资产路由：`/pocket.webmanifest`、`/pocket-sw.js`（根路径，默认 scope 即 `/`）与一枚 SVG 图标。浏览器半在启动时注入 manifest 链接、`apple-touch-icon` 与 `theme-color` meta。Service worker 处理 `push`（弹出通知）与 `notificationclick`（聚焦应用，或从根路径打开）。iOS 不支持 SVG 主屏图标；PNG 图标是已记录的后续项。

### S2.8 文案归属

所有用户可见文案经 `ctx.locale` 走 zh/en 词典；service worker 自持一份极小 zh/en 表（它活在客户端上下文之外）。Bark 通道发送英文标题：节点半没有 locale 上下文，也无法从这里得知 Bark 设备自身的语言。

## [S3] 范围

- 范围内：插件骨架（双面、patch 行、清单）、移动适配层、页内/系统通知、Web Push + Bark 投递、Tailscale 探测与远程访问设置分区、PWA 资产与 service worker、zh/en 文案、插件 README（en/zh）、节点半与纯客户端逻辑单测、spec 文档配对。
- 范围外：接管壳或独立移动页、对 `packages/`/`apps/` 的改动、手机附件上传、历史压缩代理（webserver 已有 gzip）、自动执行 `tailscale serve` 或自动改信任列表、二维码、桌面（Tauri）表面改动、PNG 图标生成、设置页全屏样式（宿主布局自身会退化）。

## Tasks

- [x] T1: 插件骨架 —— `plugins/prism-pocket` 的 package.json（`@prism/prism-pocket`、`dsh.bundle.patch`、`dsh.client`、`./client` 导出）、手写闭包 banner/footer 的 tsdown 双面构建、`cordis.patch.yml` 插入节点行与浏览器 roster 行（covers: S2.1）
- [x] T2: 节点半远程服务 —— schemastery `Config`（S2.5 字段）、Tailscale 探测与解析、经 `connection.fetch.register` 的 `GET /api/pocket/remote`（covers: S2.5, S2.6）
- [x] T3: 推送引擎 —— VAPID 密钥存储、经 `node:crypto` 的 RFC 8291 加密 + RFC 8292 JWT、带 404/410 清理的订阅存储、Bark 投递、会话触发接线（批准瀑布、用户提问表面、`turn/end`）、`POST /api/pocket/push/subscribe|test`（covers: S2.5）
- [x] T4: 浏览器半移动适配 —— 激活探针、带 popstate 拦截的边缘侧滑抽屉、`visualViewport` 键盘处理、带 IME 防护的 `Enter` 换行、行不换行 CSS、safe-area/缩放/橡皮筋规则、页内通知 portal + 系统通知（covers: S2.2, S2.3, S2.4）
- [x] T5: 浏览器半设置分区（远程访问 + 推送状态/测试）、PWA 资产路由、manifest 链接注入、service worker（covers: S2.6, S2.7)
- [x] T6: zh/en 词典、插件 README en+zh、导出契约 JSDoc（covers: S2.8）
- [x] T7: 测试 —— RFC 8291 往返 + VAPID JWT 对存储公钥的验证、Tailscale JSON 解析、命令生成、订阅存储清理、激活/手势/命令复制纯逻辑（covers: S2.5, S2.6）
- [x] T8: 验证 —— 双面构建、typecheck、聚焦测试、装入 dev web profile、手机视口浏览器检查与截图（covers: S4）

## [S4] 验收

- 插件双面构建成功，web profile 装载后可启动；细指针或宽视口下桌面外观与行为不变。
- 手机尺寸触摸视口下：边缘侧滑打开抽屉、返回关闭、`Enter` 换行、输入坞与信息行不溢出、键盘弹起时顶栏收起。
- 批准请求触发页内卡片、隐藏时的系统通知、以及向已订阅浏览器的 Web Push；`POST /api/pocket/push/test` 可证明送达；配置了 `barkUrl` 时收到 POST。
- `GET /api/pocket/remote` 报告绑定面、trusted hosts 与 Tailscale 事实，设置分区渲染符合围栏规则的可复制命令。
- `/pocket.webmanifest` 与 `/pocket-sw.js` 可访问，移动浏览器提供安装入口。
- 单测覆盖推送加密（往返 + 对存储公钥的 JWT 验证）、Tailscale 解析、命令生成与存储清理；全部通过。
- 文档：双语 spec 对 + 插件 README 通过 `verify-md-wrap`、`verify-md-links`、`verify-translation-pairing`。
