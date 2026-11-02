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
  | 'phone.steps'
  | 'step.serve'
  | 'step.trust'
  | 'step.trust.hint'
  | 'step.trust.cli'
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
  'phone.copy': 'Copy phone link',
  'phone.copied': 'Copied',
  'phone.steps': 'Still needed',
  'step.serve': 'Proxy the port to Tailscale',
  'step.trust': 'Trust this address',
  'step.trust.hint': 'Add it to the profile cordis.patch.yml, then restart the app.',
  'step.trust.cli': 'Starting the server from the command line instead? Pass this flag:',
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
  'phone.copy': '复制手机链接',
  'phone.copied': '已复制',
  'phone.steps': '还需要做到',
  'step.serve': '把这个端口代理到 Tailscale',
  'step.trust': '信任这个地址',
  'step.trust.hint': '写进 profile 的 cordis.patch.yml 后重启应用。',
  'step.trust.cli': '如果是命令行启动的服务，改用这个参数：',
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
