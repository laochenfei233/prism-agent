---
feature: pocket-device-pairing
status: delivered
updated: 2026-11-24
branch: feat/pocket-device-pairing
commits: 工作区改动，提交时回填
---

# 手机接入改为一次性配对流

## Report

**What was built** — 二维码改为编码 `phone.accessUrl`（`/pocket-pair` 干净地址）。手机页（`src/pairing/page.ts`，webserver 上的匿名 HTML）生成 id+secret、显示 8 位接入码、每 2s 轮询；桌面 Pocket 页在既有 8s 状态轮询的响应里读 `pairing.requests`，渲染「接入请求」卡（码、来源 IP、剩余分钟、允许/拒绝），决定走 `POST /api/pocket/pairing`；批准后手机拿到一次性登录 URL，走既有 `?token=` 交换。`packages/client/connection` 新增一次性令牌（内存 Map、兑换即删、`ttlMs` 过期、`/connect` 不接受）与 `mintOneTimeLoginUrl`，并把栅栏判定从私有 `isTrusted` 提为公开 `isTrustedRequest`。三条匿名路由（`/pocket-pair/{request,status,cancel}`）挂在 webserver 上：先过 `isTrustedRequest`，只收 `POST` + `application/json`，body ≤1 KiB，创建间隔 1s、池上限 16、轮询间隔 2s、票据 TTL 5 分钟；票据只在内存，插件 dispose 时 `clear()`，`issueUrl` 的基址取自解析出的手机地址而不是请求里的 Host。

**Verification** — `pnpm exec vitest run packages/client/connection`：14 文件 199 用例全绿（新增一次性令牌 5 条 + `isTrustedRequest`/`mintOneTimeLoginUrl` 2 条）；`plugins/prism-pocket` 的 `vitest run --config vitest.config.ts`：21 文件 163 用例全绿（新增 requests 10、routes 6、flow 2）；pocket `tsc -p tsconfig.json --noEmit` 干净；`verify-md-wrap`、`verify-md-links` 对本 spec 与两份 README 无报告。

**Journey log** — 组合测试用 `vi.mock('@deepseek-ai/dsh-llm')` 顶掉插件唯一的 workspace 值导入：该导入的源码图在 pocket 的 vitest 配置下不转换（`@deepseek-ai/dsh-llm` 只有 `lib/types`，没有 `lib/index.js`）。创建票据时 `nextPollAt` 取当前时刻而非 `now + interval`，否则手机的第一次状态读取只会拿到 `slow-down`。

## [S1] Problem

pocket 的二维码直接编码带登录令牌的链接：`phoneOf` 用 `connection.authenticatedUrl` 把本进程启动令牌拼进 URL（`plugins/prism-pocket/src/index.ts:418-429`），`phoneQrSvg` 原样编进 QR（`src/client/qr.ts:16`）。看到二维码（照片、截图、投屏）的人即可登录；令牌不区分设备、不可单独撤销，只能等进程重启。上游 remote-connection 的配对流把「凭证」换成「申请 → 桌面批准 → 一次性兑换」（对照与结论见 [remote-access-assessment](remote-access-assessment.md) S2.2/S2.3）。

本 spec 只做这一件事：二维码不再含令牌，手机要接入必须先在本机被批准。不引入上游包——它解决的是「另一台浏览器登录同一 web 应用」，且桌面半边绑定 Electron，fork 用不上。

## [S2] Design

### S2.1 流程

1. 桌面 Pocket 设置页的二维码改为编码干净接入页 `http://<addr>:<port>/pocket-pair`，不含 token。
2. 手机打开该页：pocket 在 webserver 注册的匿名 HTML（形状同 `src/pwa.ts:89` 的 PWA 资源）。页面脚本生成 `id`（uuid）与 `secret`（32 字节 base64url），`POST /pocket-pair/request` 拿到 8 位接入码，显示「等待批准」并每 2s 轮询 `/pocket-pair/status`。
3. 桌面设置页在既有 8s 轮询的 `/api/pocket/remote` 响应里看到 `pairing.requests`（接入码、来源 IP、剩余时间）。owner 比对手机上显示的码后点「允许」或「拒绝」，`POST /api/pocket/pairing`。
4. 手机轮询到 `approved` 拿到一次性登录 URL，顶层跳转走既有 `?token=` 交换（`packages/client/connection/src/browser-auth.ts:278` `authorizeIndex`），换取 30 天 HttpOnly cookie，进入应用。

