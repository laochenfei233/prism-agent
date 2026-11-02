/**
 * Per-channel presentation metadata for the page: field layout, brand chip,
 * and the setup hint. Presentation only — the wire contract lives in
 * `../bots/types.ts`, and the server never sees these values.
 *
 * @module @prism/prism-pocket/client/channel-meta
 */

import type { PocketLocaleKey } from './locales.ts'

/** One credential field the card renders. */
export interface BotFieldMeta {
  /** The wire field name; also the label locale key suffix. */
  readonly name: string
  /** Render as a secret (password) input. */
  readonly secret?: boolean
  /** Render as the region picker (飞书 / Lark). */
  readonly region?: boolean
}

/** Presentation metadata of one channel. */
export interface BotChannelMeta {
  readonly id: string
  /** The channel name locale key. */
  readonly label: PocketLocaleKey
  /** The chip's brand color; decorative only. */
  readonly color: string
  /** The chip's monogram, one or two glyphs. */
  readonly chip: string
  /** The credential fields, in form order. */
  readonly fields: readonly BotFieldMeta[]
  /** The setup hint locale key. */
  readonly hint: PocketLocaleKey
  /** The console where credentials are minted. */
  readonly consoleUrl?: string
  /** The callback channels carry a public callback path. */
  readonly callback?: boolean
}

/** The nine channels, in page order. */
export const CHANNEL_META: readonly BotChannelMeta[] = [
  {
    id: 'telegram',
    label: 'channel.telegram',
    color: '#229ED9',
    chip: 'T',
    fields: [{ name: 'botToken', secret: true }],
    hint: 'hint.telegram',
    consoleUrl: 'https://t.me/BotFather',
  },
  {
    id: 'discord',
    label: 'channel.discord',
    color: '#5865F2',
    chip: 'D',
    fields: [{ name: 'botToken', secret: true }],
    hint: 'hint.discord',
    consoleUrl: 'https://discord.com/developers/applications',
  },
  {
    id: 'slack',
    label: 'channel.slack',
    color: '#4A154B',
    chip: 'S',
    fields: [{ name: 'botToken', secret: true }, { name: 'appToken', secret: true }],
    hint: 'hint.slack',
    consoleUrl: 'https://api.slack.com/apps',
  },
  {
    id: 'feishu',
    label: 'channel.feishu',
    color: '#3370FF',
    chip: '飞',
    fields: [{ name: 'appId' }, { name: 'appSecret', secret: true }, { name: 'region', region: true }],
    hint: 'hint.feishu',
    consoleUrl: 'https://open.feishu.cn/app',
  },
  {
    id: 'dingtalk',
    label: 'channel.dingtalk',
    color: '#0089FF',
    chip: '钉',
    fields: [{ name: 'clientId' }, { name: 'clientSecret', secret: true }],
    hint: 'hint.dingtalk',
    consoleUrl: 'https://open-dev.dingtalk.com/feapp',
  },
  {
    id: 'qq',
    label: 'channel.qq',
    color: '#12B7F5',
    chip: 'Q',
    fields: [{ name: 'appId' }, { name: 'clientSecret', secret: true }],
    hint: 'hint.qq',
    consoleUrl: 'https://q.qq.com',
  },
  {
    id: 'wecom',
    label: 'channel.wecom',
    color: '#0082EF',
    chip: '企',
    fields: [
      { name: 'corpId' }, { name: 'agentId' }, { name: 'corpSecret', secret: true },
      { name: 'token' }, { name: 'encodingAesKey', secret: true },
    ],
    hint: 'hint.wecom',
    consoleUrl: 'https://work.weixin.qq.com',
    callback: true,
  },
  {
    id: 'wechat',
    label: 'channel.wechat',
    color: '#07C160',
    chip: '微',
    fields: [
      { name: 'appId' }, { name: 'appSecret', secret: true },
      { name: 'token' }, { name: 'encodingAesKey', secret: true },
    ],
    hint: 'hint.wechat',
    consoleUrl: 'https://mp.weixin.qq.com/debug/cgi-bin/sandbox?t=sandbox/login',
    callback: true,
  },
  {
    id: 'whatsapp',
    label: 'channel.whatsapp',
    color: '#25D366',
    chip: 'W',
    fields: [
      { name: 'accessToken', secret: true }, { name: 'phoneNumberId' },
      { name: 'verifyToken', secret: true }, { name: 'appSecret', secret: true },
    ],
    hint: 'hint.whatsapp',
    consoleUrl: 'https://developers.facebook.com/apps',
    callback: true,
  },
]
