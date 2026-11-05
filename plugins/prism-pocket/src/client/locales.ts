/**
 * Pocket copy. The plugin owns its namespace; the service worker keeps its
 * own minimal table because it lives outside the client context.
 *
 * @module @prism/prism-pocket/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'pocket.settings'

/** Every key the plugin's dictionaries define. */
export type PocketLocaleKey =
  | 'nav'
  | 'phone.title'
  | 'phone.ready'
  | 'phone.blocked.loopback'
  | 'phone.blocked.noTailscale'
  | 'phone.blocked.notServing'
  | 'phone.blocked.untrusted'
  | 'phone.copy'
  | 'phone.copied'
  | 'phone.qr'
  | 'phone.qr.unavailable'
  | 'phone.qr.credential'
  | 'phone.pairing'
  | 'phone.pairing.rotate'
  | 'phone.pairing.hint'
  | 'phone.steps'
  | 'step.serve'
  | 'step.trust'
  | 'step.trust.hint'
  | 'step.trust.cli'
  | 'bots.title'
  | 'bots.intro'
  | 'bots.tag.callback'
  | 'bots.configure'
  | 'bots.fold'
  | 'bots.save'
  | 'bots.saved'
  | 'bots.start'
  | 'bots.started'
  | 'bots.stop'
  | 'bots.stopped'
  | 'bots.test'
  | 'bots.tested'
  | 'bots.missing'
  | 'bots.console'
  | 'bots.callback'
  | 'bots.callback.hint'
  | 'bots.field.stored'
  | 'bots.field.placeholder'
  | 'status.off'
  | 'status.starting'
  | 'status.online'
  | 'status.error'
  | 'channel.telegram'
  | 'channel.discord'
  | 'channel.slack'
  | 'channel.feishu'
  | 'channel.dingtalk'
  | 'channel.qq'
  | 'channel.wecom'
  | 'channel.wechat'
  | 'channel.whatsapp'
  | 'field.botToken'
  | 'field.appToken'
  | 'field.appId'
  | 'field.appSecret'
  | 'field.region'
  | 'field.region.feishu'
  | 'field.region.lark'
  | 'field.clientId'
  | 'field.clientSecret'
  | 'field.corpId'
  | 'field.agentId'
  | 'field.corpSecret'
  | 'field.token'
  | 'field.encodingAesKey'
  | 'field.accessToken'
  | 'field.phoneNumberId'
  | 'field.verifyToken'
  | 'hint.telegram'
  | 'hint.discord'
  | 'hint.slack'
  | 'hint.feishu'
  | 'hint.dingtalk'
  | 'hint.qq'
  | 'hint.wecom'
  | 'hint.wechat'
  | 'hint.whatsapp'
  | 'push.title'
  | 'push.state.on'
  | 'push.state.off'
  | 'push.subscriptions'
  | 'push.subscribe'
  | 'push.subscribed'
  | 'push.denied'
  | 'push.unsupported'
  | 'push.test'
  | 'push.test.ok'
  | 'push.test.none'
  | 'push.bark.on'
  | 'push.bark.off'
  | 'pwa.title'
  | 'pwa.hint'
  | 'card.approval'
  | 'card.question'
  | 'card.error'
  | 'card.dismiss'

