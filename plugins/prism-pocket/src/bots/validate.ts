/**
 * Strict per-channel config readers for the PUT route and the persisted
 * store. A field is present and non-empty or the config is rejected with the
 * offending field named; unknown fields are dropped.
 *
 * @module @prism/prism-pocket/bots
 */

import type {
  BotChannelId,
  BotConfig,
  DingtalkConfig,
  DiscordConfig,
  FeishuConfig,
  QqConfig,
  SlackConfig,
  TelegramConfig,
  WecomConfig,
  WechatConfig,
  WhatsappConfig,
} from './types.ts'

/** The rejection error: names the channel and the offending field. */
export class BotConfigError extends Error {
  /**
   * @param channel - the channel whose config was rejected.
   * @param field - the offending field name.
   */
  constructor(channel: BotChannelId, field: string) {
    super(`bots: ${channel} config field "${field}" is missing or malformed`)
    this.name = 'BotConfigError'
  }
}

/** Read one required non-empty string field. */
function required(channel: BotChannelId, source: Record<string, unknown>, field: string): string {
  const value = source[field]
  if (typeof value !== 'string' || value.trim().length === 0) throw new BotConfigError(channel, field)
  return value.trim()
}

/** Read one string field that must be one of the listed values. */
function oneOf<T extends string>(channel: BotChannelId, source: Record<string, unknown>, field: string, values: readonly T[]): T {
  const value = source[field]
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new BotConfigError(channel, `${field} (expected one of: ${values.join(', ')})`)
  }
  return value as T
}

/** Validate a wire value into one channel's config, rejecting the first bad field. */
export function readBotConfig(channel: BotChannelId, value: unknown): BotConfig {
  const source: Record<string, unknown> = typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
  switch (channel) {
    case 'telegram': {
      const fields: TelegramConfig = { botToken: required(channel, source, 'botToken') }
      return { channel, fields }
    }
    case 'discord': {
      const fields: DiscordConfig = { botToken: required(channel, source, 'botToken') }
      return { channel, fields }
    }
    case 'slack': {
      const fields: SlackConfig = { botToken: required(channel, source, 'botToken'), appToken: required(channel, source, 'appToken') }
      return { channel, fields }
    }
    case 'feishu': {
      const fields: FeishuConfig = {
        appId: required(channel, source, 'appId'),
        appSecret: required(channel, source, 'appSecret'),
        region: oneOf(channel, source, 'region', ['feishu', 'lark']),
      }
      return { channel, fields }
    }
    case 'dingtalk': {
      const fields: DingtalkConfig = { clientId: required(channel, source, 'clientId'), clientSecret: required(channel, source, 'clientSecret') }
      return { channel, fields }
    }
    case 'qq': {
      const fields: QqConfig = { appId: required(channel, source, 'appId'), clientSecret: required(channel, source, 'clientSecret') }
      return { channel, fields }
    }
    case 'wecom': {
      const fields: WecomConfig = {
        corpId: required(channel, source, 'corpId'),
        agentId: required(channel, source, 'agentId'),
        corpSecret: required(channel, source, 'corpSecret'),
        token: required(channel, source, 'token'),
        encodingAesKey: required(channel, source, 'encodingAesKey'),
      }
      return { channel, fields }
    }
    case 'wechat': {
      const fields: WechatConfig = {
        appId: required(channel, source, 'appId'),
        appSecret: required(channel, source, 'appSecret'),
        token: required(channel, source, 'token'),
        encodingAesKey: required(channel, source, 'encodingAesKey'),
      }
      return { channel, fields }
    }
    case 'whatsapp': {
      const fields: WhatsappConfig = {
        accessToken: required(channel, source, 'accessToken'),
        phoneNumberId: required(channel, source, 'phoneNumberId'),
        verifyToken: required(channel, source, 'verifyToken'),
        appSecret: required(channel, source, 'appSecret'),
      }
      return { channel, fields }
    }
  }
}

/**
 * Merge a posted config over the stored one, then validate strictly. Fields
 * the post omits or leaves empty keep the stored value — the card promises
 * that a stored secret survives an edit that leaves it blank.
 * @param channel - the channel the config belongs to.
 * @param posted - the request body's `config` value.
 * @param stored - the stored fields to fall back to.
 * @returns the merged, strictly validated config.
 */
export function mergeBotConfig(channel: BotChannelId, posted: unknown, stored: BotConfig): BotConfig {
  const base: Record<string, unknown> = { ...stored.fields }
  const incoming = typeof posted === 'object' && posted !== null ? posted as Record<string, unknown> : {}
  for (const [name, value] of Object.entries(incoming)) {
    if (typeof value === 'string' && value.trim().length > 0) base[name] = value.trim()
  }
  return readBotConfig(channel, base)
}

/**
 * Re-validate a persisted config with the same strictness as the route; a
 * store body edited by hand that fails validation reads as no config.
 * @param channel - the channel the entry belongs to.
 * @param value - the persisted value.
 * @returns the config, or undefined when it no longer validates.
 */
export function reviveBotConfig(channel: BotChannelId, value: unknown): BotConfig | undefined {
  try {
    return readBotConfig(channel, value)
  } catch {
    return undefined
  }
}

/** One masked view field: whether a field is set. */
export interface BotFieldSummary {
  readonly name: string
  readonly set: boolean
}

/**
 * Mask a config into per-field set/unset pairs; secret and plain fields both
 * report only their presence, so no route response ever carries a value.
 * @param config - the config to summarize.
 * @returns one summary per field, in field order.
 */
export function summarizeConfig(config: BotConfig): readonly BotFieldSummary[] {
  const fields: Record<string, string> = { ...config.fields }
  return Object.keys(fields).map(name => ({ name, set: (fields[name] ?? '').length > 0 }))
}
