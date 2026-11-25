/**
 * The adapter registry: one factory per channel, keyed by channel id.
 *
 * @module @prism/prism-pocket/bots/adapters
 */

import type { BotAdapterFactory, BotChannelId } from '../types.ts'
import { createDiscordAdapter } from './discord.ts'
import { createQqAdapter } from './qq.ts'
import { createSlackAdapter } from './slack.ts'
import { createTelegramAdapter } from './telegram.ts'
import { createWechatAdapter } from './wechat.ts'
import { createWhatsappAdapter } from './whatsapp.ts'

/** Every channel's factory, in no meaningful order. */
export const BOT_ADAPTERS: Readonly<Record<BotChannelId, BotAdapterFactory>> = {
  telegram: createTelegramAdapter,
  discord: createDiscordAdapter,
  slack: createSlackAdapter,
  qq: createQqAdapter,
  wechat: createWechatAdapter,
  whatsapp: createWhatsappAdapter,
}
