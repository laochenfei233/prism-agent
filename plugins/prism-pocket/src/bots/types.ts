/**
 * Bot channel contracts shared by the adapters, the supervisor, the store,
 * and the routes. The channel id is the discriminant for every union here.
 *
 * @module @prism/prism-pocket/bots
 */

/** Every bot channel Prism Pocket can connect. */
export type BotChannelId =
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'feishu'
  | 'dingtalk'
  | 'qq'
  | 'wecom'
  | 'wechat'
  | 'whatsapp'

/** Every channel id, in page order. */
export const BOT_CHANNELS: readonly BotChannelId[] = [
  'telegram', 'discord', 'slack', 'feishu', 'dingtalk', 'qq', 'wecom', 'wechat', 'whatsapp',
]

/** How a channel reaches the agent: outbound connection or public callback. */
export type BotChannelKind = 'outbound' | 'callback'

/** The connection kind of every channel; callback channels need a public URL. */
export const BOT_CHANNEL_KINDS: Readonly<Record<BotChannelId, BotChannelKind>> = {
  telegram: 'outbound',
  discord: 'outbound',
  slack: 'outbound',
  feishu: 'outbound',
  dingtalk: 'outbound',
  qq: 'outbound',
  wecom: 'callback',
  wechat: 'callback',
  whatsapp: 'callback',
}

/** Telegram credential: the BotFather token. */
export interface TelegramConfig { readonly botToken: string }

/** Discord credential: the application bot token. */
export interface DiscordConfig { readonly botToken: string }

/** Slack credentials: the bot token plus the Socket Mode app token. */
export interface SlackConfig { readonly botToken: string; readonly appToken: string }

/** Feishu/Lark credentials; the region selects the open-platform host. */
export interface FeishuConfig { readonly appId: string; readonly appSecret: string; readonly region: 'feishu' | 'lark' }

/** DingTalk credentials: the Stream Mode client pair. */
export interface DingtalkConfig { readonly clientId: string; readonly clientSecret: string }

/** QQ open-platform credentials: the app pair from q.qq.com. */
export interface QqConfig { readonly appId: string; readonly clientSecret: string }

/**
 * WeCom (企业微信) credentials for a self-built app: the callback pair that
 * verifies and decrypts deliveries plus the app identity that answers.
 */
export interface WecomConfig {
  readonly corpId: string
  readonly agentId: string
  readonly corpSecret: string
  readonly token: string
  readonly encodingAesKey: string
}

/**
 * WeChat Official-Account (公众号或测试号) credentials: the callback pair plus
 * the app pair that mints access tokens for the customer-service send API.
 */
export interface WechatConfig {
  readonly appId: string
  readonly appSecret: string
  readonly token: string
  readonly encodingAesKey: string
}

/** WhatsApp Cloud API credentials. */
export interface WhatsappConfig {
  readonly accessToken: string
  readonly phoneNumberId: string
  readonly verifyToken: string
  readonly appSecret: string
}

/** The config shape of one channel. */
export type BotConfig =
  | { readonly channel: 'telegram'; readonly fields: TelegramConfig }
  | { readonly channel: 'discord'; readonly fields: DiscordConfig }
  | { readonly channel: 'slack'; readonly fields: SlackConfig }
  | { readonly channel: 'feishu'; readonly fields: FeishuConfig }
  | { readonly channel: 'dingtalk'; readonly fields: DingtalkConfig }
  | { readonly channel: 'qq'; readonly fields: QqConfig }
  | { readonly channel: 'wecom'; readonly fields: WecomConfig }
  | { readonly channel: 'wechat'; readonly fields: WechatConfig }
  | { readonly channel: 'whatsapp'; readonly fields: WhatsappConfig }

/** Names of the secret fields per channel; these are never echoed as values — the route masks every field, and reports only whether a value is stored. */
export const BOT_SECRET_FIELDS: Readonly<Record<BotChannelId, readonly string[]>> = {
  telegram: ['botToken'],
  discord: ['botToken'],
  slack: ['botToken', 'appToken'],
  feishu: ['appSecret'],
  dingtalk: ['clientSecret'],
  qq: ['clientSecret'],
  wecom: ['corpSecret', 'encodingAesKey'],
  wechat: ['appSecret', 'encodingAesKey'],
  whatsapp: ['accessToken', 'appSecret'],
}

/** Connection state of one channel, as the page renders it. */
export type BotStatus = 'off' | 'starting' | 'online' | 'error'

/** One persisted bot entry: credentials, the switch, and the session binding. */
export interface BotEntry {
  readonly config: BotConfig
  readonly enabled: boolean
  /** The bound session, when one has been created. */
  readonly sessionId?: string
  /** The chat the session is bound to, when a chat earned the binding. */
  readonly chatId?: string
}

/** The `pocket/bots.json` body. */
export interface BotStoreBody {
  readonly version: 1
  readonly bots: Partial<Record<BotChannelId, BotEntry>>
}

/** One inbound chat message, normalized across channels. */
export interface BotInbound {
  /** Platform chat identity, stable per conversation. */
  readonly chatId: string
  /** Display name of the sender, when the platform carries one. */
  readonly senderName?: string
  /** The message text, trimmed and non-empty. */
  readonly text: string
}

/** Adapter-facing hooks the supervisor installs. */
export interface BotAdapterHooks {
  /** An inbound chat message arrived. */
  onInbound(message: BotInbound): void
  /** The connection state changed. */
  onStatus(status: BotStatus, detail?: string): void
}

/** One running channel connection. */
export interface BotHandle {
  /** Open the connection; resolves online or throws the failure detail. */
  start(): Promise<void>
  /** Close the connection and stop every timer. */
  stop(): Promise<void>
  /**
   * Deliver one text message to one chat, chunking it to the platform's
   * per-message limit.
   * @param chatId - the platform chat identity from an inbound message.
   * @param text - the text to deliver.
   */
  send(chatId: string, text: string): Promise<void>
  /** Probe the credentials without sending; rejects with the failure detail. */
  probe(): Promise<void>
}

/** Adapter factory contract every channel module exports. */
export type BotAdapterFactory = (config: BotConfig['fields'], hooks: BotAdapterHooks) => BotHandle

/** The callback path of one channel on the webserver (origin root, unauthenticated). */
export function botCallbackPath(channel: BotChannelId): string {
  return `/pocket/bots/${channel}/callback`
}
