/**
 * Bot store and validation: persistence round-trip, strict per-channel
 * validation, masked reads, and the revive rules for hand-edited files.
 *
 * @module @prism/prism-pocket/tests/bots
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BotStore } from '../../src/bots/store.ts'
import { readBotConfig, summarizeConfig, reviveBotConfig, BotConfigError } from '../../src/bots/validate.ts'
import { BOT_CHANNELS, botCallbackPath, type BotChannelId } from '../../src/bots/types.ts'

const DIRECTORIES: string[] = []

afterEach(() => {
  for (const directory of DIRECTORIES.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function tempStore(): { store: BotStore; file: string } {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-bots-'))
  DIRECTORIES.push(directory)
  const file = join(directory, 'bots.json')
  return { store: new BotStore(file), file }
}

describe('readBotConfig', () => {
  it('accepts a complete config and normalizes the channel discriminant', () => {
    const config = readBotConfig('telegram', { botToken: ' 123:abc ' })
    expect(config).toEqual({ channel: 'telegram', fields: { botToken: '123:abc' } })
  })

  it('rejects each missing field with the field named', () => {
    expect(() => readBotConfig('slack', { botToken: 'x' })).toThrow(BotConfigError)
    expect(() => readBotConfig('slack', { botToken: 'x', appToken: '' })).toThrow(/appToken/)
    expect(() => readBotConfig('feishu', { appId: 'a', appSecret: 's', region: 'weixin' })).toThrow(/region/)
    expect(() => readBotConfig('wecom', { corpId: 'c', agentId: '1', corpSecret: 's', token: 't' })).toThrow(/encodingAesKey/)
  })

  it('rejects non-object bodies', () => {
    expect(() => readBotConfig('qq', 'nope')).toThrow(BotConfigError)
  })

  it('validates every channel once round-tripped through its own reader', () => {
    const samples: Record<BotChannelId, unknown> = {
      telegram: { botToken: 't' },
      discord: { botToken: 'd' },
      slack: { botToken: 'b', appToken: 'a' },
      feishu: { appId: 'i', appSecret: 's', region: 'lark' },
      dingtalk: { clientId: 'c', clientSecret: 's' },
      qq: { appId: 'i', clientSecret: 's' },
      wecom: { corpId: 'c', agentId: '1', corpSecret: 's', token: 't', encodingAesKey: 'k'.repeat(43) },
      wechat: { appId: 'i', appSecret: 's', token: 't', encodingAesKey: 'k'.repeat(43) },
      whatsapp: { accessToken: 'a', phoneNumberId: '1', verifyToken: 'v', appSecret: 's' },
    }
    for (const channel of BOT_CHANNELS) {
      expect(readBotConfig(channel, samples[channel])?.channel).toBe(channel)
      expect(reviveBotConfig(channel, samples[channel])?.channel).toBe(channel)
    }
  })

  it('summarizes fields as set flags only, never values', () => {
    const config = readBotConfig('telegram', { botToken: 'super-secret' })
    expect(summarizeConfig(config)).toEqual([{ name: 'botToken', set: true }])
  })
})

describe('BotStore', () => {
  it('persists configs, the switch, and the binding with owner-only permissions', () => {
    const { store, file } = tempStore()
    const config = readBotConfig('telegram', { botToken: 't' })
    store.setConfig(config)
    expect(store.setEnabled('telegram', true)).toBe(true)
    store.bind('telegram', 'session-1', 'chat-1')
    expect(store.entry('telegram')).toMatchObject({ enabled: true, sessionId: 'session-1', chatId: 'chat-1' })
    // Windows does not carry POSIX file modes; the 0600 intent is asserted where it exists.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    const reread = new BotStore(file)
    expect(reread.entry('telegram')).toEqual(store.entry('telegram'))
  })

  it('keeps the binding through a config change and refuses to enable an unknown channel', () => {
    const { store } = tempStore()
    store.setConfig(readBotConfig('dingtalk', { clientId: 'c', clientSecret: 's' }))
    store.bind('dingtalk', 's1', 'c1')
    store.setConfig(readBotConfig('dingtalk', { clientId: 'c2', clientSecret: 's2' }))
    expect(store.entry('dingtalk')?.sessionId).toBe('s1')
    expect(store.setEnabled('telegram', true)).toBe(false)
  })

  it('drops entries that no longer validate on read', () => {
    const { store, file } = tempStore()
    store.setConfig(readBotConfig('qq', { appId: 'i', clientSecret: 's' }))
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.bots.qq.config.fields.clientSecret = ''
    writeRaw(file, raw)
    const reread = new BotStore(file)
    expect(reread.entry('qq')).toBeUndefined()
  })

  it('returns enabled channels in page order', () => {
    const { store } = tempStore()
    for (const channel of ['whatsapp', 'telegram'] as const) {
      store.setConfig(readBotConfig(channel, minimalConfig(channel)))
      store.setEnabled(channel, true)
    }
    expect(store.enabledChannels()).toEqual(['telegram', 'whatsapp'])
  })
})

describe('callback paths', () => {
  it('are origin-rooted and per-channel', () => {
    expect(botCallbackPath('wechat')).toBe('/pocket/bots/wechat/callback')
    expect(botCallbackPath('wecom')).toBe('/pocket/bots/wecom/callback')
    expect(botCallbackPath('whatsapp')).toBe('/pocket/bots/whatsapp/callback')
  })
})

/** Minimal valid fields per channel for store tests. */
function minimalConfig(channel: BotChannelId): unknown {
  const samples: Record<BotChannelId, unknown> = {
    telegram: { botToken: 't' },
    discord: { botToken: 'd' },
    slack: { botToken: 'b', appToken: 'a' },
    feishu: { appId: 'i', appSecret: 's', region: 'feishu' },
    dingtalk: { clientId: 'c', clientSecret: 's' },
    qq: { appId: 'i', clientSecret: 's' },
    wecom: { corpId: 'c', agentId: '1', corpSecret: 's', token: 't', encodingAesKey: 'k'.repeat(43) },
    wechat: { appId: 'i', appSecret: 's', token: 't', encodingAesKey: 'k'.repeat(43) },
    whatsapp: { accessToken: 'a', phoneNumberId: '1', verifyToken: 'v', appSecret: 's' },
  }
  return samples[channel]
}

/** Overwrite the store file with raw JSON, bypassing the store API. */
function writeRaw(file: string, body: unknown): void {
  writeFileSync(file, JSON.stringify(body), 'utf8')
}
