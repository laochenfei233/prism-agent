---
feature: desktop-cookie-self-heal
status: delivered
updated: 2026-11-05
branch: feat/desktop-cookie-self-heal
commits: ee497b0bc4..5d6bd12029
---

# 桌面端 cookie 自愈

[English](desktop-cookie-self-heal.md) | 中文

## Report

**做了什么** —— 桌面端 Web 认证卡死的问题在失败链的两端都得到了修复。`BrowserAuth` 现在在签发 cookie 时（`authorizeIndex` token 兑换、`authorizeConnect`）会把请求仍携带的其他 `dsh-auth-` cookie 全部置为过期，因此无论桌面壳的回环端口如何在多次启动之间漂移，一个域在每个面上最多保留一枚签发 cookie。Web 监听器（`dsh-host-webserver`，HTTP 与 HTTPS）绑定固定的 64 KiB `maxHeaderSize`，高于 Node 默认的 16 KiB，因此已经卡死的安装升级后的首次启动就会把携带 token 的请求送达签发路径，并自行修剪回一枚 cookie——无需手工删除浏览器 profile 的 Cookies 存储。

`ConnectionIndexResponse.writeHead` 把它的 headers 记录加宽为接受 `string[]` 值（可变数组，以保持与 node `ServerResponse` 的结构兼容）。回归覆盖：`browser-auth.host.spec.ts` 中的清除断言（HTTP 与 TLS、浏览器与 API cookie），真实 webserver 在 HTTP 与 TLS 上服务的超大 Cookie 头请求，以及一条穿过真实 frontend-static 组合的端到端自愈（80 枚过期 cookie → 303 与 81 个 Set-Cookie 头 → 下一个请求只携带签发 cookie 并通过认证）。

**验证** —— worktree 中的聚焦套件：`pnpm vitest run` 覆盖 browser-auth.host.spec、node-half.host.spec、webserver.spec、frontend-static.spec、gateway.host.spec、operator-connect.host.spec——6 个文件、115 个测试、0 失败。端到端自愈测试在未修复的 master 上于 431 处失败（failing-first）。`pnpm run typecheck`——5/5 个门禁通过。文档门禁：两个被编辑的 README 对（en+zh）通过全部 summary/model-experience/concrete-terms 检查；其余 `test:docs` 失败在 master 上同样复现（既有）。pre-commit lefthook 因沙箱 msys `0xc0000142` 限制而中止；oxlint（staged 配置）、`git diff --cached --check` 与 vendor manifest 守卫为手工运行——全部干净。

**过程记录** ——

- 只靠服务端清除救不回一个已卡死的安装：一旦请求头越过解析器上限，Node 在任何 handler 运行之前就回答 431。预防与调高的监听上限必须一起发布。
- 把响应头加宽为 `readonly string[]` 破坏了 `ServerResponse` 兼容——`OutgoingHttpHeaders` 只接受可变数组。
- `gen-cordis-catalog` 在本分叉的基线上就是坏的（24 个既有 cron type-link 覆盖违规，master 上可复现），因此被改声明生成的 catalog 条目按生成器的格式手工投影（成员 JSDoc 从不记录）。2026-11-05 已解决：cron 与 speech-to-text 类型被归入生成器的策略映射，生成器现已端到端运行，并用完整成员 JSDoc 重新生成该条目。
- 桌面端的端口漂移来自 `select_port()` 的缺省端口被占后的回退扫描，不是真随机端口；无论哪种方式 cookie 机制都会累积，因此 Rust 侧被正确地保持不动。
- 评审者的跨实例备注：在共享的公共主机名上，向实例 B 认证会让该浏览器中实例 A 的 cookie 过期——由 token 门控、属自我造成，且是已被接受的「每域一枚 cookie」设计。

## [S1] 问题

桌面壳重启足够多次之后，欢迎流程永远以 Web 认证错误失败；重装与禁用插件都无济于事。

