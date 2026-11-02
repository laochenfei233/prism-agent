/**
 * WeChat Official-Account adapter: receive rides the encrypted callback
 * route, replies go through the customer-service send API. The signature
 * check, envelope decrypt, and callback verification are pure and tested;
 * the adapter carries the access-token cache.
 *
 * @module @prism/prism-pocket/bots/adapters
 */

import type { BotAdapterFactory, WechatConfig } from '../types.ts'
import { chunkText } from '../shared/chunk.ts'
import { fetchBotJson, postBotJson } from '../shared/http.ts'
import { callbackSignature, decryptWechatMessage, encryptWechatMessage } from '../shared/sign.ts'
import { buildEncryptedReply, readXmlField } from '../shared/xml.ts'

/** Per-message character limit of the customer-service text message. */
export const WECHAT_MESSAGE_LIMIT = 2000

/** Base URL of the Official Account API. */
export const WECHAT_API_BASE = 'https://api.weixin.qq.com'

/**
 * Verify one callback request's signature.
 * @param token - the console-configured callback token.
 * @param signature - the request's `signature` query parameter.
 * @param timestamp - the request's `timestamp` query parameter.
 * @param nonce - the request's `nonce` query parameter.
 * @returns whether the signature matches.
 */
export function verifyWechatCallback(token: string, signature: string, timestamp: string, nonce: string): boolean {
  return callbackSignature(token, timestamp, nonce) === signature
}

/** One decrypted callback message, narrowed to the fields the adapter reads. */
export interface WechatCallbackMessage {
  readonly from: string
  readonly to: string
  readonly msgType: string
  readonly content?: string
}

/**
 * Decrypt and narrow one callback body; non-text messages decrypt to a
 * message with no content.
 * @param config - the channel credentials.
 * @param xml - the raw callback body.
 * @returns the message view, or undefined when verification fails.
 */
export function readWechatCallback(config: WechatConfig, xml: string): WechatCallbackMessage | undefined {
  const encrypt = readXmlField(xml, 'Encrypt')
  if (encrypt === undefined) return undefined
  const appId = config.appId
  const plaintext = decryptWechatMessage(config.encodingAesKey, encrypt, appId)
  if (plaintext === undefined) return undefined
  const from = readXmlField(plaintext, 'FromUserName')
  const to = readXmlField(plaintext, 'ToUserName')
  const msgType = readXmlField(plaintext, 'MsgType')
  if (from === undefined || to === undefined || msgType === undefined) return undefined
  const content = readXmlField(plaintext, 'Content')
  return { from, to, msgType, ...(content !== undefined ? { content } : {}) }
}

/**
 * Resolve the URL-verification echo: plaintext in plain mode, a decryption in
 * encrypted mode.
 * @param config - the channel credentials.
 * @param echoStr - the request's `echostr` query parameter.
 * @returns the string the platform expects back, or undefined when neither reading applies.
 */
export function resolveWechatVerifyEcho(config: WechatConfig, echoStr: string): string | undefined {
  return decryptWechatMessage(config.encodingAesKey, echoStr, config.appId) ?? echoStr
}

/** Build one passive encrypted text reply (unused for the async flow, kept for completeness). */
export function buildWechatPassiveReply(config: WechatConfig, from: string, text: string, timestamp: string, nonce: string): string | undefined {
  const xml = [
    '<xml>',
    `<ToUserName><![CDATA[${from}]]></ToUserName>`,
    `<FromUserName><![CDATA[${config.appId}]]></FromUserName>`,
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`,
    '<MsgType><![CDATA[text]]></MsgType>',
    `<Content><![CDATA[${text.replace(/\]\]>/gu, ']]&gt;')}]]></Content>`,
    '</xml>',
  ].join('')
  const encrypt = encryptWechatMessage(config.encodingAesKey, xml, config.appId)
  if (encrypt === undefined) return undefined
  return buildEncryptedReply(encrypt, callbackSignature(config.token, timestamp, nonce, encrypt), timestamp, nonce)
}

/** The adapter: access-token cache plus the customer-service send. */
export const createWechatAdapter: BotAdapterFactory = (config, hooks) => {
  const fields = config as WechatConfig
  let accessToken: { token: string; expiresAt: number } | undefined

  const token = async (): Promise<string> => {
    if (accessToken !== undefined && Date.now() < accessToken.expiresAt) return accessToken.token
    const url = `${WECHAT_API_BASE}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(fields.appId)}&secret=${encodeURIComponent(fields.appSecret)}`
    const body = await fetchBotJson(url)
    const value = (body as { access_token?: unknown }).access_token
    if (typeof value !== 'string') throw new Error(`token request failed: ${JSON.stringify(body)}`)
    const expires = (body as { expires_in?: unknown }).expires_in
    accessToken = { token: value, expiresAt: Date.now() + (typeof expires === 'number' ? expires - 60 : 7200) * 1000 }
    return value
  }

  return {
    async start() {
      hooks.onStatus('starting')
      await token()
      // Callback channels are online once their credentials verify; the route delivers inbound messages.
      hooks.onStatus('online')
    },
    async stop() {
      accessToken = undefined
    },
    async send(chatId, text) {
      const credential = await token()
      for (const piece of chunkText(text, WECHAT_MESSAGE_LIMIT)) {
        await postBotJson(`${WECHAT_API_BASE}/cgi-bin/message/custom/send?access_token=${encodeURIComponent(credential)}`, {
          touser: chatId,
          msgtype: 'text',
          text: { content: piece },
        })
      }
    },
    async probe() {
      await token()
    },
  }
}
