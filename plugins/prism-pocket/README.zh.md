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

- 「口袋」设置分区探测本机 Tailscale，只回答一个问题：手机现在能不能打开？它直接请求对外地址而不是从配置推断，因此围栏拒绝和代理缺失会读出不同结论；能打开时给出可复制的已登录链接——手机用其中的登录令牌换取会话 Cookie——打不开时列出还缺的步骤：用 `tailscale serve` 代理本机端口，以及在 profile 里把 ts.net 域加进 `trustedHosts`。内核信任策略只读不改。

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

- webserver 设计上拒绝通配符绑定与未知 Host/Origin；设置分区会解释所选路径对应的确切命令。浏览器在非 localhost 源上要求 HTTPS 才能使用推送与 service worker，Tailscale `serve` 恰好提供它。
- iOS 主屏图标退化为截图（Safari 不支持 SVG 触摸图标）；PNG 图标是后续项。
- service worker 自持一份极小的中英文案表，因为它活在客户端上下文之外。
