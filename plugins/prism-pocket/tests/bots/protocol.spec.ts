/**
 * Channel protocol logic: every pure function the adapters and callback
 * routes lean on — frame parse/build, signatures, the WeChat-family AES
 * envelope, chunking, and the inbound filters. No network.
 *
 * @module @prism/prism-pocket/tests/bots
 */

import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { chunkText } from '../../src/bots/shared/chunk.ts'
import { DEDUP_CAPACITY, DEDUP_TTL_MS, InboundDedup } from '../../src/bots/shared/dedup.ts'
import { callbackSignature, decryptWechatMessage, encryptWechatMessage, timestampFresh, timingSafeStringEquals } from '../../src/bots/shared/sign.ts'
import { buildEncryptedReply, readXmlField } from '../../src/bots/shared/xml.ts'
import { nextTelegramOffset, readTelegramUpdate, telegramApiBase } from '../../src/bots/adapters/telegram.ts'
import { buildDiscordIdentify, parseDiscordFrame, readDiscordMessage } from '../../src/bots/adapters/discord.ts'
import { buildSlackAck, parseSlackEnvelope, readSlackMessage } from '../../src/bots/adapters/slack.ts'
import { buildQqIdentify, buildQqSendBody, qqSendUrl, readQqMessage } from '../../src/bots/adapters/qq.ts'
import { verifyWechatCallback, readWechatCallback, resolveWechatVerifyEcho } from '../../src/bots/adapters/wechat.ts'
import { readWhatsappMessages, resolveWhatsappVerifyChallenge, verifyWhatsappSignature } from '../../src/bots/adapters/whatsapp.ts'
import type { WechatConfig } from '../../src/bots/types.ts'

const AES_KEY = 'a'.repeat(43)