/** English copy. */
export const en: Record<PocketLocaleKey, string> = {
  nav: 'Pocket',
  'phone.title': 'Phone access',
  'phone.ready': 'Your phone can open this now',
  'phone.blocked.loopback': 'Your phone cannot reach this yet: the server listens on this machine only',
  'phone.blocked.noTailscale': 'No route off this machine: the server listens on loopback and Tailscale was not found',
  'phone.blocked.notServing': 'One step left: proxy this port to your tailnet',
  'phone.blocked.untrusted': 'One step left: let the server trust this address',
  'phone.copy': 'Copy link',
  'phone.copied': 'Copied',
  'phone.qr': 'Scan to open this workspace',
  'phone.qr.unavailable': 'No link to encode yet — resolve the blockers below first',
  'phone.qr.credential': 'The QR encodes this workspace\'s login link — anyone who scans it gets in. Do not share it or screenshot it.',
  'phone.pairing': 'Bot pairing code',
  'phone.pairing.rotate': 'New code',
  'phone.pairing.hint': 'Send /start <code> from your chat to bind the bot to you.',
  'phone.steps': 'Still needed',
  'step.serve': 'Proxy the port to Tailscale',
  'step.trust': 'Trust this address',
  'step.trust.hint': 'Add it to the profile cordis.patch.yml, then restart the app.',
  'step.trust.cli': 'Starting the server from the command line instead? Pass this flag:',
  'bots.title': 'Bot channels',
  'bots.intro': 'Connect a chat bot on any channel below; messages you send the bot drive this workspace, replies come back to the chat, and pending approvals or questions reach you as numbered choices.',
  'bots.tag.callback': 'callback',
  'bots.configure': 'Configure',
  'bots.fold': 'Collapse',
  'bots.save': 'Save',
  'bots.saved': 'Saved',
  'bots.start': 'Start',
  'bots.started': 'Started',
  'bots.stop': 'Stop',
  'bots.stopped': 'Stopped',
  'bots.test': 'Test',
  'bots.tested': 'Credentials verified',
  'bots.missing': 'Fill every field, or keep the stored ones empty.',
  'bots.console': 'Open the console',
  'bots.callback': 'Callback URL to register on the platform',
  'bots.callback.hint': 'The address must be reachable from the public internet — expose it with Tailscale Funnel or your own reverse proxy.',
  'bots.field.stored': 'stored',
  'bots.field.placeholder': 'Keep empty to keep the stored value',
  'status.off': 'Off',
  'status.starting': 'Connecting',
  'status.online': 'Online',
  'status.error': 'Error',
  'channel.telegram': 'Telegram',
  'channel.discord': 'Discord',
  'channel.slack': 'Slack',
  'channel.feishu': 'Feishu',
  'channel.dingtalk': 'DingTalk',
  'channel.qq': 'QQ',
  'channel.wecom': 'WeCom',
  'channel.wechat': 'WeChat',
  'channel.whatsapp': 'WhatsApp',
  'field.botToken': 'Bot token',
  'field.appToken': 'App-level token',
  'field.appId': 'App ID',
  'field.appSecret': 'App secret',
  'field.region': 'Region',
  'field.region.feishu': 'Feishu (China)',
  'field.region.lark': 'Lark (Global)',
  'field.clientId': 'Client ID',
  'field.clientSecret': 'Client secret',
  'field.corpId': 'Corp ID',
  'field.agentId': 'Agent ID',
  'field.corpSecret': 'Corp secret',
  'field.token': 'Callback token',
  'field.encodingAesKey': 'Encoding AES key',
  'field.accessToken': 'Access token',
  'field.phoneNumberId': 'Phone number ID',
  'field.verifyToken': 'Verify token',
  'hint.telegram': 'Create a bot with @BotFather and paste the token it returns.',
  'hint.discord': 'Create an application in the Developer Portal, enable the Message Content intent, and paste the bot token.',
  'hint.slack': 'Create a Slack app with Socket Mode and the Messages event enabled; paste the bot token (xoxb-) and the app-level token (xapp-).',
  'hint.feishu': 'Create a custom app on the open platform, enable the long connection and im:message scopes, and paste the App ID and App Secret.',
  'hint.dingtalk': 'Create an internal app robot on the open platform (Stream Mode) and paste the client ID and secret.',
  'hint.qq': 'Create a bot on q.qq.com, set up the sandbox, and paste the AppID and AppSecret.',
  'hint.wecom': 'Create a self-built app in the WeCom console, configure the message callback with the URL below, and fill every field.',
  'hint.wechat': 'Use an Official Account (or the sandbox test account) in encrypted mode with the callback URL below, and fill every field.',
  'hint.whatsapp': 'Create a Meta app with WhatsApp Cloud API, register the webhook below, and fill every field.',
  'push.title': 'Notifications',
  'push.state.on': 'Enabled',
  'push.state.off': 'Disabled',
  'push.subscriptions': '{n} subscribed device(s)',
  'push.subscribe': 'Enable on this device',
  'push.subscribed': 'This device is subscribed',
  'push.denied': 'Notifications are blocked in this browser',
  'push.unsupported': 'This browser does not support web push',
  'push.test': 'Send test notification',
  'push.test.ok': 'Delivered to {n} target(s)',
  'push.test.none': 'Nothing to deliver to yet',
  'push.bark.on': 'Bark relay configured',
  'push.bark.off': 'Bark relay not configured',
  'pwa.title': 'Install to home screen',
  'pwa.hint': 'Use your browser menu: "Add to Home Screen" installs the app.',
  'card.approval': 'Approval needed',
  'card.question': 'Prism asked a question',
  'card.error': 'Run failed',
  'card.dismiss': 'Dismiss',
}

