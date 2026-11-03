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
import { decodeLarkFrame, encodeLarkFrame } from '../../src/bots/shared/protobuf.ts'
import { callbackSignature, decryptWechatMessage, encryptWechatMessage, timestampFresh } from '../../src/bots/shared/sign.ts'
import { buildEncryptedReply, readXmlField } from '../../src/bots/shared/xml.ts'
import { nextTelegramOffset, readTelegramUpdate, telegramApiBase } from '../../src/bots/adapters/telegram.ts'
import { buildDiscordIdentify, parseDiscordFrame, readDiscordMessage } from '../../src/bots/adapters/discord.ts'
import { buildSlackAck, parseSlackEnvelope, readSlackMessage } from '../../src/bots/adapters/slack.ts'
import { buildLarkEndpointRequest, buildLarkPing, readLarkEventEnvelope, LarkChunkMerger } from '../../src/bots/adapters/feishu.ts'
import { buildDingtalkAck, buildDingtalkOpenRequest, parseDingtalkFrame, readDingtalkMessage } from '../../src/bots/adapters/dingtalk.ts'
import { buildQqIdentify, buildQqSendBody, qqSendUrl, readQqMessage } from '../../src/bots/adapters/qq.ts'
import { verifyWechatCallback, readWechatCallback, resolveWechatVerifyEcho } from '../../src/bots/adapters/wechat.ts'
import { verifyWecomCallback, readWecomCallback, resolveWecomVerifyEcho } from '../../src/bots/adapters/wecom.ts'
import { readWhatsappMessages, resolveWhatsappVerifyChallenge, verifyWhatsappSignature } from '../../src/bots/adapters/whatsapp.ts'
import type { WechatConfig, WecomConfig } from '../../src/bots/types.ts'

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
      message: { chat: { id: 42 }, from: { first_name: 'Chen' }, text: ' hello ' },
    })
    expect(update).toEqual({ updateId: 7, chatId: '42', senderName: 'Chen', text: 'hello' })
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
    const message = readDiscordMessage({ content: ' hi ', channel_id: 'c1', author: { username: 'u' } })
    expect(message).toEqual({ chatId: 'c1', senderName: 'u', text: 'hi' })
    expect(readDiscordMessage({ content: 'x', channel_id: 'c1', author: { bot: true } })).toBeUndefined()
  })
})

describe('slack', () => {
  it('parses envelopes, acks them, and filters bot and edit events', () => {
    const envelope = parseSlackEnvelope('{"type":"events_api","envelope_id":"e1","payload":{"event":{"type":"message","channel":"C1","text":"hi"}}}')
    expect(envelope?.envelopeId).toBe('e1')
    expect(buildSlackAck('e1')).toBe('{"envelope_id":"e1"}')
    expect(readSlackMessage(envelope?.payload)).toEqual({ chatId: 'C1', senderName: undefined, text: 'hi' })
    expect(readSlackMessage({ event: { type: 'message', channel: 'C1', text: 'x', bot_id: 'B1' } })).toBeUndefined()
    expect(readSlackMessage({ event: { type: 'message', channel: 'C1', text: 'x', subtype: 'message_changed' } })).toBeUndefined()
  })
})

describe('lark frames', () => {
  it('round-trips the protobuf frame', () => {
    const payload = new TextEncoder().encode('{"hello":"world"}')
    const wire = encodeLarkFrame({
      seqId: 5, logId: 9, service: 3, method: 1,
      headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'm1' }],
      payload,
    })
    const decoded = decodeLarkFrame(wire)
    expect(decoded).toMatchObject({ seqId: 5, logId: 9, service: 3, method: 1 })
    expect(Object.fromEntries(decoded?.headers.map(header => [header.key, header.value]) ?? [])).toMatchObject({ type: 'event', message_id: 'm1' })
    expect(new TextDecoder().decode(decoded?.payload)).toBe('{"hello":"world"}')
  })

  it('builds the ping control frame and the endpoint request', () => {
    expect(decodeLarkFrame(buildLarkPing(2))?.headers).toEqual([{ key: 'type', value: 'ping' }])
    expect(buildLarkEndpointRequest('cli', 'sec', 'https://open.feishu.cn')).toMatchObject({
      url: 'https://open.feishu.cn/callback/ws/endpoint',
      body: '{"AppID":"cli","AppSecret":"sec"}',
    })
  })

  it('merges fragmented event payloads in order', () => {
    const merger = new LarkChunkMerger()
    const first = new TextEncoder().encode('{"he')
    const second = new TextEncoder().encode('llo":1}')
    expect(merger.merge('m1', 0, 2, first)).toBeUndefined()
    expect(merger.merge('m1', 1, 2, second)).toBe('{"hello":1}')
  })

  it('narrows im.message.receive_v1 text and strips the group mention', () => {
    const event = {
      header: { event_type: 'im.message.receive_v1' },
      event: { message: { chat_id: 'oc1', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: '@Bot hi' }) } },
    }
    expect(readLarkEventEnvelope(event)).toMatchObject({ chatId: 'oc1', text: 'hi' })
    expect(readLarkEventEnvelope({ header: { event_type: 'other' } })).toBeUndefined()
    expect(readLarkEventEnvelope({
      header: { event_type: 'im.message.receive_v1' },
      event: { message: { chat_id: 'oc1', message_type: 'image', content: '{}' } },
    })).toBeUndefined()
  })
})