/** Unwrap an optional the test cannot proceed without. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value in the test')
  return value
}

describe('chunkText', () => {
  it('keeps short text whole and splits long text at a paragraph boundary', () => {
    expect(chunkText('short', 100)).toEqual(['short'])
    const long = `${'a'.repeat(600)}\n\n${'b'.repeat(600)}`
    const chunks = chunkText(long, 700)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.endsWith('a')).toBe(true)
    expect(chunks[1]?.startsWith('b')).toBe(true)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(700)
  })

  it('hard-splits when no boundary fits', () => {
    const chunks = chunkText('x'.repeat(250), 100)
    expect(chunks.map(chunk => chunk.length)).toEqual([100, 100, 50])
  })
})

describe('timestampFresh', () => {
  it('accepts a fresh timestamp and refuses a stale or malformed one', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(timestampFresh(String(now))).toBe(true)
    expect(timestampFresh(String(now - 4000))).toBe(false)
    expect(timestampFresh('soon-ish')).toBe(false)
  })
})

describe('telegram', () => {
  it('narrows text updates and skips bots and non-text', () => {
    const update = readTelegramUpdate({
      update_id: 7,
      message: { chat: { id: 42 }, message_id: 900, from: { id: 99, first_name: 'Chen' }, text: ' hello ' },
    })
    expect(update).toEqual({ updateId: 7, chatId: '42', senderId: '99', messageId: '900', senderName: 'Chen', text: 'hello' })
    expect(readTelegramUpdate({ update_id: 8, message: { chat: { id: 1 }, from: { is_bot: true }, text: 'x' } })).toBeUndefined()
    expect(readTelegramUpdate({ update_id: 9, message: { chat: { id: 1 } } })).toBeUndefined()
  })

  it('advances the offset past the last update', () => {
    const update = defined(readTelegramUpdate({ update_id: 1, message: { chat: { id: 1 }, text: 'a' } }))
    expect(nextTelegramOffset([update])).toBe(2)
    expect(nextTelegramOffset([])).toBeUndefined()
  })

  it('encodes the token into the API base', () => {
    expect(telegramApiBase('123:a/b')).toBe('https://api.telegram.org/bot123%3Aa%2Fb')
  })
})

describe('discord', () => {
  it('parses frames, builds identify, and filters bot messages', () => {
    expect(parseDiscordFrame('{"op":10,"d":{"heartbeat_interval":45000},"s":3}'))
      .toEqual({ op: 10, s: 3, data: { heartbeat_interval: 45000 } })
    expect(parseDiscordFrame('not json')).toBeUndefined()
    expect(JSON.parse(buildDiscordIdentify('tok'))).toMatchObject({ op: 2, d: { token: 'tok', intents: (1 << 9) | (1 << 12) | (1 << 15) } })
    const message = readDiscordMessage({ content: ' hi ', channel_id: 'c1', id: 'm1', author: { id: 'u1', username: 'u' } })
    expect(message).toEqual({ chatId: 'c1', senderId: 'u1', messageId: 'm1', senderName: 'u', text: 'hi' })
    expect(readDiscordMessage({ content: 'x', channel_id: 'c1', author: { bot: true } })).toBeUndefined()
  })
})

describe('slack', () => {
  it('parses envelopes, acks them, and filters bot and edit events', () => {
    const envelope = parseSlackEnvelope('{"type":"events_api","envelope_id":"e1","payload":{"event":{"type":"message","channel":"C1","user":"U1","ts":"1710000000.000100","text":"hi"}}}')
    expect(envelope?.envelopeId).toBe('e1')
    expect(buildSlackAck('e1')).toBe('{"envelope_id":"e1"}')
    expect(readSlackMessage(envelope?.payload)).toEqual({
      chatId: 'C1', senderId: 'U1', messageId: '1710000000.000100', senderName: 'U1', text: 'hi',
    })
    expect(readSlackMessage({ event: { type: 'message', channel: 'C1', text: 'x', bot_id: 'B1' } })).toBeUndefined()
    expect(readSlackMessage({ event: { type: 'message', channel: 'C1', text: 'x', subtype: 'message_changed' } })).toBeUndefined()
  })
})

describe('qq', () => {
  it('identifies with the QQBot prefix and the C2C intents bit', () => {
    expect(JSON.parse(buildQqIdentify('tok'))).toMatchObject({ op: 2, d: { token: 'QQBot tok', intents: 1 << 25 } })
  })

  it('narrows C2C and group messages and builds passive send bodies', () => {
    const c2c = readQqMessage('C2C_MESSAGE_CREATE', { id: 'm1', content: ' hi ', author: { user_openid: 'U1' } })
    expect(c2c).toEqual({ chatId: 'U1', senderId: 'U1', text: 'hi', msgId: 'm1', group: false })
    const group = readQqMessage('GROUP_AT_MESSAGE_CREATE', { id: 'm2', content: 'yo', author: { member_openid: 'M1' } })
    expect(group).toMatchObject({ chatId: 'M1', senderId: 'M1', group: true })
    expect(readQqMessage('OTHER', { content: 'x', author: { user_openid: 'U' } })).toBeUndefined()
    expect(buildQqSendBody('hi', 'm1', 2)).toEqual({ msg_type: 0, content: 'hi', msg_id: 'm1', msg_seq: 2 })
    expect(qqSendUrl('M1', true)).toContain('/v2/groups/M1/messages')
    expect(qqSendUrl('U1', false)).toContain('/v2/users/U1/messages')
  })
})

describe('wechat family crypto', () => {
  const wechat: WechatConfig = { appId: 'wx-app', appSecret: 's', token: 'tok', encodingAesKey: AES_KEY }

  it('round-trips the AES envelope and pins the receive id', () => {
    const cipher = defined(encryptWechatMessage(AES_KEY, '<xml>hello</xml>', 'wx-app'))
    expect(decryptWechatMessage(AES_KEY, cipher, 'wx-app')).toBe('<xml>hello</xml>')
    expect(decryptWechatMessage(AES_KEY, cipher, 'other-app')).toBeUndefined()
    expect(decryptWechatMessage('short-key', cipher, 'wx-app')).toBeUndefined()
  })

  it('verifies the callback signatures', () => {
    const signature = callbackSignature('tok', '111', 'nonce')
    expect(verifyWechatCallback('tok', signature, '111', 'nonce')).toBe(true)
    expect(verifyWechatCallback('tok', 'deadbeef', '111', 'nonce')).toBe(false)
  })

  it('decrypts callback bodies and refuses foreign receive ids', () => {
    const body = buildEncryptedReply(
      defined(encryptWechatMessage(AES_KEY, wechatBody('openid-1', 'wx-app', 'hello'), 'wx-app')),
      'sig', '111', 'n1',
    )
    const encrypt = defined(readXmlField(body, 'Encrypt'))
    const message = readWechatCallback(wechat, body)
    expect(message).toMatchObject({ from: 'openid-1', msgType: 'text', content: 'hello', msgId: '9001' })
    expect(encrypt).toBeDefined()
    expect(readWechatCallback({ ...wechat, appId: 'other' }, body)).toBeUndefined()
  })

  it('resolves the verification echoes: plaintext or decryptable cipher', () => {
    expect(resolveWechatVerifyEcho(wechat, 'plain-echo')).toBe('plain-echo')
    const cipherEcho = defined(encryptWechatMessage(AES_KEY, 'secret-echo', 'wx-app'))
    expect(resolveWechatVerifyEcho(wechat, cipherEcho)).toBe('secret-echo')
  })
})

describe('whatsapp', () => {
  it('verifies the HMAC signature over the raw body', () => {
    const body = '{"entry":[]}'
    const hmac = `sha256=${createHmac('sha256', 'secret').update(body, 'utf8').digest('hex')}`
    expect(verifyWhatsappSignature('secret', body, hmac)).toBe(true)
    expect(verifyWhatsappSignature('wrong', body, hmac)).toBe(false)
    expect(verifyWhatsappSignature('secret', body, 'sha256=deadbeef')).toBe(false)
    expect(verifyWhatsappSignature('secret', body, 'not-a-signature')).toBe(false)
  })

  it('echoes the challenge only on a matching verify token', () => {
    const query = { 'hub.mode': 'subscribe', 'hub.verify_token': 'v', 'hub.challenge': 'ch' }
    expect(resolveWhatsappVerifyChallenge(query, 'v')).toBe('ch')
    expect(resolveWhatsappVerifyChallenge(query, 'other')).toBeUndefined()
  })

  it('narrows text messages and skips statuses', () => {
    const body = {
      entry: [{ changes: [{ value: {
        messages: [{ from: '15551234567', id: 'wamid.1', text: { body: ' hello ' } }],
        statuses: [{ status: 'delivered' }],
      } }] }],
    }
    expect(readWhatsappMessages(body)).toEqual([{ from: '15551234567', id: 'wamid.1', text: 'hello' }])
    expect(readWhatsappMessages({ entry: [] })).toEqual([])
  })
})

describe('timingSafeStringEquals', () => {
  it('accepts equal strings and rejects different or differently sized ones', () => {
    expect(timingSafeStringEquals('abc', 'abc')).toBe(true)
    expect(timingSafeStringEquals('abc', 'abd')).toBe(false)
    expect(timingSafeStringEquals('abc', 'abcd')).toBe(false)
    expect(timingSafeStringEquals('', '')).toBe(true)
    expect(timingSafeStringEquals('a', '')).toBe(false)
  })
})

describe('InboundDedup', () => {
  it('drops a replayed key inside the window and admits it again after the TTL', () => {
    const dedup = new InboundDedup()
    const t0 = 1_000_000
    expect(dedup.first('wechat:m1', t0)).toBe(true)
    expect(dedup.first('wechat:m1', t0 + 1)).toBe(false)
    expect(dedup.first('wechat:m1', t0 + DEDUP_TTL_MS - 1)).toBe(false)
    expect(dedup.first('wechat:m1', t0 + DEDUP_TTL_MS)).toBe(true)
    expect(dedup.first('wechat:m2', t0)).toBe(true)
  })

  it('stays bounded at the capacity, evicting the oldest', () => {
    const dedup = new InboundDedup()
    for (let index = 0; index < DEDUP_CAPACITY; index += 1) expect(dedup.first(`c:m${index}`, 1000)).toBe(true)
    expect(dedup.first('c:new', 1000)).toBe(true)
    expect(dedup.first('c:m1', 1000)).toBe(false)
    expect(dedup.first('c:m0', 1000)).toBe(true)
  })
})

/** A minimal WeChat-family text callback XML. */
function wechatBody(from: string, to: string, content: string): string {
  return `<xml><ToUserName><![CDATA[${to}]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName><CreateTime>111</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>9001</MsgId></xml>`
}