/** Chinese copy. */
export const zh: Record<PocketLocaleKey, string> = {
  nav: '口袋',
  'phone.title': '手机访问',
  'phone.ready': '手机现在可以打开',
  'phone.blocked.loopback': '手机还连不上：服务只监听本机',
  'phone.blocked.noTailscale': '手机还连不上：服务只监听本机，也没检测到 Tailscale',
  'phone.blocked.notServing': '还差一步：把这个端口代理到 Tailscale',
  'phone.blocked.untrusted': '还差一步：让服务信任这个地址',
  'phone.copy': '复制链接',
  'phone.copied': '已复制',
  'phone.qr': '扫码直达这个工作区',
  'phone.qr.unavailable': '还没有可编码的链接——先解决下面的阻塞步骤',
  'phone.qr.credential': '二维码内嵌本工作区的登录链接，扫码即进入——请勿分享或截图。',
  'phone.pairing': 'Bot 配对码',
  'phone.pairing.rotate': '换一个',
  'phone.pairing.hint': '在你的聊天里发送 /start <配对码>，即可把 bot 绑定到你。',
  'phone.steps': '还需要做到',
  'step.serve': '把这个端口代理到 Tailscale',
  'step.trust': '信任这个地址',
  'step.trust.hint': '写进 profile 的 cordis.patch.yml 后重启应用。',
  'step.trust.cli': '如果是命令行启动的服务，改用这个参数：',
  'bots.title': 'Bot 渠道',
  'bots.intro': '在下面的任一渠道接入聊天机器人：你在聊天里发的消息会驱动这个工作区，回复直接回到聊天，待处理的审批和提问会以编号选项送达。',
  'bots.tag.callback': '回调',
  'bots.configure': '配置',
  'bots.fold': '收起',
  'bots.save': '保存',
  'bots.saved': '已保存',
  'bots.start': '启动',
  'bots.started': '已启动',
  'bots.stop': '停止',
  'bots.stopped': '已停止',
  'bots.test': '测试',
  'bots.tested': '凭据验证通过',
  'bots.missing': '每一项都要填写；已保存的项留空即保持原值。',
  'bots.console': '打开控制台',
  'bots.callback': '需在平台登记的回调地址',
  'bots.callback.hint': '该地址必须能被公网访问——用 Tailscale Funnel 或你自己的反向代理暴露。',
  'bots.field.stored': '已保存',
  'bots.field.placeholder': '留空保持已保存的值',
  'status.off': '未连接',
  'status.starting': '连接中',
  'status.online': '在线',
  'status.error': '出错',
  'channel.telegram': 'Telegram',
  'channel.discord': 'Discord',
  'channel.slack': 'Slack',
  'channel.feishu': '飞书',
  'channel.dingtalk': '钉钉',
  'channel.qq': 'QQ',
  'channel.wecom': '企业微信',
  'channel.wechat': '微信',
  'channel.whatsapp': 'WhatsApp',
  'field.botToken': 'Bot Token',
  'field.appToken': 'App-Level Token',
  'field.appId': 'App ID',
  'field.appSecret': 'App Secret',
  'field.region': '区域',
  'field.region.feishu': '飞书（中国）',
  'field.region.lark': 'Lark（全球）',
  'field.clientId': 'Client ID',
  'field.clientSecret': 'Client Secret',
  'field.corpId': '企业 ID',
  'field.agentId': 'AgentId',
  'field.corpSecret': '应用 Secret',
  'field.token': '回调 Token',
  'field.encodingAesKey': 'EncodingAESKey',
  'field.accessToken': 'Access Token',
  'field.phoneNumberId': '电话号码 ID',
  'field.verifyToken': 'Verify Token',
  'hint.telegram': '在 @BotFather 创建机器人，把它返回的 token 粘贴到下面。',
  'hint.discord': '在 Developer Portal 创建应用，开启 Message Content Intent，把 Bot Token 粘贴到下面。',
  'hint.slack': '创建 Slack 应用：启用 Socket Mode 与 Messages 事件，粘贴 Bot Token（xoxb-）与 App-Level Token（xapp-）。',
  'hint.feishu': '在开放平台创建企业自建应用，开通长连接与 im:message 权限，粘贴 App ID 与 App Secret。',
  'hint.dingtalk': '在开放平台创建企业内部应用机器人（Stream 模式），粘贴 Client ID 与 Client Secret。',
  'hint.qq': '在 q.qq.com 创建机器人，配置沙箱环境，粘贴 AppID 与 AppSecret。',
  'hint.wecom': '在企业微信后台创建自建应用，用下面的地址配置接收消息回调，并填齐全部字段。',
  'hint.wechat': '使用公众号（或测试号），消息加密设为安全模式，用下面的地址配置服务器，并填齐全部字段。',
  'hint.whatsapp': '在 Meta 开发者平台创建应用并接入 WhatsApp Cloud API，用下面的地址配置 Webhook，并填齐全部字段。',
  'push.title': '通知',
  'push.state.on': '已启用',
  'push.state.off': '未启用',
  'push.subscriptions': '已订阅 {n} 台设备',
  'push.subscribe': '在本设备启用',
  'push.subscribed': '本设备已订阅',
  'push.denied': '此浏览器已阻止通知',
  'push.unsupported': '此浏览器不支持 Web Push',
  'push.test': '发送测试通知',
  'push.test.ok': '已送达 {n} 个目标',
  'push.test.none': '还没有可投递的目标',
  'push.bark.on': '已配置 Bark 通道',
  'push.bark.off': '未配置 Bark 通道',
  'pwa.title': '安装到主屏幕',
  'pwa.hint': '在浏览器菜单选择「添加到主屏幕」即可安装。',
  'card.approval': '需要批准',
  'card.question': 'Prism 提问',
  'card.error': '运行失败',
  'card.dismiss': '知道了',
}