describe('dingtalk', () => {
  it('acks every frame with its messageId and routes robot messages', () => {
    const frame = defined(parseDingtalkFrame(JSON.stringify({
      type: 'CALLBACK',
      headers: { messageId: 'mid', contentType: 'application/json', topic: '/v1.0/im/bot/messages/get' },
      data: JSON.stringify({ conversationId: 'cid', text: { content: ' hello ' }, senderNick: 'C', sessionWebhook: 'https://w' }),
    })))
    expect(buildDingtalkAck(frame)).toContain('"messageId":"mid"')
    expect(readDingtalkMessage(JSON.parse(frame?.data ?? '{}'))).toEqual({
      chatId: 'cid', senderName: 'C', text: 'hello', webhook: 'https://w',
    })
    expect(buildDingtalkOpenRequest('c', 's')).toMatchObject({
      clientId: 'c',
      subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }],
    })
  })
})

describe('qq', () => {
  it('identifies with the QQBot prefix and the C2C intents bit', () => {
    expect(JSON.parse(buildQqIdentify('tok'))).toMatchObject({ op: 2, d: { token: 'QQBot tok', intents: 1 << 25 } })
  })

  it('narrows C2C and group messages and builds passive send bodies', () => {
    const c2c = readQqMessage('C2C_MESSAGE_CREATE', { id: 'm1', content: ' hi ', author: { user_openid: 'U1' } })
    expect(c2c).toEqual({ chatId: 'U1', text: 'hi', msgId: 'm1', group: false })
    const group = readQqMessage('GROUP_AT_MESSAGE_CREATE', { id: 'm2', content: 'yo', author: { member_openid: 'M1' } })
    expect(group).toMatchObject({ chatId: 'M1', group: true })
    expect(readQqMessage('OTHER', { content: 'x', author: { user_openid: 'U' } })).toBeUndefined()
    expect(buildQqSendBody('hi', 'm1', 2)).toEqual({ msg_type: 0, content: 'hi', msg_id: 'm1', msg_seq: 2 })
    expect(qqSendUrl('M1', true)).toContain('/v2/groups/M1/messages')
    expect(qqSendUrl('U1', false)).toContain('/v2/users/U1/messages')
  })
})

describe('wechat family crypto', () => {
  const wechat: WechatConfig = { appId: 'wx-app', appSecret: 's', token: 'tok', encodingAesKey: AES_KEY }
  const wecom: WecomConfig = { corpId: 'corp', agentId: '1', corpSecret: 's', token: 'tok', encodingAesKey: AES_KEY }

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
    const encrypt = defined(encryptWechatMessage(AES_KEY, '<xml/>', 'corp'))
    const fourPart = callbackSignature('tok', '111', 'nonce', encrypt)
    expect(verifyWecomCallback('tok', fourPart, '111', 'nonce', encrypt)).toBe(true)
    expect(verifyWecomCallback('tok', signature, '111', 'nonce', encrypt)).toBe(false)
  })

  it('decrypts callback bodies and refuses foreign receive ids', () => {
    const body = buildEncryptedReply(
      defined(encryptWechatMessage(AES_KEY, wechatBody('openid-1', 'wx-app', 'hello'), 'wx-app')),
      'sig', '111', 'n1',
    )
    const encrypt = defined(readXmlField(body, 'Encrypt'))
    const message = readWechatCallback(wechat, body)
    expect(message).toMatchObject({ from: 'openid-1', msgType: 'text', content: 'hello' })
    expect(encrypt).toBeDefined()
    expect(readWechatCallback({ ...wechat, appId: 'other' }, body)).toBeUndefined()

    const wecomXml = wechatBody('userid-1', 'corp', 'ping')
    const wecomEncrypt = defined(encryptWechatMessage(AES_KEY, wecomXml, 'corp'))
    expect(readWecomCallback(wecom, wecomEncrypt)).toEqual({ from: 'userid-1', content: 'ping' })
    expect(readWecomCallback(wecom, defined(encryptWechatMessage(AES_KEY, wecomXml, 'elsewhere')))).toBeUndefined()
  })

  it('resolves the verification echoes: plaintext or decryptable cipher', () => {
    expect(resolveWechatVerifyEcho(wechat, 'plain-echo')).toBe('plain-echo')
    const cipherEcho = defined(encryptWechatMessage(AES_KEY, 'secret-echo', 'wx-app'))
    expect(resolveWechatVerifyEcho(wechat, cipherEcho)).toBe('secret-echo')
    expect(resolveWecomVerifyEcho(wecom, defined(encryptWechatMessage(AES_KEY, 'wecom-echo', 'corp')))).toBe('wecom-echo')
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
        messages: [{ from: '15551234567', text: { body: ' hello ' } }],
        statuses: [{ status: 'delivered' }],
      } }] }],
    }
    expect(readWhatsappMessages(body)).toEqual([{ from: '15551234567', text: 'hello' }])
    expect(readWhatsappMessages({ entry: [] })).toEqual([])
  })
})

/** A minimal WeChat-family text callback XML. */
function wechatBody(from: string, to: string, content: string): string {
  return `<xml><ToUserName><![CDATA[${to}]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName><CreateTime>111</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content></xml>`
}
