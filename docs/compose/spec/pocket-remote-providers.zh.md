---
feature: pocket-remote-providers
status: delivered
updated: 2026-11-04
branch: feat/pocket-remote-providers
commits: 50ff54bd96..d8b9f2ff1f
---

# 口袋的两种远程通道

[English](pocket-remote-providers.md) | 中文

## Report

**交付内容** — 「口袋」手机面板现在用一个选择器提供两种通道：Tailscale（探测、MagicDNS 地址、`tailscale serve` 步骤、ts.net 可信补丁都保持原样），以及稳定隧道——一个由用户存下、由 `cloudflared` 或任意反向代理提供的 `https` 域名。选择持久化在宿主侧 DSH home 的 `pocket/remote.json`；`POST /api/pocket/remote` 校验请求体（https、无凭据、无片段、首尾无空白），以 0600 权限原子写入该文件，并直接回新状态体，页面因此从不重建宿主拥有的状态。`GET` 上报两个 CLI 探测结果、解析出的隧道地址，以及所选通道的手机地址；隧道地址与 Tailscale 共用同一套就绪探测，只有被探测应答且未被围栏拒绝时才算就绪。页面打印 `cloudflared tunnel run <name>` 与 `--url` 步骤、带版本号的探测结果、可信补丁，以及针对已存域名的 `--trusted-host` 标志。

**验证** — 在工作树里：`plugins/prism-pocket` 的 `vitest run`——13 个文件、115 个测试、0 失败（新增 `tests/remote-prefs.spec.ts` 7 个、`tests/tunnel.spec.ts` 5 个、`tests/commands.spec.ts` 20 个，含隧道命令集合与按通道的访问矩阵）；`tsc --noEmit` 以主检出的已构建声明校验插件源码，干净；`tsdown` 两个面都构建通过；`oxlint` 扫描插件源码与测试，0 警告 0 错误；`verify-md-links`（2108 个文件）与 `verify-client-ui-i18n`（1117 个文件）通过，改动的 spec 与 README 配对在 `verify-translation-pairing` 下通过。全仓的 `verify-md-wrap`、`verify-export-jsdoc` 与 `verify-translation-pairing` 只在 master 既有内容上失败（`docs/compose/specs/*`、`packages/transfer`、`packages/client/ui-theme`、`packages/host/webserver`）。第一轮评审没有严重问题，但提出五处要修：隧道步骤与 `--trusted-host` 标志从未渲染、带首尾空白的已存 URL 会跳过就绪探测、保存按钮会提交空值、切换失败提示被藏起来、输入框缺少标签——全部在 `d8b9f2ff1f` 修复并重新验证。

**过程记录** — 手机端是浏览器，真 P2P 需要 Service Worker 转发或带中继的原生客户端；在本机回环监听之上加一个稳定 HTTPS 域名，才是真正能让手机连上的最小改动，而围栏只接受精确授权名，随机域名的临时隧道过不了。插件仍然不启动任何守护进程，所以页面只解释 `cloudflared` 而不代跑。工具链：在链接工作树里，`pnpm install` 的生命周期脚本与 vite 的 Windows 真实路径探测都以管道 stdio 启动子进程，本沙箱拒绝；测试经 `.pnpm` 内的 vitest 入口以更高权限运行，而把工作树的 `node_modules` 指向主检出会让 `pnpm exec` 改写主检出的 workspace 链接——已在主检出重装修复；pnpm 只应在拥有 `node_modules` 的检出里运行。

## [S1] 问题

Pocket 设置页只讲一条离开本机的路：本地 Tailscale CLI、它的 MagicDNS 名，以及 `tailscale serve` 代理。已经用 Cloudflare 隧道（带稳定域名的命名隧道）把同一个回环端口暴露出去的用户，可达性其实一样，但页面报 `no-tailscale`，也给不出链接，因为状态路由只认识 Tailscale 一种通道。用户无法告诉插件该描述哪条通道，页面打印的可信主机步骤也永远是 ts.net 的授权名。

## [S2] 设计

### S2.1 两种通道，选中一条

插件认识两种通道：`tailscale`（探测本地 CLI，推导 MagicDNS 根）和 `tunnel`（用户自己拥有、由 `cloudflared` 或任意反向代理提供的稳定 HTTPS 域名）。选择持久化在宿主侧 `pocket/remote.json`，与机器人存储并列（`{ version: 1, provider: 'tailscale' | 'tunnel', tunnelUrl?: string }`，每次原子重写、权限 0600），默认 `tailscale`，即全新安装已有的行为。

选择决定页面解释哪条通道、以及手机链接、二维码和结论指向哪个地址。另一条通道的事实仍在状态体里并且始终可见：两个探测结果都会上报，因此用户能看到 Tailscale 已安装而实际选的是隧道。

### S2.2 隧道通道就是一个稳定 HTTPS 域名

路由取已存的 `tunnelUrl`，否则回退到 webserver 表面已有的 `--public-url` 值。它必须是 `https:` URL 且不带凭据、不带片段、首尾不带空白；路径保留（前缀剥离代理是合法部署）。插件从不启动、停止或配置隧道进程：和 `tailscale serve` 一样，隧道是用户的守护进程，插件只解释需要执行的那一步和它需要的围栏条目。

