# @prism/prism-pocket

[English](README.md) | 中文

口袋里的 Prism：把 Web 表面变成手机可用的远程查看台，并且让 agent 能主动叫你回来。

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

**Tailscale 远程访问**：

- 「口袋」设置分区探测本机 Tailscale（MagicDNS 域名 + 100.x 地址），报告服务器绑定面，校验当前连接是否通过信任围栏，并给出可复制的命令：直接绑定 Tailscale IP（`--host`），或经 `tailscale serve` 反代并信任 ts.net 域名（`--trusted-host`、`--public-url`）。内核信任策略只读不改。

**PWA 安装**：manifest、图标与 service worker 由插件自身路由提供，浏览器半在运行时注入标签，手机浏览器即可把 Prism 添加到主屏幕。

## 安装

桌面运行时自动携带本插件。源码 web profile 手动安装：

```sh
pnpm --filter @prism/prism-pocket... build   # or: cd plugins/prism-pocket && pnpm build
prism plugin --profile web add <absolute path to plugins/prism-pocket>
```

## 配置（`cordis.yml`）

```yaml
pocket:
  pushEnabled: true          # deliver push notifications at all
  notifyTurnComplete: true   # notify on clean turn completion, not just blocking asks
  barkUrl: https://api.day.app/<device-key>   # optional Bark relay
```

## 说明与限制

- webserver 设计上拒绝通配符绑定与未知 Host/Origin；设置分区会解释所选路径对应的确切命令。浏览器在非 localhost 源上要求 HTTPS 才能使用推送与 service worker，Tailscale `serve` 恰好提供它。
- iOS 主屏图标退化为截图（Safari 不支持 SVG 触摸图标）；PNG 图标是后续项。
- service worker 自持一份极小的中英文案表，因为它活在客户端上下文之外。
