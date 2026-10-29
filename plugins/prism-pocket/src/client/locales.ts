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
  | 'remote.title'
  | 'remote.trusted'
  | 'remote.untrusted'
  | 'remote.server'
  | 'remote.publicUrl'
  | 'remote.tailscale.available'
  | 'remote.tailscale.unavailable'
  | 'remote.commands.title'
  | 'remote.commands.directIp'
  | 'remote.commands.serve'
  | 'remote.commands.trustedHost'
  | 'remote.commands.publicUrl'
  | 'remote.commands.copy'
  | 'remote.commands.copied'
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
  | 'card.dismiss'

/** English copy. */
export const en: Record<PocketLocaleKey, string> = {
  nav: 'Pocket',
  'remote.title': 'Remote access',
  'remote.trusted': 'This connection is trusted',
  'remote.untrusted': 'This connection does not match the trust fence',
  'remote.server': 'Server',
  'remote.publicUrl': 'Public URL',
  'remote.tailscale.available': 'Tailscale',
  'remote.tailscale.unavailable': 'Tailscale was not detected on this machine',
  'remote.commands.title': 'Open the server to your phone',
  'remote.commands.directIp': 'Direct Tailscale IP',
  'remote.commands.serve': 'Serve over MagicDNS',
  'remote.commands.trustedHost': 'Trust the ts.net domain',
  'remote.commands.publicUrl': 'Advertise the public URL',
  'remote.commands.copy': 'Copy',
  'remote.commands.copied': 'Copied',
  'push.title': 'Push notifications',
  'push.state.on': 'Enabled',
  'push.state.off': 'Disabled',
  'push.subscriptions': '{n} subscribed browser(s)',
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
  'card.dismiss': 'Dismiss',
}

/** Chinese copy. */
export const zh: Record<PocketLocaleKey, string> = {
  nav: '口袋',
  'remote.title': '远程访问',
  'remote.trusted': '当前连接已受信任',
  'remote.untrusted': '当前连接未通过信任围栏',
  'remote.server': '服务器',
  'remote.publicUrl': '公网 URL',
  'remote.tailscale.available': 'Tailscale',
  'remote.tailscale.unavailable': '未在这台机器上检测到 Tailscale',
  'remote.commands.title': '把服务器开放给手机',
  'remote.commands.directIp': 'Tailscale IP 直连',
  'remote.commands.serve': '通过 MagicDNS 反代',
  'remote.commands.trustedHost': '信任 ts.net 域名',
  'remote.commands.publicUrl': '对外公布 URL',
  'remote.commands.copy': '复制',
  'remote.commands.copied': '已复制',
  'push.title': '推送通知',
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
  'card.dismiss': '知道了',
}
