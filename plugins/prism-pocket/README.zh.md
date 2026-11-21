# @prism/prism-pocket

[English](README.md) | 中文

口袋里的 Prism：把 Web 表面变成手机可用的远程控制台，让九个 IM 渠道的聊天机器人驱动工作区，agent 也能主动叫你回来。

一个纯客户端补丁插件——不改 Web 应用本体。所有适配只锚定应用自己声明的 `[data-slot]` 接缝，锚点缺失时按特性降级，桌面端体验完全不受影响。

## 功能

**移动适配**（窄屏 + 触摸指针时激活，或 URL 带 `?pocket=1`）：

- 左边缘内滑以覆盖层抽屉打开侧栏；浏览器返回手势先关抽屉而不是离开页面；抽屉内的任何导航都会收起它。
- 通过 `visualViewport` 跟踪软键盘：键盘弹起时顶栏让位、输入坞保持可见，并尊重 safe-area inset。
- 触摸键盘上普通 `Enter` 换行（IME 组合与修饰键组合不受影响）。
- 输入区控制行横向滚动而不是换行；消息内表格横向滚动；禁用误触缩放与橡皮筋滚动。

**通知**：

- agent 请求批准或提出问题时弹出页内卡片；页面隐藏时发系统 `Notification`；运行失败经 `api-session/error` 同样提醒。
- 页面关闭后走 Web Push（RFC 8291/8292，`node:crypto` 实现，不引入推送库），覆盖批准、提问、回合完成与运行失败。订阅与 VAPID 密钥对存于 DSH home 的 `pocket/` 目录。
- 可选 Bark 通道（`barkUrl` 配置），为未安装 PWA 的 iOS 提供推送。

**Bot 渠道**（九个渠道，在「口袋」设置页配置）：

- Telegram、Discord、Slack、飞书/Lark、钉钉、QQ 走出站连接——本机发起的 WebSocket 长连接或轮询，无需公网 IP、无需隧道。
- 微信（公众号/测试号）、企业微信（自建应用）、WhatsApp（Cloud API）经插件在 webserver 上注册的签名回调路由接收；页面给出需登记的回调地址与可达性提示（Tailscale Funnel 或你自己的反向代理）。
- 每个 bot 绑定一个会话，且绑定只认操作者：在你的聊天里发送 `/start <配对码>`（配对码显示在口袋页面二维码旁，渠道不会再因第一条消息而自动绑定），`/new` 从你已操作的任意聊天重绑，`/stop` 在 agent 暴露中止入口时中止回合，`/help` 列出命令。回复按渠道限制分块回到绑定的聊天；待处理的审批和提问以编号选项送达——`1`/`y` 批准、`2`/`n` 拒绝、数字选择提问选项，120 秒沉默则交回应用自身界面。
- 凭据存于 DSH home 的 `pocket/bots.json`（mode 0600），绝不出现在任何路由响应里；渠道卡片逐字段报告是否已保存值。`测试` 只做最便宜的凭据探测，不发消息。

**远程访问：局域网优先，Tailscale 或稳定隧道兜底**：

- 「口袋」设置分区提供三种通道，默认走局域网：它找出本机的私有 IPv4 地址（优先 192.168 段），服务只要绑定到该地址，手机就能直接用 `http://<地址>:<端口>/`——围栏本来就接受监听器自己的绑定地址，不需要任何可信条目。桌面版以 `--bind-lan` 启动，由 hub 自己绑定本机私网 IPv4 地址，页面直接给出可信链接与二维码。只监听回环的部署报 `not-bound` 并打印 `prism web --host <地址> --port <端口>`，不给链接——操作系统报告但监听器未绑定的地址会被扣下，因为指向无人监听端口的链接只会让手机得到连接超时。
- Tailscale：探测本机 CLI，回答手机现在能不能打开；它直接请求对外地址而不是从配置推断，因此围栏拒绝和代理缺失会读出不同结论；能打开时给出可复制的已登录链接——手机用其中的登录令牌换取会话 Cookie——打不开时列出还缺的步骤（`tailscale serve`，以及 profile 里把 ts.net 域加进 `trustedHosts`）。二维码内嵌的就是这条登录链接，请勿分享或截图。
- Cloudflare 隧道或任意稳定 HTTPS 域名：填入命名隧道对外提供的地址。页面报告 cloudflared 探测结果，打印 `cloudflared tunnel run <name>` 与首次连通性测试 `cloudflared tunnel --url http://127.0.0.1:<port>`，并打印该域名的 `trustedHosts` 条目；只有探测被应答且未被围栏拒绝时，地址才算就绪。内核信任策略只读不改。

**PWA 安装**：manifest、图标与 service worker 由插件自身路由提供，浏览器半在运行时注入标签，手机浏览器即可把 Prism 添加到主屏幕。

## 安装

桌面运行时自动携带本插件。源码 web profile 手动安装：

```sh
cd plugins/prism-pocket && node ../../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts
prism plugin --profile web add link:<absolute path to plugins/prism-pocket>
```

用 `link:` 安装时 profile 直接读取当前检出；只写路径会装入一份副本，而构建前生成的副本没有可导入的 `lib/`。

## 配置（`cordis.yml`）

```yaml
pocket:
  pushEnabled: true          # deliver push notifications at all
  notifyTurnComplete: true   # notify on clean turn completion, not just blocking asks
  barkUrl: https://api.day.app/<device-key>   # optional Bark relay
```

## 说明与限制

- webserver 设计上拒绝通配符绑定与未知 Host/Origin；设置分区会解释所选路径对应的确切命令。浏览器在非 localhost 源上要求 HTTPS 才能使用推送与 service worker，Tailscale `serve` 与命名隧道都提供它。
- 绑定局域网地址等于把整个应用暴露给该网段，唯一的门是链接里的登录令牌；手机用明文 `http` 打开时也拿不到 service worker、推送与主屏安装——这些需要 Tailscale 或隧道提供的 HTTPS。
- 插件从不启动、停止或配置 Tailscale 与隧道进程，也不读取隧道凭据；随机域名的临时隧道过不了围栏，页面存下的是命名隧道的稳定域名。
- iOS 主屏图标退化为截图（Safari 不支持 SVG 触摸图标）；PNG 图标是后续项。
- service worker 自持一份极小的中英文案表，因为它活在客户端上下文之外。