### S2.2 一次性登录 URL（connection 的唯一改动）

`authenticatedUrl()` 交付的是可复用的启动令牌；若批准后仍把它交给手机，手机历史与截图里就留着可复用凭据，配对流只做了一半。因此新增第二个签入点，其余交换路径原样复用：

- `BrowserAuth` 增加一次性令牌：`mintOneTimeToken(ttlMs)` 发放，`authorizeIndex` 接受「启动令牌」或「未过期的一次性令牌」，一次性令牌兑换即删除并剪枝过期项；`authorizeConnect` 不接受一次性令牌。只在内存（Map，上限 64），不落盘、不写 credential。
- `HostConnectionService` 增加 `mintOneTimeLoginUrl(baseUrl, ttlMs)`；pocket 用 `ttlMs = 120_000`（够一次导航）。
- 把 `packages/client/connection/src/rpc-host.ts:164` 的私有 `isTrusted` 提为公开 `isTrustedRequest(request)`：匿名路由需要「只过 Host/Origin 栅栏、不要求 cookie」的判定，复用同一个 owner，不另写镜像（`plugins/prism-pocket/src/commands.ts:162` 的 `isOriginTrusted` 已注明仅用于显示）。

### S2.3 匿名路由与信任边界

三条 exact 路由注册到 webserver：`/pocket-pair/request`、`/pocket-pair/status`、`/pocket-pair/cancel`。它们不能挂在 `/api` 前缀下——那是 connection 的认证前缀，`connection.fetch.register` 要求有效 cookie（`src/index.ts:138`）。

每个处理函数先 `connection.isTrustedRequest()`：DNS rebinding 页面若能直接 POST，就能自造申请骗 owner 点「允许」。随后依次校验：只收 `POST` 且 `content-type: application/json`（跨站表单发不出该类型，等于强制 preflight）；body ≤ 1KiB（超出 413）；字段严格收 `{ id, secret }`（`cancel` 另无字段）。

固定常量（安全不变量，不做 Config）：`requestTtlMs 300_000`、`maxRequests 16`、`requestIntervalMs 1_000`、`pollIntervalMs 2_000`。来源 IP 取 `socket.remoteAddress` 并规整 `::ffff:` 前缀，忽略 `X-Forwarded-*`；反代之后显示的是代理地址，只作 owner 的判断参考。

### S2.4 状态与数据

进程内 `PairingRequests`（新 `src/pairing/requests.ts`，语义对照上游 `pairing-requests.ts`，去掉 cookie 分支）：`pending → approved → collected`，`pending → denied | cancelled | expired`；首个决定胜出且不可改写；批准后到 collected 之前可重复投递同一 URL（丢失响应可重试）；secret 常量时间比较；owner 只看码与 IP，secret 只在申请方手里；`clear()` 随插件 dispose。不落盘：重启即清空，没有明文或摘要的保管问题。

### S2.5 设置页

- 手机面板新增「接入请求」卡（仅有 pending 时渲染）：接入码、来源 IP、剩余倒计时、允许/拒绝。数据随既有 `/api/pocket/remote` 轮询到达，不新增 GET 路由、不新增轮询。
- 二维码改编码干净地址（`PocketPhoneAccess` 新增 `accessUrl`）；旁边保留「复制登录链接」（含令牌，既有能力）作为页面脚本不可用、或代理拦 POST 时的兜底，文案标注风险。
- 命名避让：现有 `phone.pairing` 是 **Bot 配对码**（`src/client/locales.ts:143`），新卡用「接入请求 / Access requests」，中英各一组 key，避免页面上两个「配对码」。