根因：`BrowserAuth` 把会话 cookie 命名为 `dsh-auth-` 加请求 authority 的 sha256，而 HTTP authority 包含端口。桌面壳在每次 spawn 时都选一次端口（缺省端口，被占后取第一个空闲端口），于是在漂移过的端口上的每次启动都会签发一个新的 cookie 名，而旧 cookie——域作用域、30 天有效期——继续为 `127.0.0.1` 累积。大约 70 枚 cookie 时，`Cookie` 请求头越过 Node 默认 16 KiB 的 `maxHeaderSize`；监听器在解析器中拒绝一切请求并回答 431，任何 handler——包括本可以签发并清除的启动 token 兑换——都无法运行。删除浏览器 profile 的 Cookies 存储是唯一的恢复手段。

## [S2] 设计

### S2.1 签发时清除过期的会话 cookie

`BrowserAuth` 在签发时（`authorizeIndex` token 分支、`authorizeConnect`）解析请求的 `Cookie` 头，收集每一个不是它正在签发的名字的 `dsh-auth-` cookie 名，并对每个过期名字回答一个过期的 `Set-Cookie`（属性与签发相同、空值、`Max-Age=0`、纪元 `Expires`）。浏览器删除这些 cookie，因此无论端口如何漂移，一个域最多保留一枚浏览器 cookie 加一枚 API cookie。删除从不动签名密钥，因此也会清掉来自更旧密钥与版本的 cookie。

`ConnectionIndexResponse.writeHead` 把它的 headers 记录加宽为接受数组值——可变的 `string[]`，因为 `OutgoingHttpHeaders` 拒绝只读数组，且 node 的 `ServerResponse` 必须继续满足该接口——这样签发响应可以携带多个 `Set-Cookie` 值。

### S2.2 监听器头部上限高于遗留膨胀

`WebServer` 以固定的 64 KiB `maxHeaderSize` 创建它的 HTTP 与 HTTPS 监听器。因此已卡死的安装会把下一个携带 token 的请求送达签发路径，S2.1 把存储修剪回一枚 cookie，壳在升级后的首次启动即自愈——无需手工删除 Cookies 存储。该上限保持固定常量：它是请求解析的安全上限，不是部署选择。

已否决：在 Rust 壳中于启动时清空 webview 浏览数据（平台 cookie API，会摧毁无关的 webview 状态）；只修固定端口（端口冲突仍在，已卡死的安装不会自愈，`dsh web` 的浏览器用户一无所获）。

## 范围

- 范围内：`dsh-client-connection` 的签发时清除；`dsh-host-webserver` 的头部上限；回归测试；两个包的 README/JSDoc 更新；changelog 条目。
- 范围外：桌面 Rust 的端口选择；cookie 密钥轮换；API gateway 自己的准入检查（同一监听器，已被 S2.2 覆盖）。

## Tasks

- [x] T1：加宽 `ConnectionIndexResponse.writeHead` 的 headers 类型 (depends: none)
- [x] T2：在 `authorizeIndex` 签发分支与 `authorizeConnect` 中清除过期的 `dsh-auth-` cookie (depends: T1)
- [x] T3：WebServer 的 HTTP 与 HTTPS 监听器固定 64 KiB `maxHeaderSize` (depends: none)
- [x] T4：回归测试——清除行为（browser-auth spec）、超大 cookie 请求到达签发路径（webserver spec）(depends: T2, T3)
- [x] T5：包 README 与 changelog 条目 (depends: T2, T3)

## [S4] 验收

- [x] 在请求已携带其他端口的 cookie 之后签发，回答的过期 `Set-Cookie` 头恰好对应过期名字，且当前 authority 得到签发 cookie。
- [x] `Cookie` 头超过 Node 默认 16 KiB 的请求在真实 `WebServer` 监听器上仍能到达路由 handler（无 431），HTTP 与 TLS 皆然。
- [x] 已卡死的 cookie 存储端到端自愈：超大头 → token 兑换 → 303 与清除头 → 下一个请求只携带一枚 `dsh-auth-` cookie 并通过认证。
- [x] 两个包的既有套件保持绿。
