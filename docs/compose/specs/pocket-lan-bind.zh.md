---
feature: pocket-lan-bind
status: designed
updated: 2026-11-24
branch: feat/pocket-lan-bind (worktree .worktrees/pocket-lan-bind)
commits: 26b7c472a5..
---

# 口袋插件的局域网绑定动作

[English](pocket-lan-bind.md) | 中文

## Report

## [S1] 问题

只要 hub 的 webserver 没有绑定本机的局域网地址，口袋设置页就会报出局域网阻塞（"服务只监听本机：需要绑定到局域网地址再启动"）。页面给出的唯一办法是一条 CLI 命令（`prism web --host <lan> --port <port>`），桌面版用户不退出应用就无法执行；而早于 `--bind-lan` 启动参数的桌面壳无论怎么重启都只绑回环。这个页面应当能自己打开局域网监听。

## [S2] 设计

**S2.1 —— webserver 服务的运行时绑定。** `WebServer` 新增 `bindAdditionalHost(host: string): Promise<void>`：校验一个具体的、非通配的、尚未绑定过的 IP 字面量，用与激活时相同的请求、upgrade 与 TLS 接线构建监听器，在配置的端口上监听，并把该地址记入服务的已绑定集合——因此 `hosts`（`/api` 信任围栏读取的权威列表）与资源释放都会包含它。监听失败时携带系统原因抛出；既有监听器继续服务。

**S2.2 —— 口袋绑定路由。** `POST /api/pocket/lan/bind` 探测本机首选的局域网 IPv4（复用既有 `detectLanAddress`），经 S2.1 绑定——已绑定时幂等——并以与 `GET /api/pocket/remote` 相同的状态体应答。没有局域网地址时答 `400 { error }`；监听失败答 `500 { error }`。

**S2.3 —— 活的面板数据。** 状态体里的 server surface 改读 webserver 服务的活值 `host`/`port`/`hosts`，而不是冻结的启动旗标，因此运行时绑定会出现在 `additionalHosts` 里，无需重启即清除局域网阻塞。`publicUrl` 与 `trustedHosts` 仍来自启动旗标。

**S2.4 —— 页面动作。** 当所选传输是局域网且手机阻塞为 `not-bound` 或 `loopback` 时，设置页在步骤旁边显示一个主色的「立即绑定」按钮。成功后重渲染状态（二维码与链接出现）；失败显示错误提示。可复制的 CLI 步骤保留为后备文案，其中「桌面版固定启动在本机回环上」的过时措辞一并刷新。

## [S3] 范围

- 范围内：webserver 运行时绑定方法及其测试；口袋路由与活面板数据及其测试；客户端按钮与中英文案；提示文案刷新。
- 范围外：Tailscale 与隧道传输；防火墙配置；绑定跨重启的持久化（桌面壳启动时已传 `--bind-lan`）；信任围栏规则的改动（绑定地址本就放行）。

## Tasks

- [ ] T1：webserver `bindAdditionalHost`——校验、共享的监听器构建、资源释放、测试 (depends: none)
- [ ] T2：口袋绑定路由与活面板数据组装，附路由测试 (depends: T1)
- [ ] T3：客户端绑定按钮、中英文案、提示刷新 (depends: T2)
- [ ] T4：聚焦验证——webserver 与口袋套件、口袋 typecheck、翻译配对门禁 (depends: T2, T3)

## [S4] 验收

- [ ] 只绑回环的 hub 在 `POST /api/pocket/lan/bind` 之后，`server.additionalHosts` 报告局域网地址，给出该地址上的 `phone.url`，且信任围栏放行该权威。
- [ ] 绑定已绑定的地址是幂等的；非法地址答 400；监听失败答错误且既有监听器继续服务。
- [ ] 页面只在局域网传输被阻塞时显示绑定动作，成功后阻塞清除。