### S2.6 手机页

匿名 HTML 字面量（同 `src/pwa.ts:35` 的 SW 做法）：无外部资源、不加载认证模块、不缓存。文案按 `navigator.language` 出中/英（同 SW）。状态覆盖等待、拒绝、过期、取消、限速（`slow-down`）、不可用；失败可「重新请求」换新 ticket；`approved` 后 `location.replace(url)`，返回键回不到带令牌的地址。

### S2.7 测试与文档

- connection：一次性令牌兑换一次、过期失效、`/connect` 拒收、启动令牌与既有 cookie 行为不变；`isTrustedRequest` 的 host 分支。per-file 100% 覆盖门禁适用。
- pocket 单测：状态机（同 id+secret 重试幂等、首个决定胜出、过期、取消、限速、池满、secret 不符）、路由（栅栏 403、非 JSON 400、超限 413、方法 405、IP 规整）、`pairing` 状态块、客户端纯函数（码行与倒计时文案）。
- host 行为：真组合里走「申请 → 设置页可见 → 允许 → 手机拿到 URL → 兑换出 cookie」，另跑拒绝与过期两条负路。
- 文档：pocket README 的 Features/Notes、connection README 的一次性令牌段、changelog 片段。

## [S3] Scope

- In scope：`plugins/prism-pocket`（pairing store、三条匿名路由、手机页、`/api/pocket/remote` 的 `pairing` 块、`POST /api/pocket/pairing`、设置卡、locales、测试、README）；`packages/client/connection`（一次性令牌、`mintOneTimeLoginUrl`、公开 `isTrustedRequest`、测试、README）。
- Out of scope：引入上游 `remote-connection` / `authentication-*` 包；按设备吊销已发 cookie（仍靠重启进程或清 cookie，见评估 S2.4 观察项）；把 IM bot 通道接进配对流；改 webserver 的 `WebRoute` 契约；给配对过程加配置项；手机页的 PWA 安装引导（登录后仍由既有 PWA 路径提供）。

## Tasks

- [x] T1: connection 一次性令牌 + `mintOneTimeLoginUrl` + 公开 `isTrustedRequest` + 测试 (depends: none)
- [x] T2: `src/pairing/requests.ts` 状态机 + 单测 (depends: none)
- [x] T3: 三条匿名路由 + 栅栏/限速/body 校验 + 单测 (depends: T1, T2)
- [x] T4: `/pocket-pair` 手机页（HTML、轮询、中英文案） (depends: T3)
- [x] T5: `/api/pocket/remote` 增 `pairing` 块 + `POST /api/pocket/pairing` + 单测 (depends: T2)
- [x] T6: 设置页接入请求卡 + 二维码改干净地址 + locales 中英 (depends: T5)
- [x] T7: 真组合行为测试 + 两个 README + changelog (depends: T3, T4, T6)

## [S4] Acceptance

- [x] 扫新二维码（不含 token）：手机显示 8 位接入码并等待，桌面设置页出现同一码与来源 IP，点「允许」后手机在 2s 内拿到 URL 并登录成功。
- [x] 拒绝、5 分钟超时、取消、重复点击决定：手机侧分别得到 denied / expired / cancelled，均不签出 cookie，且首个决定不被后续改写。
- [x] 一次性令牌只兑换一次：第二次访问同一 URL 得 401；未兑换 120s 后失效；`/connect` 不接受它。
- [x] 启动令牌、既有 30 天 cookie、`authenticatedUrl` 旧路径行为不变，connection 既有测试全绿。
- [x] 异源或跨站 Host 的 POST 被 403 拒（rebinding 面）；非 JSON 400、超大 body 413、GET 405。
- [x] 手机拒绝或页面脚本不可用时，「复制登录链接」仍可登录（兜底保留）。
- [x] pocket 与 connection 既有测试全绿；per-file 100% 覆盖门禁通过。