### S2.3 cloudflared 探测

宿主侧在 PATH 上探测 `cloudflared --version`（超时 5 秒，与 `detectTailscale` 相同的失败即软返回契约），上报 `{ available, version?, detail? }`。它不发网络请求、不读凭据、也不从 cloudflared 配置推断域名：稳定域名就是用户存下的那个，因为 token 托管的隧道本地并无配置可读。

### S2.4 按通道解析手机访问

`phoneAccess(surface, tailscale)` 保持 Tailscale 分支现有解析顺序（`publicUrl`，其次 MagicDNS 根，最后非回环绑定地址）和现有阻塞项；`tunnelAccess(surface, tunnelUrl)` 解析已存 URL，其次 `publicUrl`，阻塞项为 `no-tunnel-url`（两者都不存在）、`untrusted`（授权名不在 `trustedHosts` 里）以及探测得出的 `not-serving`。围栏本身不变。

### S2.5 状态线

`GET /api/pocket/remote` 返回 `server`、`tailscale`、`cloudflared`、`remote: { provider, tunnelUrl? }`、所选通道的 `phone`，以及原有的 `pocket` 块。`POST /api/pocket/remote` 接收 `{ provider, tunnelUrl? }`，校验、持久化并直接回新状态体，页面因此永远不需要重建宿主拥有的状态。

### S2.6 命令

`tailscale` 通道命令不变。`tunnel` 通道打印：`cloudflared tunnel run <name>`（命名隧道才能让域名稳定）、`cloudflared tunnel --url http://127.0.0.1:<port>`（首次连通性测试，域名随机、进不了围栏）、已存域名对应的可信补丁，以及从命令行启动服务时用的 `--trusted-host <host>` 标志。两条运行步骤在隧道的每个阻塞状态下都显示，包括还没存域名时；只有依赖域名的步骤（补丁与标志）才等域名。

### S2.7 设置界面

手机面板顶部放通道选择器，选中 `tunnel` 时其后是隧道域名输入框和保存动作。二维码、结论、链接和带编号的步骤只描述所选通道。文案和页面其余部分一样归本地化字典所有（中/英）；页面沿用现有面板样式类，不新增样式表。

### S2.8 围栏与安全不变

插件在信任边界校验存下的 URL，只请求它准备上报的那个手机地址，并且从不修改 `trustedHosts`。围栏没有点名的隧道域名渲染为 `untrusted` 并给出要加的那条补丁；只有探测被服务端应答后，地址才会被报告为就绪。隧道进程、其凭据和 DNS 路由留在插件之外。

### S2.9 测试

单元测试覆盖 URL 校验（协议、凭据、片段、路径、首尾空白）、按通道的目标地址与阻塞项矩阵、隧道命令集合、cloudflared 版本探测解析，以及偏好存储的默认值与损坏文件行为。设置页的纯逻辑仍放在 `commands.ts` 和新模块里，因此不需要浏览器测试装置。

## [S3] 范围

- 范围内：`pocket/remote.json` 偏好存储、`POST /api/pocket/remote`、cloudflared 探测、按通道的手机访问与命令、状态线字段、设置选择器与域名输入框、中英文案、README 小节、单元测试、变更片段。
- 范围外：启动或监管 `cloudflared`、`tailscale serve`、`tailscale funnel`；读取 `~/.cloudflared`；通配符或动态信任；WebRTC 或自研中继；在通用稳定域名通道之外再加第四种通道（ngrok、frp）；从页面清除已存的域名。

## Tasks

- [x] T1: 偏好存储 + 校验 + `POST` 路由（covers: S2.1, S2.2, S2.5）
- [x] T2: cloudflared 探测（covers: S2.3）
- [x] T3: 按通道的访问、阻塞项与命令（covers: S2.4, S2.6, S2.8）
- [x] T4: 状态线组装与探测（covers: S2.5）
- [x] T5: 设置选择器、隧道输入框、步骤、中英文案（covers: S2.7）
- [x] T6: 测试、README、变更片段（covers: S2.9）

## [S4] 验收

- `provider: tailscale` 时页面与之前完全一致：装了 Tailscale 的机器上目标地址、结论和步骤相同；没装时报 `no-tailscale`。
- `provider: tunnel` 且存了 `https://prism.example.com` 时，页面把该地址作为手机目标上报；`trustedHosts` 未点名 `prism.example.com` 之前为 `untrusted`，无应答时为 `not-serving`；它打印的可信补丁与 `packages/client/connection/src/api-request-trust.ts` 一致。
- `POST /api/pocket/remote` 对非 https URL、带凭据和带片段的请求回 400 且不改动已存值；被接受的请求以 0600 权限持久化到 `pocket/remote.json`，重启后仍在。
- 页面把 cloudflared 探测结果与当前选择分开上报。
- `plugins/prism-pocket` 里的 `vitest run` 通过，包括新增的校验、访问矩阵、命令和探测测试；`tsc --noEmit` 与插件构建干净。
